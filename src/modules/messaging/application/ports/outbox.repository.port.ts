import { EventPublisherPort, IntegrationEventEnvelope } from './event-publisher.port';

export const OUTBOX_REPOSITORY_PORT = 'OUTBOX_REPOSITORY_PORT';

export interface OutboxRecord {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: IntegrationEventEnvelope;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
  createdAt: Date;
}

export interface ProcessBatchResult {
  publishedCount: number;
  failedCount: number;
  remainingCandidates: boolean;
}

export interface OutboxRepositoryPort {
  processBatchWithLock(
    batchSize: number,
    publisher: EventPublisherPort,
    baseBackoffSeconds?: number,
    now?: Date,
  ): Promise<ProcessBatchResult>;

  countPending(): Promise<number>;

  findById(id: string): Promise<OutboxRecord | null>;
}
