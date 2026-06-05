import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs/promises';
import { PNG } from 'pngjs';
import { PrismaService } from '../prisma/prisma.service';
import { RunStorageService } from '../storage/run-storage.service';
import { ArtifactsService } from './artifacts.service';

// pixelmatch v7 is ESM-only; use require() + interop since dynamic import()
// hangs in Jest's VM sandbox.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const _pm = require('pixelmatch');
const pixelmatch: (
  img1: Buffer | Uint8Array,
  img2: Buffer | Uint8Array,
  output: Buffer | Uint8Array | null,
  width: number,
  height: number,
  options?: { threshold?: number },
) => number = _pm.default ?? _pm;

export type VisualMatchVerdict = 'pass' | 'fail' | 'no-baseline';

interface VisualMatchSubStep {
  stepIndex: number;
  subStepIndex: number;
  name: string;
  threshold?: number;
  hasIgnoreRegions: boolean;
}

interface BoundsRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A visualMatch outcome that warrants downgrading the test verdict. */
export interface VisualMatchFailure {
  name: string;
  verdict: 'fail' | 'no-baseline';
  message: string;
}

/** Summary returned by processInstance — used by the test-validation flow. */
export interface VisualMatchSummary {
  failures: VisualMatchFailure[];
}

/**
 * Post-run visualMatch diff job. Runs after the test run completes; walks the
 * resolved definition to find visualMatch sub-steps, looks up each sub-step's
 * capture artifact (uploaded by test-agent during the run), loads the matching
 * baseline from the instance's baselines/ directory, runs pixelmatch, and
 * writes a verdict back to the capture row. On a failed diff, also persists
 * a diff PNG as a separate artifact via the standard artifact pipeline.
 *
 * Captures with no corresponding baseline file are marked verdict='no-baseline'
 * so the user can review them via `dokkimi baselines pending` and approve.
 */
@Injectable()
export class VisualMatchService {
  private readonly logger = new Logger(VisualMatchService.name);

  // Default fraction of pixels allowed to differ before failing. Mirrors the
  // documented default in UI_TEST_ARTIFACT_PIPELINE.md.
  private static readonly DEFAULT_THRESHOLD = 0.01;

  // pixelmatch sensitivity (per-pixel comparison strictness, NOT the same as
  // the user-facing threshold which counts differing pixels). 0.1 is the
  // pixelmatch lib's recommended default for screenshot diffs.
  private static readonly PIXEL_SENSITIVITY = 0.1;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: RunStorageService,
    private readonly artifacts: ArtifactsService,
  ) {}

  async processInstance(instanceId: string): Promise<VisualMatchSummary> {
    const failures: VisualMatchFailure[] = [];
    let definition: Record<string, unknown>;
    try {
      definition = await this.storage.readDefinition(instanceId);
    } catch {
      // No definition stored (test never reached the persistence step). Nothing
      // to diff. Don't fail the run-completion path on this.
      return { failures };
    }

    const visualMatches = this.findVisualMatchSubSteps(definition);
    if (visualMatches.length === 0) {
      return { failures };
    }

    this.logger.log(
      `Processing ${visualMatches.length} visualMatch sub-step(s) for instance=${instanceId}`,
    );

    for (const vm of visualMatches) {
      try {
        const verdict = await this.processOne(instanceId, vm);
        if (verdict === 'no-baseline') {
          failures.push({
            name: vm.name,
            verdict,
            message: `no baseline for "${vm.name}" — run \`dokkimi baselines approve ${vm.name}\` (or \`--all\`) after reviewing the capture`,
          });
        } else if (verdict === 'fail') {
          failures.push({
            name: vm.name,
            verdict,
            message: `visual diff exceeded threshold for "${vm.name}" — review diff/${vm.name}.png and either fix the regression or \`dokkimi baselines approve ${vm.name}\` to accept the new look`,
          });
        }
      } catch (err) {
        this.logger.error(
          `visualMatch diff failed for instance=${instanceId} name=${vm.name}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        // Diff infrastructure errors aren't visualMatch verdicts — don't
        // pollute the failures list with internal hiccups, but do log loudly.
      }
    }
    return { failures };
  }

  /**
   * Walks the resolved test definition and returns every screenshot sub-step
   * with a `match` block attached, paired with its position. Position
   * addressing matches what test-agent emits when uploading the capture.
   *
   * Screenshots without a `match` block are pure evidence captures — no diff
   * needed, so we skip them.
   */
  private findVisualMatchSubSteps(
    definition: Record<string, unknown>,
  ): VisualMatchSubStep[] {
    const out: VisualMatchSubStep[] = [];
    const tests = (definition.tests as unknown[]) ?? [];
    let globalStepIndex = 0;
    for (const test of tests) {
      const t = test as { steps?: unknown[] };
      if (!Array.isArray(t.steps)) {
        continue;
      }
      for (let si = 0; si < t.steps.length; si++) {
        const step = t.steps[si] as {
          action?: { type?: string; steps?: unknown[] };
        };
        if (step?.action?.type !== 'ui' || !Array.isArray(step.action.steps)) {
          globalStepIndex++;
          continue;
        }
        for (let subI = 0; subI < step.action.steps.length; subI++) {
          const sub = step.action.steps[subI] as { screenshot?: unknown };
          if (
            !sub?.screenshot ||
            typeof sub.screenshot !== 'object' ||
            Array.isArray(sub.screenshot)
          ) {
            continue;
          }
          const ss = sub.screenshot as {
            name?: unknown;
            match?: unknown;
          };
          const matchEnabled =
            ss.match === true ||
            (typeof ss.match === 'object' &&
              ss.match !== null &&
              !Array.isArray(ss.match));
          if (!matchEnabled) {
            continue;
          }
          if (typeof ss.name !== 'string' || ss.name.length === 0) {
            continue;
          }
          const matchObj =
            typeof ss.match === 'object' && ss.match !== null
              ? (ss.match as {
                  threshold?: unknown;
                  ignoreRegions?: unknown;
                })
              : null;
          const threshold =
            matchObj && typeof matchObj.threshold === 'number'
              ? matchObj.threshold
              : undefined;
          const hasIgnoreRegions =
            !!matchObj &&
            Array.isArray(matchObj.ignoreRegions) &&
            matchObj.ignoreRegions.length > 0;
          out.push({
            stepIndex: globalStepIndex,
            subStepIndex: subI,
            name: ss.name,
            threshold,
            hasIgnoreRegions,
          });
        }
        globalStepIndex++;
      }
    }
    return out;
  }

  private async processOne(
    instanceId: string,
    vm: VisualMatchSubStep,
  ): Promise<VisualMatchVerdict | null> {
    const capture = await this.prisma.artifact.findFirst({
      where: {
        instanceId,
        stepIndex: vm.stepIndex,
        subStepIndex: vm.subStepIndex,
        type: 'screenshot',
        name: vm.name,
      },
    });
    if (!capture) {
      this.logger.warn(
        `No capture artifact found for visualMatch instance=${instanceId} ` +
          `pos=${vm.stepIndex}.${vm.subStepIndex} name=${vm.name}`,
      );
      return null;
    }

    const hasBaseline = await this.storage.hasBaseline(instanceId, vm.name);
    if (!hasBaseline) {
      await this.setVerdict(capture.id, 'no-baseline');
      this.logger.log(
        `visualMatch ${vm.name}: no baseline (awaiting approval)`,
      );
      return 'no-baseline';
    }

    const baselinePath = await this.storage.baselinePath(instanceId, vm.name);
    const captureAbsPath = this.storage.absoluteUri(capture.uri);

    const verdict = await this.runDiff(
      instanceId,
      vm,
      baselinePath,
      captureAbsPath,
    );
    await this.setVerdict(capture.id, verdict);
    this.logger.log(`visualMatch ${vm.name}: ${verdict}`);
    return verdict;
  }

  private async runDiff(
    instanceId: string,
    vm: VisualMatchSubStep,
    baselinePath: string,
    captureAbsPath: string,
  ): Promise<VisualMatchVerdict> {
    const [baselineBuf, captureBuf] = await Promise.all([
      fs.readFile(baselinePath),
      fs.readFile(captureAbsPath),
    ]);
    const baseline = PNG.sync.read(baselineBuf);
    const capture = PNG.sync.read(captureBuf);

    // Size mismatch always fails — pixelmatch needs identical dimensions.
    // Persist a small text-style diff marker by reusing the capture as the
    // diff so the user sees what they got. Counts as a fail.
    if (
      baseline.width !== capture.width ||
      baseline.height !== capture.height
    ) {
      await this.persistDiffArtifact(instanceId, vm, captureBuf);
      return 'fail';
    }

    if (vm.hasIgnoreRegions) {
      const boundsPath = captureAbsPath.replace(/\.png$/, '.bounds.json');
      try {
        const raw = await fs.readFile(boundsPath, 'utf-8');
        const bounds: BoundsRect[] = JSON.parse(raw);
        for (const b of bounds) {
          this.maskRegion(baseline, b);
          this.maskRegion(capture, b);
        }
      } catch {
        this.logger.warn(
          `ignoreRegions: bounds file not found for ${vm.name}, diffing without masks`,
        );
      }
    }

    const diff = new PNG({ width: baseline.width, height: baseline.height });
    const numDifferent = pixelmatch(
      baseline.data,
      capture.data,
      diff.data,
      baseline.width,
      baseline.height,
      { threshold: VisualMatchService.PIXEL_SENSITIVITY },
    );
    const totalPixels = baseline.width * baseline.height;
    const fractionDifferent =
      totalPixels === 0 ? 0 : numDifferent / totalPixels;
    const userThreshold = vm.threshold ?? VisualMatchService.DEFAULT_THRESHOLD;

    if (fractionDifferent <= userThreshold) {
      return 'pass';
    }

    const diffBuf = PNG.sync.write(diff);
    await this.persistDiffArtifact(instanceId, vm, diffBuf);
    return 'fail';
  }

  private maskRegion(img: PNG, bounds: BoundsRect): void {
    const x0 = Math.max(0, Math.floor(bounds.x));
    const y0 = Math.max(0, Math.floor(bounds.y));
    const x1 = Math.min(img.width, Math.ceil(bounds.x + bounds.width));
    const y1 = Math.min(img.height, Math.ceil(bounds.y + bounds.height));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const idx = (y * img.width + x) << 2;
        img.data[idx] = 0;
        img.data[idx + 1] = 0;
        img.data[idx + 2] = 0;
        img.data[idx + 3] = 255;
      }
    }
  }

  private async persistDiffArtifact(
    instanceId: string,
    vm: VisualMatchSubStep,
    payload: Buffer,
  ): Promise<void> {
    await this.artifacts.persist(
      {
        instanceId,
        stepIndex: vm.stepIndex,
        subStepIndex: vm.subStepIndex,
        type: 'diff',
        name: vm.name,
      },
      payload,
    );
  }

  private async setVerdict(
    artifactId: string,
    verdict: VisualMatchVerdict,
  ): Promise<void> {
    await this.prisma.artifact.update({
      where: { id: artifactId },
      data: { verdict },
    });
  }
}
