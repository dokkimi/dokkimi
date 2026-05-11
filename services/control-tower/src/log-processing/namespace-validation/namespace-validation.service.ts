import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class NamespaceValidationService {
  private readonly logger = new Logger(NamespaceValidationService.name);
  private readonly instanceCache = new Map<
    string,
    { exists: boolean; lastChecked: number }
  >();
  private readonly CACHE_TTL = 60000; // 1 minute cache

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Validates that an instance exists in the database
   * Uses a short-lived cache to reduce database queries
   */
  async validateInstance(instanceId: string): Promise<boolean> {
    // Check cache first
    const cached = this.instanceCache.get(instanceId);
    if (cached && Date.now() - cached.lastChecked < this.CACHE_TTL) {
      return cached.exists;
    }

    try {
      // Query database
      const instance = await this.prisma.namespaceInstance.findUnique({
        where: { id: instanceId },
        select: { id: true },
      });

      const exists = !!instance;

      // Update cache
      this.instanceCache.set(instanceId, {
        exists,
        lastChecked: Date.now(),
      });

      if (!exists) {
        this.logger.warn(`Instance ${instanceId} not found in database`);
      }

      return exists;
    } catch (error) {
      this.logger.error(`Error validating instance ${instanceId}:`, error);
      // On error, assume instance exists to avoid dropping logs
      return true;
    }
  }

  /**
   * Clears the instance cache (useful for testing or when instances are deleted)
   */
  clearCache(instanceId?: string): void {
    if (instanceId) {
      this.instanceCache.delete(instanceId);
    } else {
      this.instanceCache.clear();
    }
  }
}
