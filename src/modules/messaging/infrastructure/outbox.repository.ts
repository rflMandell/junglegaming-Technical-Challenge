import { Injectable, Inject } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import {
  OutboxRepositoryPort,
  OutboxRecord,
  ProcessBatchResult,
} from '../application/ports/outbox.repository.port';
import {
  EventPublisherPort,
  IntegrationEventEnvelope,
} from '../application/ports/event-publisher.port';
import { ENTITY_MANAGER_TOKEN } from '../../../infrastructure/database/database.module';

@Injectable()
export class OutboxRepository implements OutboxRepositoryPort {
  constructor(
    @Inject(ENTITY_MANAGER_TOKEN)
    private readonly em: EntityManager,
  ) {}

  async processBatchWithLock(
    batchSize: number,
    publisher: EventPublisherPort,
    baseBackoffSeconds = 2,
    now: Date = new Date(),
  ): Promise<ProcessBatchResult> {
    return await this.em.transactional(async (em) => {
      // 1. Concurrently fetch and lock pending outbox messages using PostgreSQL FOR UPDATE SKIP LOCKED
      const rows: any[] = await em.execute(
        `SELECT id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at, created_at
         FROM outbox_messages
         WHERE published_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY occurred_at ASC
         LIMIT ?
         FOR UPDATE SKIP LOCKED`,
        [now, batchSize],
      );

      if (!rows || rows.length === 0) {
        return {
          publishedCount: 0,
          failedCount: 0,
          remainingCandidates: false,
        };
      }

      let publishedCount = 0;
      let failedCount = 0;

      for (const row of rows) {
        const payload: IntegrationEventEnvelope =
          typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;

        try {
          await publisher.publish(payload);
          await em.execute(
            `UPDATE outbox_messages SET published_at = NOW() WHERE id = ?`,
            [row.id],
          );
          publishedCount++;
        } catch {
          const attempts = Number(row.attempts || 0) + 1;
          const delaySeconds = Math.min(300, Math.pow(2, attempts) * baseBackoffSeconds);
          const nextAttemptAt = new Date(now.getTime() + delaySeconds * 1000);
          await em.execute(
            `UPDATE outbox_messages SET attempts = ?, next_attempt_at = ? WHERE id = ?`,
            [attempts, nextAttemptAt, row.id],
          );
          failedCount++;
        }
      }

      return {
        publishedCount,
        failedCount,
        remainingCandidates: rows.length === batchSize,
      };
    });
  }

  async countPending(): Promise<number> {
    const res: any[] = await this.em.execute(
      `SELECT count(*) as count FROM outbox_messages WHERE published_at IS NULL`,
    );
    return Number(res[0]?.count || 0);
  }

  async findById(id: string): Promise<OutboxRecord | null> {
    const res: any[] = await this.em.execute(
      `SELECT id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at, created_at
       FROM outbox_messages
       WHERE id = ?`,
      [id],
    );

    if (!res || res.length === 0) {
      return null;
    }

    const row = res[0];
    return {
      id: row.id,
      aggregateId: row.aggregate_id,
      eventType: row.event_type,
      payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
      occurredAt: new Date(row.occurred_at),
      attempts: Number(row.attempts || 0),
      nextAttemptAt: row.next_attempt_at ? new Date(row.next_attempt_at) : undefined,
      publishedAt: row.published_at ? new Date(row.published_at) : undefined,
      createdAt: new Date(row.created_at),
    };
  }
}
