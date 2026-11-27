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
      // A frame can arrive split across chunks: keep the incomplete end
      // until the rest arrives
      let pending: Buffer = Buffer.alloc(0);
      const stream = await this.dockerClient.streamLogs(
        containerId,
        (data: Buffer) => {
          pending = pending.length ? Buffer.concat([pending, data]) : data;
          const used = this.processFrames(pending, instanceId, instanceItemId);
          pending = pending.subarray(used);
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

  /** Processes the complete frames in `data`, returning the bytes used */
  private processFrames(
    data: Buffer,
    instanceId: string,
    instanceItemId?: string,
  ): number {
    // Docker multiplexed stream format: 8-byte header + payload
    // Header: [stream_type(1), 0, 0, 0, size(4)]
    // stream_type: 1 = stdout, 2 = stderr
    let offset = 0;
    while (offset + 8 <= data.length) {
      const streamType = data[offset];
      const payloadSize = data.readUInt32BE(offset + 4);
      if (offset + 8 + payloadSize > data.length) {
        break;
      }
      const payload = data
        .subarray(offset + 8, offset + 8 + payloadSize)
        .toString('utf-8');
      offset += 8 + payloadSize;

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
    return offset;
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

    // With timestamps: true, Docker prefixes each line with an RFC3339Nano
    // timestamp: "2026-06-12T15:29:02.213456789Z <log content>"
    const { timestamp, message } = this.parseDockerTimestamp(line);

    this.consoleLogProcessor
      .processRawLogs({
        log: message,
        stream,
        time: timestamp,
        instanceId,
        instanceItemId,
      })
      .catch((err) => {
        this.logger.warn(`Failed to process log line: ${err}`);
      });
  }

  private parseDockerTimestamp(line: string): {
    timestamp: string;
    message: string;
  } {
    // Docker timestamp format: "2026-06-12T15:29:02.213456789Z <rest>"
    const spaceIdx = line.indexOf(' ');
    if (spaceIdx > 0 && spaceIdx <= 35) {
      const candidate = line.substring(0, spaceIdx);
      if (/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(candidate)) {
        return { timestamp: candidate, message: line.substring(spaceIdx + 1) };
      }
    }
    return { timestamp: new Date().toISOString(), message: line };
  }
}
