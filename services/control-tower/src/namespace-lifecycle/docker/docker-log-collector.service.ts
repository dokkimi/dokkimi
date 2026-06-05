import { Injectable, Logger } from '@nestjs/common';
import { DockerClientService } from './docker-client.service';
import { ConsoleLogProcessorService } from '../../log-processing/processors/console-log-processor.service';

interface LogStream {
  containerId: string;
  itemName: string;
  destroy: () => void;
}

@Injectable()
export class DockerLogCollectorService {
  private readonly logger = new Logger(DockerLogCollectorService.name);
  private readonly activeStreams = new Map<string, LogStream[]>();

  constructor(
    private readonly dockerClient: DockerClientService,
    private readonly consoleLogProcessor: ConsoleLogProcessorService,
  ) {}

  async startCollecting(
    instanceId: string,
    containerId: string,
    itemName: string,
    instanceItemId?: string,
  ): Promise<void> {
    try {
      const stream = await this.dockerClient.streamLogs(
        containerId,
        (data: Buffer) => {
          this.processLogChunk(data, instanceId, instanceItemId);
        },
      );

      const logStream: LogStream = {
        containerId,
        itemName,
        destroy: stream.destroy,
      };

      const streams = this.activeStreams.get(instanceId) || [];
      streams.push(logStream);
      this.activeStreams.set(instanceId, streams);

      this.logger.log(
        `Started log collection for ${itemName} (${containerId.substring(0, 12)})`,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to start log collection for ${itemName}: ${error}`,
      );
    }
  }

  stopCollecting(instanceId: string): void {
    const streams = this.activeStreams.get(instanceId);
    if (!streams) {
      return;
    }

    for (const stream of streams) {
      try {
        stream.destroy();
      } catch {
        // ignore cleanup errors
      }
    }

    this.activeStreams.delete(instanceId);
    this.logger.log(
      `Stopped log collection for instance ${instanceId} (${streams.length} streams)`,
    );
  }

  private processLogChunk(
    data: Buffer,
    instanceId: string,
    instanceItemId?: string,
  ): void {
    // Docker multiplexed stream format: 8-byte header + payload
    // Header: [stream_type(1), 0, 0, 0, size(4)]
    // stream_type: 1 = stdout, 2 = stderr
    // We strip the header and process each frame.
    let offset = 0;
    while (offset < data.length) {
      if (offset + 8 > data.length) {
        // Incomplete header — treat remainder as raw text
        this.processLine(
          data.subarray(offset).toString('utf-8'),
          instanceId,
          instanceItemId,
        );
        break;
      }

      const streamType = data[offset];
      const payloadSize = data.readUInt32BE(offset + 4);
      offset += 8;

      if (offset + payloadSize > data.length) {
        // Incomplete payload — process what we have
        this.processLine(
          data.subarray(offset).toString('utf-8'),
          instanceId,
          instanceItemId,
        );
        break;
      }

      const payload = data
        .subarray(offset, offset + payloadSize)
        .toString('utf-8');
      offset += payloadSize;

      // Split by newlines — each line is a separate log entry
      const lines = payload.split('\n').filter((l) => l.length > 0);
      for (const line of lines) {
        this.processLine(
          line,
          instanceId,
          instanceItemId,
          streamType === 2 ? 'stderr' : 'stdout',
        );
      }
    }
  }

  private processLine(
    line: string,
    instanceId: string,
    instanceItemId?: string,
    stream?: string,
  ): void {
    if (!line.trim()) {
      return;
    }

    this.consoleLogProcessor
      .processFromFluentBit({
        log: line,
        stream,
        time: new Date().toISOString(),
        instanceId,
        instanceItemId,
      })
      .catch((err) => {
        this.logger.warn(`Failed to process log line: ${err}`);
      });
  }
}
