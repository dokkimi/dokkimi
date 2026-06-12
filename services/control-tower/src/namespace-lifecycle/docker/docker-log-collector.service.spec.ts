import { DockerLogCollectorService } from './docker-log-collector.service';

describe('DockerLogCollectorService', () => {
  let service: DockerLogCollectorService;
  let mockDockerClient: any;
  let mockConsoleLogProcessor: any;

  let capturedCallback: ((data: Buffer) => void) | null;

  beforeEach(() => {
    jest.clearAllMocks();
    capturedCallback = null;

    mockDockerClient = {
      streamLogs: jest.fn().mockImplementation((_id: string, cb: any) => {
        capturedCallback = cb;
        return Promise.resolve({ destroy: jest.fn() });
      }),
    };

    mockConsoleLogProcessor = {
      processRawLogs: jest.fn().mockResolvedValue(undefined),
    };

    service = new DockerLogCollectorService(
      mockDockerClient,
      mockConsoleLogProcessor,
    );
  });

  function buildDockerFrame(streamType: number, payload: string): Buffer {
    const payloadBuf = Buffer.from(payload, 'utf-8');
    const header = Buffer.alloc(8);
    header[0] = streamType;
    header.writeUInt32BE(payloadBuf.length, 4);
    return Buffer.concat([header, payloadBuf]);
  }

  describe('startCollecting', () => {
    it('should call streamLogs on the docker client', async () => {
      await service.startCollecting('inst-1', 'container-abc', 'api');

      expect(mockDockerClient.streamLogs).toHaveBeenCalledWith(
        'container-abc',
        expect.any(Function),
      );
    });

    it('should track the stream for the instance', async () => {
      await service.startCollecting('inst-1', 'c1', 'api');
      await service.startCollecting('inst-1', 'c2', 'web');

      // Verified via stopCollecting test below — both streams should be destroyed
      service.stopCollecting('inst-1');
    });

    it('should not throw if streamLogs fails', async () => {
      mockDockerClient.streamLogs.mockRejectedValue(new Error('fail'));

      await expect(
        service.startCollecting('inst-1', 'c1', 'api'),
      ).resolves.not.toThrow();
    });
  });

  describe('stopCollecting', () => {
    it('should destroy all streams for the instance', async () => {
      await service.startCollecting('inst-1', 'c1', 'api');
      await service.startCollecting('inst-1', 'c2', 'web');

      const destroy1 = (await mockDockerClient.streamLogs.mock.results[0].value)
        .destroy;
      const destroy2 = (await mockDockerClient.streamLogs.mock.results[1].value)
        .destroy;

      service.stopCollecting('inst-1');

      expect(destroy1).toHaveBeenCalled();
      expect(destroy2).toHaveBeenCalled();
    });

    it('should not throw for unknown instance', () => {
      expect(() => service.stopCollecting('unknown')).not.toThrow();
    });

    it('should not throw if destroy throws', async () => {
      mockDockerClient.streamLogs.mockResolvedValue({
        destroy: jest.fn(() => {
          throw new Error('cleanup error');
        }),
      });

      await service.startCollecting('inst-1', 'c1', 'api');
      expect(() => service.stopCollecting('inst-1')).not.toThrow();
    });
  });

  describe('log processing (processLogChunk)', () => {
    it('should parse stdout frames and send to processor', async () => {
      await service.startCollecting('inst-1', 'c1', 'api', 'item-1');
      const frame = buildDockerFrame(1, 'hello world\n');
      capturedCallback!(frame);

      expect(mockConsoleLogProcessor.processRawLogs).toHaveBeenCalledWith(
        expect.objectContaining({
          log: 'hello world',
          stream: 'stdout',
          instanceId: 'inst-1',
          instanceItemId: 'item-1',
        }),
      );
    });

    it('should parse stderr frames', async () => {
      await service.startCollecting('inst-1', 'c1', 'api', 'item-1');
      const frame = buildDockerFrame(2, 'error message\n');
      capturedCallback!(frame);

      expect(mockConsoleLogProcessor.processRawLogs).toHaveBeenCalledWith(
        expect.objectContaining({
          log: 'error message',
          stream: 'stderr',
        }),
      );
    });

    it('should handle multiple frames in a single chunk', async () => {
      await service.startCollecting('inst-1', 'c1', 'api');
      const frame1 = buildDockerFrame(1, 'line one\n');
      const frame2 = buildDockerFrame(2, 'line two\n');
      const combined = Buffer.concat([frame1, frame2]);
      capturedCallback!(combined);

      expect(mockConsoleLogProcessor.processRawLogs).toHaveBeenCalledTimes(2);
    });

    it('should split multi-line payloads into separate log entries', async () => {
      await service.startCollecting('inst-1', 'c1', 'api');
      const frame = buildDockerFrame(1, 'first\nsecond\nthird\n');
      capturedCallback!(frame);

      expect(mockConsoleLogProcessor.processRawLogs).toHaveBeenCalledTimes(3);
      expect(mockConsoleLogProcessor.processRawLogs).toHaveBeenCalledWith(
        expect.objectContaining({ log: 'first' }),
      );
      expect(mockConsoleLogProcessor.processRawLogs).toHaveBeenCalledWith(
        expect.objectContaining({ log: 'third' }),
      );
    });

    it('should skip empty lines', async () => {
      await service.startCollecting('inst-1', 'c1', 'api');
      const frame = buildDockerFrame(1, '  \n');
      capturedCallback!(frame);

      expect(mockConsoleLogProcessor.processRawLogs).not.toHaveBeenCalled();
    });

    it('should handle incomplete header as raw text', async () => {
      await service.startCollecting('inst-1', 'c1', 'api');
      const partial = Buffer.from('short');
      capturedCallback!(partial);

      expect(mockConsoleLogProcessor.processRawLogs).toHaveBeenCalledWith(
        expect.objectContaining({ log: 'short' }),
      );
    });

    it('should handle incomplete payload gracefully', async () => {
      await service.startCollecting('inst-1', 'c1', 'api');
      const header = Buffer.alloc(8);
      header[0] = 1;
      header.writeUInt32BE(100, 4); // claims 100 bytes but only 5 follow
      const truncated = Buffer.concat([header, Buffer.from('hello')]);
      capturedCallback!(truncated);

      expect(mockConsoleLogProcessor.processRawLogs).toHaveBeenCalledWith(
        expect.objectContaining({ log: 'hello' }),
      );
    });

    it('should not crash if processRawLogs rejects', async () => {
      mockConsoleLogProcessor.processRawLogs.mockRejectedValue(
        new Error('db error'),
      );

      await service.startCollecting('inst-1', 'c1', 'api');
      const frame = buildDockerFrame(1, 'some log\n');

      expect(() => capturedCallback!(frame)).not.toThrow();
    });
  });
});
