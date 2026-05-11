import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ColoredLoggerService } from '../logging/colored-logger.service';
import { TelemetryService } from '../telemetry/telemetry.service';
import { InFlightTrackerService } from '../log-processing/in-flight-tracker.service';

@Injectable()
export class QuiescenceDetectionService {
  private readonly QUIESCENCE_PERIOD_MS = 500;
  private readonly MAX_WAIT_MS = 10000;

  constructor(
    private readonly logger: ColoredLoggerService,
    private readonly prisma: PrismaService,
    private readonly telemetry: TelemetryService,
    private readonly inFlightTracker: InFlightTrackerService,
  ) {}

  async waitForLogsToSettle(
    instanceId: string,
    afterTime: Date,
  ): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 500));

    let lastLogCount = 0;
    let lastChangeTime = Date.now();
    const startTime = Date.now();

    while (Date.now() - lastChangeTime < this.QUIESCENCE_PERIOD_MS) {
      if (Date.now() - startTime > this.MAX_WAIT_MS) {
        this.logger.warn(
          `Quiescence detection timeout reached for instance ${instanceId}`,
        );
        this.telemetry.track('tvs_quiescence_timeout', {
          module: 'test-validation',
          waited_ms: Date.now() - startTime,
        });
        break;
      }

      const inFlight = this.inFlightTracker.inFlightCount;
      const [httpCount, consoleCount] = await Promise.all([
        this.prisma.httpLog.count({
          where: { instanceId, timestamp: { gte: afterTime } },
        }),
        this.prisma.consoleLog.count({
          where: { instanceId, timestamp: { gte: afterTime } },
        }),
      ]);
      const currentCount = httpCount + consoleCount;

      if (currentCount !== lastLogCount || inFlight > 0) {
        lastLogCount = currentCount;
        lastChangeTime = Date.now();
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    this.logger.log(
      `Logs settled for instance ${instanceId} (${lastLogCount} total logs)`,
    );
  }
}
