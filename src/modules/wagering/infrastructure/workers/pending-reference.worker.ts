import {
  Injectable,
  Inject,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { ENTITY_MANAGER_TOKEN } from '../../../../infrastructure/database/database.module';
import { ReprocessPendingReferenceUseCase } from '../../application/use-cases/reprocess-pending-reference.use-case';
import { WagerTransactionStatus } from '../../domain/wager-transaction-status.enum';

export interface PendingReferenceBatchResult {
  processedCount: number;
  rejectedCount: number;
  pendingCount: number;
}

@Injectable()
export class PendingReferenceWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private isRunning = false;
  private timer: Timer | null = null;
  private activeExecutionPromise: Promise<void> | null = null;

  public pollIntervalMs: number;
  public maxRetries: number;
  public ttlSeconds: number;
  public batchSize = 50;
  public baseBackoffSeconds = 2;

  constructor(
    @Inject(ENTITY_MANAGER_TOKEN)
    private readonly em: EntityManager,
    private readonly reprocessUseCase: ReprocessPendingReferenceUseCase,
  ) {
    this.pollIntervalMs = Number(process.env.PENDING_REFERENCE_POLL_INTERVAL_MS) || 5000;
    this.maxRetries = Number(process.env.PENDING_REFERENCE_MAX_RETRIES) || 5;
    this.ttlSeconds = Number(process.env.PENDING_REFERENCE_TTL_SECONDS) || 300;
  }

  async onModuleInit() {
    const autoStart = process.env.PENDING_REFERENCE_WORKER_AUTO_START === 'true';
    if (autoStart) {
      this.start();
    }
  }

  async onModuleDestroy() {
    await this.stop();
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.logger.log(
      `Starting PendingReferenceWorker [interval=${this.pollIntervalMs}ms, maxRetries=${this.maxRetries}, ttl=${this.ttlSeconds}s]`,
    );
    this.scheduleNextPoll(100);
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.logger.log('Gracefully stopping PendingReferenceWorker...');
    this.isRunning = false;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.activeExecutionPromise) {
      await Promise.race([
        this.activeExecutionPromise,
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    }

    this.logger.log('PendingReferenceWorker stopped cleanly.');
  }

  public async processBatch(
    now: Date = new Date(),
    batchSize = this.batchSize,
  ): Promise<PendingReferenceBatchResult> {
    // 1. Fetch eligible candidate IDs using FOR UPDATE SKIP LOCKED
    const candidateIds = await this.em.transactional(async (tem) => {
      const rows: any[] = await tem.execute(
        `SELECT id FROM wager_transactions
         WHERE status = 'PENDING_REFERENCE'
           AND (next_retry_at IS NULL OR next_retry_at <= ?)
         ORDER BY created_at ASC
         LIMIT ?
         FOR UPDATE SKIP LOCKED`,
        [now, batchSize],
      );
      return (rows || []).map((r) => r.id as string);
    });

    if (candidateIds.length === 0) {
      return { processedCount: 0, rejectedCount: 0, pendingCount: 0 };
    }

    let processedCount = 0;
    let rejectedCount = 0;
    let pendingCount = 0;

    // 2. Reprocess each candidate individually within its own transaction
    for (const txId of candidateIds) {
      try {
        const result = await this.reprocessUseCase.execute({
          transactionId: txId,
          maxRetries: this.maxRetries,
          ttlSeconds: this.ttlSeconds,
          baseBackoffSeconds: this.baseBackoffSeconds,
          now,
        });

        if (result.status === WagerTransactionStatus.Processed) {
          processedCount++;
        } else if (result.status === WagerTransactionStatus.Rejected) {
          rejectedCount++;
        } else {
          pendingCount++;
        }
      } catch (err) {
        this.logger.error(`Error reprocessing pending reference transaction ${txId}`, err);
        pendingCount++;
      }
    }

    return { processedCount, rejectedCount, pendingCount };
  }

  private scheduleNextPoll(delayMs = this.pollIntervalMs): void {
    if (!this.isRunning) return;

    this.timer = setTimeout(async () => {
      this.activeExecutionPromise = this.executePollCycle();
      await this.activeExecutionPromise;
      this.activeExecutionPromise = null;
    }, delayMs);
  }

  private async executePollCycle(): Promise<void> {
    if (!this.isRunning) return;

    try {
      const result = await this.processBatch();

      if (result.processedCount > 0 || result.rejectedCount > 0) {
        this.logger.log(
          `PendingReferenceWorker cycle complete: ${result.processedCount} processed, ${result.rejectedCount} rejected, ${result.pendingCount} rescheduled`,
        );
      }

      this.scheduleNextPoll(this.pollIntervalMs);
    } catch (err) {
      this.logger.error('Error during PendingReferenceWorker poll cycle', err);
      this.scheduleNextPoll(this.pollIntervalMs);
    }
  }
}
