import {
  Injectable,
  Inject,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import {
  initTelemetry,
  trackEvent,
  shutdownTelemetry,
} from '@dokkimi/telemetry';

@Injectable()
export class TelemetryService implements OnModuleInit, OnModuleDestroy {
  private startedAt: number = Date.now();

  constructor(
    @Inject('TELEMETRY_SERVICE_NAME') private readonly serviceName: string,
  ) {}

  onModuleInit(): void {
    initTelemetry({
      showFirstRunNotice: false,
      serviceName: this.serviceName,
    });
    this.startedAt = Date.now();
  }

  async onModuleDestroy(): Promise<void> {
    this.track('service_shutdown', {
      uptime_ms: Date.now() - this.startedAt,
    });
    await shutdownTelemetry();
  }

  track(event: string, properties?: Record<string, unknown>): void {
    trackEvent(event, { service_name: this.serviceName, ...properties });
  }
}
