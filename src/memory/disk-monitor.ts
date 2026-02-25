import { VectorMemoryService } from "./vector-memory-service.js";
import { logger } from "../config/logger.js";

/**
 * Monitors pgvector database disk usage and evicts least-used memories
 * when usage exceeds the configured threshold.
 *
 * Strategy:
 * - Periodically checks DB size via pg_database_size()
 * - When DB exceeds maxDbSizeBytes, evicts memories with lowest hit_count
 * - Evicts in batches until usage drops below the threshold
 * - Runs VACUUM after eviction to reclaim disk space
 */
export class DiskMonitor {
  private vectorMemory: VectorMemoryService;
  private maxDbSizeBytes: number;
  private evictBatchSize: number;
  private intervalMs: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    vectorMemory: VectorMemoryService,
    options?: {
      /** Max DB size in bytes before eviction kicks in. Default: 80% of 45GB */
      maxDbSizeBytes?: number;
      /** How many memories to evict per batch. Default: 100 */
      evictBatchSize?: number;
      /** Check interval in ms. Default: 10 minutes */
      intervalMs?: number;
    }
  ) {
    this.vectorMemory = vectorMemory;
    // Default: 80% of 45GB = 36GB
    this.maxDbSizeBytes = options?.maxDbSizeBytes || 36 * 1024 * 1024 * 1024;
    this.evictBatchSize = options?.evictBatchSize || 100;
    this.intervalMs = options?.intervalMs || 10 * 60 * 1000;
  }

  /**
   * Start periodic monitoring.
   */
  start(): void {
    logger.info(
      {
        maxDbSizeMB: Math.round(this.maxDbSizeBytes / 1024 / 1024),
        intervalMinutes: Math.round(this.intervalMs / 60000),
        evictBatchSize: this.evictBatchSize,
      },
      "Disk monitor started"
    );

    // Run immediately on start, then periodically
    this.check().catch((err) =>
      logger.warn({ err }, "Disk monitor initial check failed")
    );

    this.timer = setInterval(() => {
      this.check().catch((err) =>
        logger.warn({ err }, "Disk monitor check failed")
      );
    }, this.intervalMs);
  }

  /**
   * Stop periodic monitoring.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run a single check: measure DB size, evict if over threshold.
   */
  async check(): Promise<{ dbSizeMB: number; evicted: number }> {
    const dbSizeBytes = await this.vectorMemory.getDatabaseSizeBytes();
    const dbSizeMB = Math.round(dbSizeBytes / 1024 / 1024);
    const maxMB = Math.round(this.maxDbSizeBytes / 1024 / 1024);
    const usagePercent = ((dbSizeBytes / this.maxDbSizeBytes) * 100).toFixed(1);

    logger.info(
      { dbSizeMB, maxMB, usagePercent: `${usagePercent}%` },
      "Disk monitor check"
    );

    let totalEvicted = 0;

    if (dbSizeBytes > this.maxDbSizeBytes) {
      logger.warn(
        { dbSizeMB, maxMB },
        "DB size exceeds threshold, starting eviction"
      );

      // Keep evicting in batches until under threshold
      let currentSize = dbSizeBytes;
      let rounds = 0;
      const maxRounds = 50; // Safety limit

      while (currentSize > this.maxDbSizeBytes && rounds < maxRounds) {
        const totalMemories = await this.vectorMemory.countAll();
        if (totalMemories === 0) break;

        // Don't evict everything — keep at least 10% of memories
        const minKeep = Math.max(10, Math.floor(totalMemories * 0.1));
        if (totalMemories <= minKeep) {
          logger.warn(
            { totalMemories, minKeep },
            "At minimum memory threshold, stopping eviction"
          );
          break;
        }

        const toEvict = Math.min(this.evictBatchSize, totalMemories - minKeep);
        const evicted = await this.vectorMemory.evictLeastUsed(toEvict);
        totalEvicted += evicted;

        if (evicted === 0) break;

        // Re-check size
        currentSize = await this.vectorMemory.getDatabaseSizeBytes();
        rounds++;
      }

      if (totalEvicted > 0) {
        // VACUUM to actually reclaim disk space
        try {
          const { vectorQuery } = await import("./vector-db.js");
          await vectorQuery("VACUUM memory_embeddings");
          logger.info({ totalEvicted }, "Eviction complete, VACUUM run");
        } catch (err) {
          logger.warn({ err }, "VACUUM failed (non-critical)");
        }
      }
    }

    return { dbSizeMB, evicted: totalEvicted };
  }
}
