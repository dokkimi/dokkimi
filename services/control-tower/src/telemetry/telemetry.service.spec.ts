jest.mock('@dokkimi/telemetry', () => ({
  initTelemetry: jest.fn(),
  trackEvent: jest.fn(),
  shutdownTelemetry: jest.fn().mockResolvedValue(undefined),
}));

import { TelemetryService } from './telemetry.service';
import {
  initTelemetry,
  trackEvent,
  shutdownTelemetry,
} from '@dokkimi/telemetry';

describe('TelemetryService', () => {
  let service: TelemetryService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new (TelemetryService as any)('control-tower');
  });

  describe('onModuleInit', () => {
    it('calls initTelemetry with service name', () => {
      service.onModuleInit();

      expect(initTelemetry).toHaveBeenCalledWith({
        showFirstRunNotice: false,
        serviceName: 'control-tower',
      });
    });
  });

  describe('track', () => {
    it('delegates to trackEvent with service_name', () => {
      service.track('test_event', { key: 'value' });

      expect(trackEvent).toHaveBeenCalledWith('test_event', {
        service_name: 'control-tower',
        key: 'value',
      });
    });

    it('works without extra properties', () => {
      service.track('simple_event');

      expect(trackEvent).toHaveBeenCalledWith('simple_event', {
        service_name: 'control-tower',
      });
    });
  });

  describe('onModuleDestroy', () => {
    it('tracks shutdown with uptime and calls shutdownTelemetry', async () => {
      service.onModuleInit();

      await service.onModuleDestroy();

      expect(trackEvent).toHaveBeenCalledWith('service_shutdown', {
        service_name: 'control-tower',
        uptime_ms: expect.any(Number),
      });
      expect(shutdownTelemetry).toHaveBeenCalled();
    });
  });
});
