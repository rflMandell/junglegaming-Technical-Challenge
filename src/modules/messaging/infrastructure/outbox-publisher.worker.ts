import {
  Injectable,
  Inject,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import {
  OUTBOX_REPOSITORY_PORT,
  type OutboxRepositoryPort,
  type ProcessBatchResult,
} from '../application/ports/outbox.repository.port';
import {
  EVENT_PUBLISHER_PORT,
  type EventPublisherPort,
} from '../application/ports/event-publisher.port';

@Injectable()
export class OutboxPublisherWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisherWorker.name);
  private isRunning = false;
  private timer: Timer | null = null;
  private activeExecutionPromise: Promise<void> | null = null;

  public pollIntervalMs: number;
  public batchSize: number;
  public baseBackoffSeconds = 2;

  constructor(
    @Inject(OUTBOX_REPOSITORY_PORT)
    private readonly outboxRepository: OutboxRepositoryPort,
    @Inject(EVENT_PUBLISHER_PORT)
    private readonly eventPublisher: EventPublisherPort,
  ) {
    this.pollIntervalMs = Number(process.env.OUTBOX_POLL_INTERVAL_MS) || 1000;
    this.batchSize = Number(process.env.OUTBOX_BATCH_SIZE) || 50;
  }

  async onModuleInit() {
    const autoStart = process.env.OUTBOX_WORKER_AUTO_START === 'true';
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
      `Starting OutboxPublisherWorker [interval=${this.pollIntervalMs}ms, batchSize=${this.batchSize}]`,
    );
    this.scheduleNextPoll(100); // Kickoff shortly after start
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.logger.log('Gracefully stopping OutboxPublisherWorker...');
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

    this.logger.log('OutboxPublisherWorker stopped cleanly.');
  }

  public async processBatch(batchSize = this.batchSize): Promise<ProcessBatchResult> {
    return await this.outboxRepository.processBatchWithLock(
      batchSize,
      this.eventPublisher,
      this.baseBackoffSeconds,
    );
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

      if (result.publishedCount > 0 || result.failedCount > 0) {
        this.logger.debug(
          `Outbox poll cycle complete: ${result.publishedCount} published, ${result.failedCount} failed`,
        );
      }

      // If full batch was processed, immediately process next batch to drain backlog quickly
      const nextDelay = result.remainingCandidates ? 10 : this.pollIntervalMs;
      this.scheduleNextPoll(nextDelay);
    } catch (err) {
      this.logger.error('Error during Outbox poll cycle', err);
      this.scheduleNextPoll(this.pollIntervalMs);
    }
  }
}
