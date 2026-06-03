import { Test, TestingModule } from '@nestjs/testing';
import { PNG } from 'pngjs';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { VisualMatchService } from './visual-match.service';
import { ArtifactsService } from './artifacts.service';
import { PrismaService } from '../prisma/prisma.service';
import { RunStorageService } from '../storage/run-storage.service';
import { runDirPath } from '@dokkimi/config';

/**
 * Generates a solid-color PNG buffer with the given dimensions and RGBA color.
 * Used to construct controlled baseline / capture inputs for the diff path.
 */
function makePng(
  width: number,
  height: number,
  color: [number, number, number, number],
): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) << 2;
      png.data[i] = color[0];
      png.data[i + 1] = color[1];
      png.data[i + 2] = color[2];
      png.data[i + 3] = color[3];
    }
  }
  return PNG.sync.write(png);
}

describe('VisualMatchService.processInstance', () => {
  let service: VisualMatchService;
  let workDir: string;

  const mockArtifactFindFirst = jest.fn();
  const mockArtifactUpdate = jest.fn();
  const mockArtifactsPersist = jest.fn();

  const mockPrisma = {
    artifact: {
      findFirst: mockArtifactFindFirst,
      update: mockArtifactUpdate,
    },
  };
  const mockArtifactsService = { persist: mockArtifactsPersist };

  // Real RunStorageService with a temp dir so absoluteUri / hasBaseline /
  // baselinePath / readDefinition behave like production.
  const instanceId = 'inst-vm-test';
  const testCreatedAt = new Date('2026-06-03T12:00:00Z');

  function instanceDir(): string {
    return path.join(
      runDirPath(workDir, testCreatedAt),
      'snapshots',
      'vm-definition',
    );
  }

  async function writeBaseline(name: string, png: Buffer): Promise<void> {
    const dir = path.join(instanceDir(), 'baselines');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${name}.png`), png);
  }

  async function writeCapture(uri: string, png: Buffer): Promise<void> {
    await fs.mkdir(path.dirname(uri), { recursive: true });
    await fs.writeFile(uri, png);
  }

  async function writeDefinition(def: object): Promise<void> {
    const dir = instanceDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'definition.json'),
      JSON.stringify(def, null, 2),
    );
  }

  function captureUriForName(name: string): string {
    return path.join(instanceDir(), 'artifacts', 'screenshot', `${name}.png`);
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vm-spec-'));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VisualMatchService,
        { provide: PrismaService, useValue: mockPrisma },
        {
          provide: RunStorageService,
          useFactory: () => {
            const svc = new RunStorageService();
            svc.registerInstance(
              instanceId,
              workDir,
              testCreatedAt,
              'vm-definition',
            );
            return svc;
          },
        },
        { provide: ArtifactsService, useValue: mockArtifactsService },
      ],
    }).compile();

    service = module.get<VisualMatchService>(VisualMatchService);
  });

  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  function definitionWithVisualMatch(name: string, threshold?: number): object {
    // Unified screenshot primitive: presence of `match` is what enables
    // the post-run diff. Threshold is nested under match, not a sibling.
    const match: Record<string, unknown> = {};
    if (threshold !== undefined) {
      match.threshold = threshold;
    }
    return {
      tests: [
        {
          name: 'vm-test',
          steps: [
            {
              action: {
                type: 'ui',
                target: 'svc',
                steps: [{ screenshot: { name, match } }],
              },
            },
          ],
        },
      ],
    };
  }

  it('marks verdict=pass when capture matches baseline within threshold', async () => {
    await writeDefinition(definitionWithVisualMatch('homepage'));
    const png = makePng(20, 20, [255, 0, 0, 255]);
    await writeBaseline('homepage', png);
    const captureUri = captureUriForName('homepage');
    await writeCapture(captureUri, png);

    mockArtifactFindFirst.mockResolvedValue({
      id: 'art-1',
      uri: captureUri,
      name: 'homepage',
    });

    await service.processInstance(instanceId);

    expect(mockArtifactUpdate).toHaveBeenCalledWith({
      where: { id: 'art-1' },
      data: { verdict: 'pass' },
    });
    expect(mockArtifactsPersist).not.toHaveBeenCalled();
  });

  it('marks verdict=no-baseline when no baseline file exists', async () => {
    await writeDefinition(definitionWithVisualMatch('newpage'));
    const captureUri = captureUriForName('newpage');
    await writeCapture(captureUri, makePng(10, 10, [0, 0, 255, 255]));

    mockArtifactFindFirst.mockResolvedValue({
      id: 'art-2',
      uri: captureUri,
      name: 'newpage',
    });

    await service.processInstance(instanceId);

    expect(mockArtifactUpdate).toHaveBeenCalledWith({
      where: { id: 'art-2' },
      data: { verdict: 'no-baseline' },
    });
    expect(mockArtifactsPersist).not.toHaveBeenCalled();
  });

  it('marks verdict=fail and persists a diff artifact when pixels differ above threshold', async () => {
    await writeDefinition(definitionWithVisualMatch('changed', 0.01));
    const baseline = makePng(10, 10, [255, 0, 0, 255]);
    const capture = makePng(10, 10, [0, 255, 0, 255]); // 100% different
    await writeBaseline('changed', baseline);
    const captureUri = captureUriForName('changed');
    await writeCapture(captureUri, capture);

    mockArtifactFindFirst.mockResolvedValue({
      id: 'art-3',
      uri: captureUri,
      name: 'changed',
    });

    await service.processInstance(instanceId);

    expect(mockArtifactsPersist).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId,
        type: 'diff',
        name: 'changed',
        stepIndex: 0,
        subStepIndex: 0,
      }),
      expect.any(Buffer),
    );
    expect(mockArtifactUpdate).toHaveBeenCalledWith({
      where: { id: 'art-3' },
      data: { verdict: 'fail' },
    });
  });

  it('treats size mismatch as fail (different dimensions)', async () => {
    await writeDefinition(definitionWithVisualMatch('resized'));
    await writeBaseline('resized', makePng(10, 10, [255, 0, 0, 255]));
    const captureUri = captureUriForName('resized');
    await writeCapture(captureUri, makePng(20, 20, [255, 0, 0, 255]));

    mockArtifactFindFirst.mockResolvedValue({
      id: 'art-4',
      uri: captureUri,
      name: 'resized',
    });

    await service.processInstance(instanceId);

    expect(mockArtifactUpdate).toHaveBeenCalledWith({
      where: { id: 'art-4' },
      data: { verdict: 'fail' },
    });
    expect(mockArtifactsPersist).toHaveBeenCalled();
  });

  it('honors a per-visualMatch threshold override', async () => {
    // Generate a baseline + capture that differ in ~10% of pixels.
    const W = 10;
    const H = 10;
    const baseline = makePng(W, H, [255, 255, 255, 255]);
    const px = new PNG({ width: W, height: H });
    px.data = Buffer.from(baseline);
    // Decode capture starting from baseline buffer, then change first 10 pixels.
    const captureImg = PNG.sync.read(baseline);
    for (let i = 0; i < 10 * 4; i += 4) {
      captureImg.data[i] = 0;
      captureImg.data[i + 1] = 0;
      captureImg.data[i + 2] = 0;
      captureImg.data[i + 3] = 255;
    }
    const capture = PNG.sync.write(captureImg);

    // 10/100 = 0.10 differing fraction. Override threshold to 0.20 → pass.
    await writeDefinition(definitionWithVisualMatch('tolerant', 0.2));
    await writeBaseline('tolerant', baseline);
    const captureUri = captureUriForName('tolerant');
    await writeCapture(captureUri, capture);

    mockArtifactFindFirst.mockResolvedValue({
      id: 'art-5',
      uri: captureUri,
      name: 'tolerant',
    });

    await service.processInstance(instanceId);

    expect(mockArtifactUpdate).toHaveBeenCalledWith({
      where: { id: 'art-5' },
      data: { verdict: 'pass' },
    });
  });

  it('does nothing for tests without visualMatch sub-steps', async () => {
    await writeDefinition({
      tests: [{ name: 't', steps: [{ action: { type: 'httpRequest' } }] }],
    });
    await service.processInstance(instanceId);
    expect(mockArtifactFindFirst).not.toHaveBeenCalled();
    expect(mockArtifactUpdate).not.toHaveBeenCalled();
  });

  it('skips screenshot sub-steps without a match block (pure evidence captures)', async () => {
    // Bare-string and object-form-without-match screenshots are pure
    // evidence captures. Neither should trigger the diff job. match: false
    // must also be skipped (semantic equivalent to omitting the key).
    await writeDefinition({
      tests: [
        {
          name: 't',
          steps: [
            {
              action: {
                type: 'ui',
                target: 'svc',
                steps: [
                  { screenshot: 'just-evidence' },
                  { screenshot: { name: 'also-evidence' } },
                  { screenshot: { name: 'opted-out', match: false } },
                ],
              },
            },
          ],
        },
      ],
    });
    await service.processInstance(instanceId);
    expect(mockArtifactFindFirst).not.toHaveBeenCalled();
    expect(mockArtifactUpdate).not.toHaveBeenCalled();
  });

  it('treats match: true (boolean) the same as match: {} (diff with defaults)', async () => {
    await writeDefinition({
      tests: [
        {
          name: 't',
          steps: [
            {
              action: {
                type: 'ui',
                target: 'svc',
                steps: [{ screenshot: { name: 'bool-form', match: true } }],
              },
            },
          ],
        },
      ],
    });
    const png = makePng(10, 10, [128, 128, 128, 255]);
    await writeBaseline('bool-form', png);
    const captureUri = captureUriForName('bool-form');
    await writeCapture(captureUri, png);

    mockArtifactFindFirst.mockResolvedValue({
      id: 'art-bool',
      uri: captureUri,
      name: 'bool-form',
    });

    await service.processInstance(instanceId);

    expect(mockArtifactUpdate).toHaveBeenCalledWith({
      where: { id: 'art-bool' },
      data: { verdict: 'pass' },
    });
  });

  it('handles missing definition gracefully (no exception)', async () => {
    // No definition.json written.
    const summary = await service.processInstance(instanceId);
    expect(summary).toEqual({ failures: [] });
    expect(mockArtifactFindFirst).not.toHaveBeenCalled();
  });

  it('returns no failures when verdict is pass', async () => {
    await writeDefinition(definitionWithVisualMatch('homepage'));
    const png = makePng(20, 20, [255, 0, 0, 255]);
    await writeBaseline('homepage', png);
    const captureUri = captureUriForName('homepage');
    await writeCapture(captureUri, png);
    mockArtifactFindFirst.mockResolvedValue({
      id: 'art-pass',
      uri: captureUri,
      name: 'homepage',
    });

    const summary = await service.processInstance(instanceId);
    expect(summary.failures).toEqual([]);
  });

  it('returns a failure for verdict=no-baseline (with approval-cmd hint)', async () => {
    await writeDefinition(definitionWithVisualMatch('newpage'));
    const captureUri = captureUriForName('newpage');
    await writeCapture(captureUri, makePng(10, 10, [0, 0, 255, 255]));
    mockArtifactFindFirst.mockResolvedValue({
      id: 'art-nb',
      uri: captureUri,
      name: 'newpage',
    });

    const summary = await service.processInstance(instanceId);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0].name).toBe('newpage');
    expect(summary.failures[0].verdict).toBe('no-baseline');
    expect(summary.failures[0].message).toContain('no baseline for "newpage"');
    expect(summary.failures[0].message).toContain('dokkimi baselines approve');
  });

  it('returns a failure for verdict=fail (with diff-path hint)', async () => {
    await writeDefinition(definitionWithVisualMatch('changed', 0.01));
    const baseline = makePng(10, 10, [255, 0, 0, 255]);
    const capture = makePng(10, 10, [0, 255, 0, 255]); // 100% different
    await writeBaseline('changed', baseline);
    const captureUri = captureUriForName('changed');
    await writeCapture(captureUri, capture);
    mockArtifactFindFirst.mockResolvedValue({
      id: 'art-fail',
      uri: captureUri,
      name: 'changed',
    });

    const summary = await service.processInstance(instanceId);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0].name).toBe('changed');
    expect(summary.failures[0].verdict).toBe('fail');
    expect(summary.failures[0].message).toContain('diff/changed.png');
  });

  it('silently skips when no capture artifact is found in the DB', async () => {
    await writeDefinition(definitionWithVisualMatch('orphan'));
    mockArtifactFindFirst.mockResolvedValue(null);

    const summary = await service.processInstance(instanceId);
    expect(summary.failures).toEqual([]);
    // No update or persist calls because processOne returned null.
    expect(mockArtifactUpdate).not.toHaveBeenCalled();
    expect(mockArtifactsPersist).not.toHaveBeenCalled();
  });

  it('catches and logs errors from processOne without adding to failures', async () => {
    await writeDefinition(definitionWithVisualMatch('broken'));
    // Return a capture artifact, but let the diff fail because the
    // capture file does not exist on disk.
    mockArtifactFindFirst.mockResolvedValue({
      id: 'art-err',
      uri: captureUriForName('does-not-exist'),
      name: 'broken',
    });
    // Baseline exists so it tries to read files and fails.
    await writeBaseline('broken', makePng(5, 5, [0, 0, 0, 255]));

    const summary = await service.processInstance(instanceId);
    // Infrastructure error should NOT appear as a failure.
    expect(summary.failures).toEqual([]);
    expect(mockArtifactUpdate).not.toHaveBeenCalled();
  });

  it('skips screenshot sub-steps with missing or empty name', async () => {
    await writeDefinition({
      tests: [
        {
          name: 't',
          steps: [
            {
              action: {
                type: 'ui',
                target: 'svc',
                steps: [
                  { screenshot: { match: true } }, // no name
                  { screenshot: { name: '', match: true } }, // empty name
                ],
              },
            },
          ],
        },
      ],
    });

    await service.processInstance(instanceId);
    expect(mockArtifactFindFirst).not.toHaveBeenCalled();
  });

  it('skips screenshot when it is an array', async () => {
    await writeDefinition({
      tests: [
        {
          name: 't',
          steps: [
            {
              action: {
                type: 'ui',
                target: 'svc',
                steps: [{ screenshot: ['not', 'valid'] }],
              },
            },
          ],
        },
      ],
    });

    await service.processInstance(instanceId);
    expect(mockArtifactFindFirst).not.toHaveBeenCalled();
  });

  it('skips screenshot when match is an array', async () => {
    await writeDefinition({
      tests: [
        {
          name: 't',
          steps: [
            {
              action: {
                type: 'ui',
                target: 'svc',
                steps: [{ screenshot: { name: 'arr-match', match: [1, 2] } }],
              },
            },
          ],
        },
      ],
    });

    await service.processInstance(instanceId);
    expect(mockArtifactFindFirst).not.toHaveBeenCalled();
  });

  it('skips non-ui steps and tests without steps array', async () => {
    await writeDefinition({
      tests: [
        { name: 'no-steps' }, // no steps key at all
        {
          name: 'mixed',
          steps: [
            { action: { type: 'httpRequest' } }, // non-ui
            { action: { type: 'delay' } }, // non-ui
          ],
        },
      ],
    });

    await service.processInstance(instanceId);
    expect(mockArtifactFindFirst).not.toHaveBeenCalled();
  });

  it('tracks globalStepIndex correctly across multiple tests', async () => {
    // Test 0: one non-ui step (globalStepIndex=0), Test 1: one non-ui (1),
    // one ui step with visualMatch (2)
    await writeDefinition({
      tests: [
        {
          name: 'test-a',
          steps: [{ action: { type: 'httpRequest' } }],
        },
        {
          name: 'test-b',
          steps: [
            { action: { type: 'delay' } },
            {
              action: {
                type: 'ui',
                target: 'svc',
                steps: [{ screenshot: { name: 'deep', match: true } }],
              },
            },
          ],
        },
      ],
    });

    const png = makePng(5, 5, [100, 100, 100, 255]);
    await writeBaseline('deep', png);
    const captureUri = captureUriForName('deep');
    await writeCapture(captureUri, png);
    mockArtifactFindFirst.mockResolvedValue({
      id: 'art-deep',
      uri: captureUri,
      name: 'deep',
    });

    await service.processInstance(instanceId);

    // The ui step is at globalStepIndex=2 (0 from test-a, 1+2 from test-b).
    expect(mockArtifactFindFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        stepIndex: 2,
        subStepIndex: 0,
        name: 'deep',
      }),
    });
  });

  it('returns empty failures for definition with empty tests array', async () => {
    await writeDefinition({ tests: [] });
    const summary = await service.processInstance(instanceId);
    expect(summary.failures).toEqual([]);
    expect(mockArtifactFindFirst).not.toHaveBeenCalled();
  });

  it('returns empty failures for definition with no tests key', async () => {
    await writeDefinition({ services: [] });
    const summary = await service.processInstance(instanceId);
    expect(summary.failures).toEqual([]);
  });

  it('fails when only height differs (width same)', async () => {
    await writeDefinition(definitionWithVisualMatch('height-diff'));
    await writeBaseline('height-diff', makePng(10, 10, [0, 0, 0, 255]));
    const captureUri = captureUriForName('height-diff');
    await writeCapture(captureUri, makePng(10, 20, [0, 0, 0, 255]));

    mockArtifactFindFirst.mockResolvedValue({
      id: 'art-h',
      uri: captureUri,
      name: 'height-diff',
    });

    const summary = await service.processInstance(instanceId);
    expect(mockArtifactUpdate).toHaveBeenCalledWith({
      where: { id: 'art-h' },
      data: { verdict: 'fail' },
    });
    expect(mockArtifactsPersist).toHaveBeenCalled();
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0].verdict).toBe('fail');
  });

  it('passes when diff fraction equals the threshold exactly (<=)', async () => {
    // Create images where exactly 1 out of 100 pixels differs (0.01 fraction).
    // With threshold=0.01, 0.01 <= 0.01 should pass.
    const W = 10;
    const H = 10;
    const baseline = makePng(W, H, [255, 255, 255, 255]);
    const captureImg = PNG.sync.read(baseline);
    // Change exactly 1 pixel (the first one) to black.
    captureImg.data[0] = 0;
    captureImg.data[1] = 0;
    captureImg.data[2] = 0;
    captureImg.data[3] = 255;
    const capture = PNG.sync.write(captureImg);

    await writeDefinition(definitionWithVisualMatch('boundary', 0.01));
    await writeBaseline('boundary', baseline);
    const captureUri = captureUriForName('boundary');
    await writeCapture(captureUri, capture);

    mockArtifactFindFirst.mockResolvedValue({
      id: 'art-bound',
      uri: captureUri,
      name: 'boundary',
    });

    await service.processInstance(instanceId);

    expect(mockArtifactUpdate).toHaveBeenCalledWith({
      where: { id: 'art-bound' },
      data: { verdict: 'pass' },
    });
    expect(mockArtifactsPersist).not.toHaveBeenCalled();
  });

  it('accumulates multiple failures across several visualMatch sub-steps', async () => {
    // Two visualMatch sub-steps: one no-baseline, one fail.
    await writeDefinition({
      tests: [
        {
          name: 'multi',
          steps: [
            {
              action: {
                type: 'ui',
                target: 'svc',
                steps: [
                  { screenshot: { name: 'missing-bl', match: true } },
                  {
                    screenshot: { name: 'bad-diff', match: { threshold: 0.0 } },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    // 'missing-bl' has no baseline; 'bad-diff' has a different capture.
    await writeBaseline('bad-diff', makePng(5, 5, [255, 0, 0, 255]));
    const capUri1 = captureUriForName('missing-bl');
    const capUri2 = captureUriForName('bad-diff');
    await writeCapture(capUri1, makePng(5, 5, [0, 0, 0, 255]));
    await writeCapture(capUri2, makePng(5, 5, [0, 255, 0, 255]));

    mockArtifactFindFirst
      .mockResolvedValueOnce({ id: 'a1', uri: capUri1, name: 'missing-bl' })
      .mockResolvedValueOnce({ id: 'a2', uri: capUri2, name: 'bad-diff' });

    const summary = await service.processInstance(instanceId);
    expect(summary.failures).toHaveLength(2);
    expect(summary.failures[0].verdict).toBe('no-baseline');
    expect(summary.failures[0].name).toBe('missing-bl');
    expect(summary.failures[1].verdict).toBe('fail');
    expect(summary.failures[1].name).toBe('bad-diff');
  });

  it('skips sub-steps that are not screenshot objects', async () => {
    // UI steps can contain non-screenshot sub-steps (click, type, etc.).
    await writeDefinition({
      tests: [
        {
          name: 't',
          steps: [
            {
              action: {
                type: 'ui',
                target: 'svc',
                steps: [
                  { click: '#btn' },
                  { type: { selector: '#input', text: 'hi' } },
                  { screenshot: { name: 'after-click', match: true } },
                ],
              },
            },
          ],
        },
      ],
    });

    const png = makePng(5, 5, [50, 50, 50, 255]);
    await writeBaseline('after-click', png);
    const captureUri = captureUriForName('after-click');
    await writeCapture(captureUri, png);

    mockArtifactFindFirst.mockResolvedValue({
      id: 'art-click',
      uri: captureUri,
      name: 'after-click',
    });

    await service.processInstance(instanceId);

    // Should only find the one screenshot with match, at subStepIndex=2.
    expect(mockArtifactFindFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        subStepIndex: 2,
        name: 'after-click',
      }),
    });
    expect(mockArtifactUpdate).toHaveBeenCalledWith({
      where: { id: 'art-click' },
      data: { verdict: 'pass' },
    });
  });

  it('uses DEFAULT_THRESHOLD when match is true (boolean form)', async () => {
    // Create images where ~5% of pixels differ. Default threshold is 0.01,
    // so this should fail.
    const W = 10;
    const H = 10;
    const baseline = makePng(W, H, [255, 255, 255, 255]);
    const captureImg = PNG.sync.read(baseline);
    // Change 5 pixels out of 100 = 5%
    for (let p = 0; p < 5; p++) {
      const i = p * 4;
      captureImg.data[i] = 0;
      captureImg.data[i + 1] = 0;
      captureImg.data[i + 2] = 0;
    }
    const capture = PNG.sync.write(captureImg);

    await writeDefinition({
      tests: [
        {
          name: 't',
          steps: [
            {
              action: {
                type: 'ui',
                target: 'svc',
                steps: [
                  { screenshot: { name: 'default-thresh', match: true } },
                ],
              },
            },
          ],
        },
      ],
    });
    await writeBaseline('default-thresh', baseline);
    const captureUri = captureUriForName('default-thresh');
    await writeCapture(captureUri, capture);

    mockArtifactFindFirst.mockResolvedValue({
      id: 'art-dt',
      uri: captureUri,
      name: 'default-thresh',
    });

    const summary = await service.processInstance(instanceId);
    expect(mockArtifactUpdate).toHaveBeenCalledWith({
      where: { id: 'art-dt' },
      data: { verdict: 'fail' },
    });
    expect(summary.failures).toHaveLength(1);
  });

  it('skips steps with no action property', async () => {
    await writeDefinition({
      tests: [
        {
          name: 't',
          steps: [
            {}, // step with no action
            { note: 'just metadata' }, // step with unrelated props
          ],
        },
      ],
    });

    const summary = await service.processInstance(instanceId);
    expect(summary.failures).toEqual([]);
    expect(mockArtifactFindFirst).not.toHaveBeenCalled();
  });
});
