import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ColoredLoggerService } from '../logging/colored-logger.service';

export interface TestValidationResult {
  passed: boolean;
  message: string;
  details?: {
    expectedRequests: number;
    actualRequests: number;
    missingRequests?: Array<{
      method: string;
      service: string;
      path: string;
    }>;
  };
}

@Injectable()
export class TestValidatorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: ColoredLoggerService,
  ) {}

  /**
   * Validates test results by comparing expected requests with actual HTTP logs
   */
  async validateTestResults(
    instanceId: string,
    testConfig: {
      requests: Array<
        Array<{
          method: string;
          service: string;
          path: string;
          name?: string;
        }>
      >;
    },
  ): Promise<TestValidationResult> {
    this.logger.log(`Validating test results for instance ${instanceId}`);

    // Get all HTTP logs for this instance
    const httpLogs = await this.prisma.httpLog.findMany({
      where: {
        instanceId,
      },
      orderBy: {
        timestamp: 'asc',
      },
    });

    this.logger.log(
      `Found ${httpLogs.length} HTTP logs for instance ${instanceId}`,
    );

    // Flatten expected requests (all groups)
    const expectedRequests = testConfig.requests.flat();

    // Build a map of expected requests for easier lookup
    const expectedMap = new Map<string, number>();
    for (const req of expectedRequests) {
      const key = this.buildRequestKey(req.method, req.service, req.path);
      expectedMap.set(key, (expectedMap.get(key) || 0) + 1);
    }

    // Build a map of actual requests
    const actualMap = new Map<string, number>();
    for (const log of httpLogs) {
      // Extract service name from URL or origin
      const service = this.extractServiceName(log);
      if (service) {
        const key = this.buildRequestKey(log.method, service, log.url);
        actualMap.set(key, (actualMap.get(key) || 0) + 1);
      }
    }

    // Compare expected vs actual
    const missingRequests: Array<{
      method: string;
      service: string;
      path: string;
    }> = [];

    for (const [key, expectedCount] of expectedMap.entries()) {
      const actualCount = actualMap.get(key) || 0;
      if (actualCount < expectedCount) {
        // Parse key to get request details
        const [method, service, path] = key.split('|');
        missingRequests.push({ method, service, path });
      }
    }

    const passed = missingRequests.length === 0;

    return {
      passed,
      message: passed
        ? `All ${expectedRequests.length} expected requests were made`
        : `Missing ${missingRequests.length} of ${expectedRequests.length} expected requests`,
      details: {
        expectedRequests: expectedRequests.length,
        actualRequests: httpLogs.length,
        missingRequests:
          missingRequests.length > 0 ? missingRequests : undefined,
      },
    };
  }

  /**
   * Builds a unique key for a request
   */
  private buildRequestKey(
    method: string,
    service: string,
    path: string,
  ): string {
    // Normalize path (remove query params, trailing slashes)
    const normalizedPath = path.split('?')[0].replace(/\/$/, '') || '/';
    return `${method.toUpperCase()}|${service}|${normalizedPath}`;
  }

  /**
   * Extracts service name from HTTP log
   */
  private extractServiceName(log: any): string | null {
    // Try to extract from origin (service name)
    if (log.origin) {
      return log.origin;
    }

    // Try to extract from URL (e.g., http://service-name:port/path)
    if (log.url) {
      try {
        const url = new URL(log.url);
        const hostname = url.hostname;
        // Remove port if present
        return hostname.split(':')[0];
      } catch {
        // Not a valid URL, try to extract from path
        // For K8s DNS: service-name.namespace.svc.cluster.local
        const match = log.url.match(/([^./]+)\./);
        if (match) {
          return match[1];
        }
      }
    }

    return null;
  }
}
