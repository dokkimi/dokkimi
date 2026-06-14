import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TelemetryService } from '../telemetry/telemetry.service';
import { InstanceStatus, RunStatus } from '@prisma/client';
import { RunStorageService } from '../storage/run-storage.service';
import { StepExecution, TestDefinition } from '@dokkimi/config';
import { SubmitInstanceDto } from './dto/submit-instance.dto';
import { NamespaceLifecycleService } from '../namespace-lifecycle/namespace-lifecycle.service';
import { DockerRegistryService } from '../namespace-lifecycle/docker/docker-registry.service';
import { RegistryCredential } from '@dokkimi/config';
import { RunCleanupService } from './run-cleanup.service';
import { DeploymentSchedulerService } from './deployment-scheduler.service';
import {
  stripInitFileContent,
  toDeployableDefinition,
} from './definition-converter';

@Injectable()
export class RunsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RunsService.name);

  async onApplicationBootstrap() {
    try {
      await this.cleanup.recoverOrphanedRuns();
    } catch (error) {
      this.logger.warn(
        `Failed to recover orphaned runs on startup: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly runStorage: RunStorageService,
    private readonly lifecycle: NamespaceLifecycleService,
    private readonly registryService: DockerRegistryService,
    private readonly telemetry: TelemetryService,
    private readonly cleanup: RunCleanupService,
    private readonly scheduler: DeploymentSchedulerService,
  ) {}

  async createRun(
    definitionNames: string[],
    credentials?: RegistryCredential[],
    projectPath?: string,
  ) {
    await this.cleanup.recoverStaleRuns();

    const activeRun = await this.prisma.run.findFirst({
      where: { status: { in: [RunStatus.PENDING, RunStatus.RUNNING] } },
      select: { id: true },
    });
    if (activeRun) {
      throw new ConflictException(
        `A run is already in progress. Stop it with \`dokkimi stop\` or wait for it to finish.`,
      );
    }

    await this.cleanup.prepareForNewRun(projectPath);

    const run = await this.prisma.run.create({
      data: {
        status: RunStatus.PENDING,
        projectPath: projectPath ?? null,
        instances: {
          create: definitionNames.map((name) => ({
            name,
            status: InstanceStatus.PENDING,
          })),
        },
      },
      include: {
        instances: true,
      },
    });

    for (const inst of run.instances) {
      this.runStorage.registerInstance(
        inst.id,
        run.projectPath ?? '',
        run.createdAt,
        inst.name,
      );
    }

    if (credentials?.length) {
      this.registryService.storeCredentials(run.id, credentials);
    }

    this.logger.log(
      `Created run ${run.id} with ${run.instances.length} instance stubs`,
    );

    this.telemetry.track('ct_run_created', {
      instance_count: run.instances.length,
      has_registry_credentials: (credentials?.length ?? 0) > 0,
    });

    return {
      runId: run.id,
      instances: run.instances.map((inst) => ({
        id: inst.id,
        name: inst.name,
        status: inst.status,
      })),
    };
  }

  async submitInstance(
    runId: string,
    instanceId: string,
    dto: SubmitInstanceDto,
  ) {
    const run = await this.prisma.run.findUnique({ where: { id: runId } });
    if (!run) {
      throw new NotFoundException(`Run ${runId} not found`);
    }

    const instance = await this.prisma.namespaceInstance.findUnique({
      where: { id: instanceId },
    });
    if (!instance || instance.runId !== runId) {
      throw new NotFoundException(
        `Instance ${instanceId} not found in run ${runId}`,
      );
    }

    if (instance.status !== InstanceStatus.PENDING) {
      this.logger.log(
        `Instance ${instanceId} already ${instance.status}, skipping`,
      );
      return { instanceId, status: instance.status };
    }

    if (run.projectPath) {
      this.runStorage.registerInstance(
        instanceId,
        run.projectPath,
        run.createdAt,
        instance.name,
      );
    }

    const { definition } = dto;

    const snapshotDefinition = stripInitFileContent(definition);

    await this.prisma.client.$transaction(async (tx) => {
      for (const item of definition.items) {
        await tx.instanceItem.create({
          data: {
            instanceId,
            itemDefinitionName: item.name,
          },
        });
      }

      if (run.status === RunStatus.PENDING) {
        await tx.run.update({
          where: { id: runId },
          data: { status: RunStatus.RUNNING },
        });
      }
    });

    await this.runStorage.writeDefinition(instanceId, snapshotDefinition);

    const deployableDefinition = toDeployableDefinition(definition);
    await this.runStorage.writeInitFiles(
      instanceId,
      deployableDefinition.items,
    );

    const def = definition as unknown as Record<string, unknown>;
    const defItems = (def.items as any[]) || [];
    const defTests = (def.tests as any[]) || [];

    const itemTypes = { service: 0, database: 0, mock: 0 };
    for (const item of defItems) {
      const type = (item.type || '').toUpperCase();
      if (type === 'SERVICE') {
        itemTypes.service++;
      } else if (type === 'DATABASE') {
        itemTypes.database++;
      } else if (type === 'MOCK') {
        itemTypes.mock++;
      }
    }

    let totalStepCount = 0;
    let hasExtract = false;
    for (const test of defTests) {
      const steps = test.steps as any[] | undefined;
      if (!Array.isArray(steps)) {
        continue;
      }
      totalStepCount += steps.length;
      for (const step of steps) {
        if (step.extract) {
          hasExtract = true;
        }
      }
    }

    this.telemetry.track('ct_instance_submitted', {
      item_count: definition.items.length,
      item_types: itemTypes,
      has_tests: defTests.length > 0,
      test_count: defTests.length,
      total_step_count: totalStepCount,
      has_init_files: defItems.some((i: any) => i.initFiles),
      has_extract: hasExtract,
    });

    return { instanceId, status: 'PENDING' };
  }

  async getRunHistory(projectPath?: string, limit = 10) {
    const runs = await this.prisma.run.findMany({
      where: projectPath ? { projectPath } : undefined,
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { instances: true },
    });

    return runs.map((run) => ({
      runId: run.id,
      projectPath: run.projectPath,
      status: run.status,
      createdAt: run.createdAt,
      completedAt: run.completedAt,
      instances: run.instances.map((inst) => ({
        id: inst.id,
        name: inst.name,
        status: inst.status,
        testStatus: inst.testStatus,
        errorMessage: inst.errorMessage,
      })),
    }));
  }

  async getLatestRun(projectPath?: string) {
    const run = await this.prisma.run.findFirst({
      where: projectPath ? { projectPath } : undefined,
      orderBy: { createdAt: 'desc' },
      include: { instances: true },
    });

    if (!run) {
      return null;
    }

    return {
      runId: run.id,
      status: run.status,
      createdAt: run.createdAt,
      completedAt: run.completedAt,
      instances: run.instances.map((inst) => ({
        id: inst.id,
        name: inst.name,
        status: inst.status,
        testStatus: inst.testStatus,
        errorMessage: inst.errorMessage,
      })),
    };
  }

  async getRunStatus(runId: string) {
    const run = await this.prisma.run.findUnique({
      where: { id: runId },
      include: {
        instances: {
          include: { items: true },
        },
      },
    });

    if (!run) {
      throw new NotFoundException(`Run ${runId} not found`);
    }

    if (run.status === RunStatus.PENDING || run.status === RunStatus.RUNNING) {
      this.scheduler.deployPendingInstances(runId).catch((err) => {
        this.logger.error(
          `Failed to deploy pending instances for run ${runId}:`,
          err,
        );
      });
    }

    return {
      runId: run.id,
      status: run.status,
      createdAt: run.createdAt,
      completedAt: run.completedAt,
      cancelledAt: run.cancelledAt,
      instances: run.instances.map((inst) => ({
        id: inst.id,
        name: inst.name,
        status: inst.status,
        testStatus: inst.testStatus,
        errorMessage: inst.errorMessage,
      })),
    };
  }

  async stopCurrentRun() {
    const activeRun = await this.prisma.run.findFirst({
      where: {
        status: { in: [RunStatus.PENDING, RunStatus.RUNNING] },
      },
      orderBy: { createdAt: 'desc' },
      include: { instances: true },
    });

    if (!activeRun) {
      this.logger.log('No active run to stop');
      return { status: 'NO_ACTIVE_RUN' };
    }

    await this.cleanup.stopInstances(activeRun.instances);

    await this.prisma.run.update({
      where: { id: activeRun.id },
      data: {
        status: RunStatus.CANCELLED,
        cancelledAt: new Date(),
      },
    });

    this.registryService.clearCredentials(activeRun.id);

    this.logger.log(`Stopped run ${activeRun.id}`);
    this.telemetry.track('ct_run_stopped', {
      instances_stopped: activeRun.instances.length,
    });
    return { runId: activeRun.id, status: 'CANCELLED' };
  }

  async deleteRun(runId: string) {
    const run = await this.prisma.run.findUnique({
      where: { id: runId },
      include: { instances: true },
    });

    if (!run) {
      throw new NotFoundException(`Run ${runId} not found`);
    }

    await this.cleanup.stopInstances(run.instances);

    await this.prisma.run.delete({ where: { id: runId } });

    await this.deleteRunStorage(run);

    this.registryService.clearCredentials(runId);

    this.logger.log(`Deleted run ${runId}`);
    return { runId, status: 'DELETED' };
  }

  async deleteAllRuns(projectPath?: string) {
    const runs = await this.prisma.run.findMany({
      where: projectPath ? { projectPath } : undefined,
      include: { instances: true },
    });

    for (const run of runs) {
      await this.cleanup.stopInstances(run.instances);
      await this.prisma.run.delete({ where: { id: run.id } });
      await this.deleteRunStorage(run);
      this.registryService.clearCredentials(run.id);
    }

    await this.prisma.$queryRaw`VACUUM`;

    this.logger.log(
      `Deleted ${runs.length} run(s)${projectPath ? ` for project ${projectPath}` : ' (all projects)'}`,
    );
    return { deleted: runs.length };
  }

  async ensureInstanceRegistered(
    runId: string,
    instanceId: string,
  ): Promise<void> {
    if (this.runStorage.hasInstance(instanceId)) {
      return;
    }
    const run = await this.prisma.run.findUnique({ where: { id: runId } });
    if (!run) {
      return;
    }
    const instance = await this.prisma.namespaceInstance.findUnique({
      where: { id: instanceId },
    });
    if (!instance) {
      return;
    }
    if (run.projectPath) {
      this.runStorage.registerInstance(
        instanceId,
        run.projectPath,
        run.createdAt,
        instance.name,
      );
    }
  }

  private async deleteRunStorage(run: {
    projectPath: string | null;
    createdAt: Date;
  }): Promise<void> {
    if (run.projectPath) {
      await this.runStorage.deleteRunDir(run.projectPath, run.createdAt);
    }
  }

  async handleTestCompletion(
    testRunId: string,
    status: 'success' | 'failure',
    message?: string,
    stepExecutions?: StepExecution[],
  ): Promise<void> {
    const instance = await this.prisma.namespaceInstance.findUnique({
      where: { id: testRunId },
    });

    if (!instance) {
      this.logger.error(`Instance not found for testRunId ${testRunId}`);
      throw new Error(`Instance not found for testRunId ${testRunId}`);
    }

    if (status === 'failure') {
      let testDefinitions: TestDefinition[] | undefined;
      try {
        const stored = await this.runStorage.readDefinition(instance.id);
        testDefinitions = stored.tests as TestDefinition[] | undefined;
      } catch (err) {
        this.logger.warn(
          `Could not read definition for instance ${instance.id}: ${err instanceof Error ? err.message : err}`,
        );
      }

      const hasTestSteps =
        testDefinitions?.some(
          (t) => Array.isArray(t.steps) && t.steps.length > 0,
        ) ?? false;

      if (testDefinitions && hasTestSteps) {
        const executedSteps = new Set(
          (stepExecutions ?? []).map((s) => s.stepIndex),
        );
        let globalStepIndex = 0;
        for (const test of testDefinitions) {
          for (const _step of test.steps ?? []) {
            if (!executedSteps.has(globalStepIndex)) {
              try {
                await this.prisma.assertionResult.create({
                  data: {
                    instanceId: instance.id,
                    stepIndex: globalStepIndex,
                    assertionIndex: 0,
                    assertionType: 'skip',
                    passed: false,
                    resultKind: 'SKIPPED',
                    error:
                      'Step was not executed — a previous step failed before reaching this step',
                  },
                });
              } catch (err) {
                this.logger.warn(
                  `Failed to store SKIPPED result: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
              try {
                await this.prisma.testExecutionLog.create({
                  data: {
                    instanceId: instance.id,
                    eventType: 'REQUEST_SKIPPED',
                    message: `Step ${globalStepIndex} skipped — a previous step failed`,
                    stepIndex: globalStepIndex,
                  },
                });
              } catch (err) {
                this.logger.warn(
                  `Failed to log step skip: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            }
            globalStepIndex++;
          }
        }
      }
    }

    const finalPassed = status === 'success';
    const finalError =
      status === 'failure' ? message || 'Test execution failed' : undefined;

    await this.handleValidationComplete(testRunId, finalPassed, finalError);
  }

  async handleValidationComplete(
    instanceId: string,
    passed: boolean,
    error?: string,
  ) {
    const instance = await this.prisma.namespaceInstance.update({
      where: { id: instanceId },
      data: {
        testStatus: passed ? 'PASSED' : 'FAILED',
        testCompletedAt: new Date(),
        errorMessage: error ?? null,
      },
    });

    this.lifecycle
      .stopInstance(instanceId)
      .catch((err) => {
        this.logger.error(`Failed to stop instance ${instanceId}:`, err);
      })
      .then(() => {
        if (instance.runId) {
          return this.scheduler.handleInstancesStopped([instance.runId]);
        }
      });
  }

  async handleInstancesStopped(runIds: string[]) {
    return this.scheduler.handleInstancesStopped(runIds);
  }
}
