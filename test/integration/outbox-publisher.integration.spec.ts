import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { EntityManager } from '@mikro-orm/postgresql';
import { AppModule } from '../../src/app.module';
import { CreateWalletUseCase } from '../../src/modules/wallet/application/use-cases/create-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '../../src/modules/wagering/application/use-cases/process-wager-transaction.use-case';
import { WagerTransactionKind } from '../../src/modules/wagering/domain/wager-transaction-kind.enum';
import { WagerTransactionStatus } from '../../src/modules/wagering/domain/wager-transaction-status.enum';
import { OutboxPublisherWorker } from '../../src/modules/messaging/infrastructure/outbox-publisher.worker';
import { OutboxRepository } from '../../src/modules/messaging/infrastructure/outbox.repository';
import { EventPublisherAdapter } from '../../src/modules/messaging/infrastructure/event-publisher.adapter';
import { ENTITY_MANAGER_TOKEN } from '../../src/infrastructure/database/database.module';
import { OutboxMessageEntity } from '../../src/modules/messaging/infrastructure/outbox-message.entity';
import { IntegrationEventEnvelope } from '../../src/modules/messaging/application/ports/event-publisher.port';

describe('Transactional Outbox Pattern & Publisher Worker (Integration)', () => {
  let app: INestApplication;
  let createWalletUseCase: CreateWalletUseCase;
  let processWagerUseCase: ProcessWagerTransactionUseCase;
  let outboxWorker: OutboxPublisherWorker;
  let outboxRepository: OutboxRepository;
  let eventPublisher: EventPublisherAdapter;
  let em: EntityManager;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    createWalletUseCase = app.get(CreateWalletUseCase);
    processWagerUseCase = app.get(ProcessWagerTransactionUseCase);
    outboxWorker = app.get(OutboxPublisherWorker);
    outboxRepository = app.get(OutboxRepository);
    eventPublisher = app.get(EventPublisherAdapter);
    em = app.get(ENTITY_MANAGER_TOKEN);
  });

  afterAll(async () => {
    if (outboxWorker) {
      await outboxWorker.stop();
    }
    if (app) {
      await app.close();
    }
  });

  it('should persist integration events atomically with financial mutations in the same transaction', async () => {
    const playerId = uuidv7();
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const runId = uuidv7();
    const correlationId = uuidv7();
    const result = await processWagerUseCase.execute(
      {
        providerId: `prov-${runId}`,
        externalTransactionId: `ext-${runId}`,
        playerId,
        walletId: wallet.id,
        roundId: 'round-outbox-1',
        gameId: 'game-slot-1',
        kind: WagerTransactionKind.Bet,
        money: { amount: '25.00', currency: 'BRL' },
      },
      { correlationId },
    );

    expect(result.status).toBe(WagerTransactionStatus.Processed);

    // Query outbox_messages directly from PostgreSQL
    const fork = em.fork();
    const outboxEvents = await fork.find(
      OutboxMessageEntity,
      {
        $or: [
          { aggregateId: result.transactionId },
          { aggregateId: wallet.id },
        ],
      },
      { orderBy: { occurredAt: 'ASC' } },
    );

    expect(outboxEvents.length).toBeGreaterThanOrEqual(2);

    const processedEvent = outboxEvents.find(
      (e) => e.eventType === 'WagerTransactionProcessed' && (e.payload.data as any).transactionId === result.transactionId,
    );
    const balanceEvent = outboxEvents.find(
      (e) => e.eventType === 'WalletBalanceChanged' && (e.payload.data as any).transactionId === result.transactionId,
    );

    expect(processedEvent).toBeDefined();
    expect(balanceEvent).toBeDefined();

    expect(processedEvent!.publishedAt).toBeFalsy();
    expect(processedEvent!.attempts).toBe(0);
    expect(processedEvent!.payload.correlationId).toBe(correlationId);
    expect((processedEvent!.payload.data as any).money.amount).toBe('25.00');

    expect(balanceEvent!.publishedAt).toBeFalsy();
    expect((balanceEvent!.payload.data as any).balanceAfter.amount).toBe('75.00');
  });

  it('should fetch pending outbox events, publish via worker, and mark published_at', async () => {
    const receivedEvents: IntegrationEventEnvelope[] = [];
    const unsubscribe = eventPublisher.subscribe((event) => {
      receivedEvents.push(event);
    });

    const pendingBefore = await outboxRepository.countPending();
    expect(pendingBefore).toBeGreaterThanOrEqual(2);

    // Run one processing batch
    const batchResult = await outboxWorker.processBatch(50);
    expect(batchResult.publishedCount).toBeGreaterThanOrEqual(2);

    // Verify events were dispatched to subscribers
    expect(receivedEvents.length).toBeGreaterThanOrEqual(2);

    // Verify all processed events now have published_at timestamp
    for (const event of receivedEvents) {
      const record = await outboxRepository.findById(event.eventId);
      if (record) {
        expect(record.publishedAt).toBeDefined();
        expect(record.publishedAt).toBeInstanceOf(Date);
      }
    }

    unsubscribe();
  });

  it('should allow multiple concurrent publisher instances to process disjoint batches without lock collisions (FOR UPDATE SKIP LOCKED)', async () => {
    // Seed 10 new outbox events directly
    const seededIds: string[] = [];
    const fork = em.fork();

    await fork.transactional(async (tem) => {
      for (let i = 0; i < 10; i++) {
        const id = uuidv7();
        seededIds.push(id);
        const entity = new OutboxMessageEntity();
        entity.id = id;
        entity.aggregateId = uuidv7();
        entity.eventType = 'TestConcurrentEvent';
        entity.payload = {
          eventId: id,
          eventType: 'TestConcurrentEvent',
          version: 1,
          aggregateId: entity.aggregateId,
          correlationId: uuidv7(),
          occurredAt: new Date().toISOString(),
          data: { index: i },
        };
        entity.occurredAt = new Date();
        entity.attempts = 0;
        tem.persist(entity);
      }
      await tem.flush();
    });

    const receivedByWorkerA: string[] = [];
    const receivedByWorkerB: string[] = [];

    // Worker A publisher
    const publisherA: EventPublisherAdapter = new EventPublisherAdapter();
    publisherA.subscribe((e) => {
      receivedByWorkerA.push(e.eventId);
    });

    // Worker B publisher
    const publisherB: EventPublisherAdapter = new EventPublisherAdapter();
    publisherB.subscribe((e) => {
      receivedByWorkerB.push(e.eventId);
    });

    // Execute 2 concurrent batches in parallel over the same outbox table
    const [resultA, resultB] = await Promise.all([
      outboxRepository.processBatchWithLock(5, publisherA),
      outboxRepository.processBatchWithLock(5, publisherB),
    ]);

    expect(resultA.publishedCount).toBe(5);
    expect(resultB.publishedCount).toBe(5);

    // Verify disjoint sets: Worker A and Worker B must NOT have processed the same event
    const intersection = receivedByWorkerA.filter((id) => receivedByWorkerB.includes(id));
    expect(intersection).toHaveLength(0);

    const totalProcessed = [...receivedByWorkerA, ...receivedByWorkerB];
    expect(totalProcessed).toHaveLength(10);
  });

  it('should handle transient publication failures with exponential backoff and retry scheduling', async () => {
    const failedEventId = uuidv7();
    const fork = em.fork();

    await fork.transactional(async (tem) => {
      const entity = new OutboxMessageEntity();
      entity.id = failedEventId;
      entity.aggregateId = uuidv7();
      entity.eventType = 'TransientFailingEvent';
      entity.payload = {
        eventId: failedEventId,
        eventType: 'TransientFailingEvent',
        version: 1,
        aggregateId: entity.aggregateId,
        correlationId: uuidv7(),
        occurredAt: new Date().toISOString(),
        data: {},
      };
      entity.occurredAt = new Date(0); // Oldest timestamp guarantees selection in FIFO batch
      entity.attempts = 0;
      tem.persist(entity);
      await tem.flush();
    });

    // Configure simulated failure for this specific event
    eventPublisher.simulateFailureFor((e) => e.eventId === failedEventId);

    const now = new Date();
    // Process batch: publication fails
    const result = await outboxRepository.processBatchWithLock(10, eventPublisher, 2, now);
    expect(result.failedCount).toBeGreaterThanOrEqual(1);

    // Verify record state in database: attempts incremented, next_attempt_at in future
    const record = await outboxRepository.findById(failedEventId);
    expect(record).not.toBeNull();
    expect(record!.publishedAt).toBeFalsy();
    expect(record!.attempts).toBe(1);
    expect(record!.nextAttemptAt).toBeDefined();
    // Backoff = 2^1 * 2 = 4 seconds
    expect(record!.nextAttemptAt!.getTime()).toBeGreaterThan(now.getTime());

    // Immediate subsequent batch run at 'now' should SKIP this message because nextAttemptAt > now
    await outboxRepository.processBatchWithLock(10, eventPublisher, 2, now);
    const skippedRecord = await outboxRepository.findById(failedEventId);
    expect(skippedRecord!.publishedAt).toBeFalsy();
    expect(skippedRecord!.attempts).toBe(1);

    // Advance simulated time past nextAttemptAt and remove failure simulation
    eventPublisher.simulateFailureFor(undefined);
    const futureTime = new Date(record!.nextAttemptAt!.getTime() + 1000);

    const retryRun = await outboxRepository.processBatchWithLock(10, eventPublisher, 2, futureTime);
    expect(retryRun.publishedCount).toBeGreaterThanOrEqual(1);

    const finalRecord = await outboxRepository.findById(failedEventId);
    expect(finalRecord!.publishedAt).toBeDefined();
  });

  it('should verify crash recovery scenario and downstream idempotent consumer deduplication', async () => {
    // Downstream consumer state: maintains set of processed eventIds
    const downstreamProcessedEventIds = new Set<string>();
    let downstreamExecutionCount = 0;

    const downstreamConsumer = (event: IntegrationEventEnvelope) => {
      if (downstreamProcessedEventIds.has(event.eventId)) {
        // Idempotent duplicate: ignore cleanly
        return;
      }
      downstreamProcessedEventIds.add(event.eventId);
      downstreamExecutionCount++;
    };

    const duplicateEvent: IntegrationEventEnvelope = {
      eventId: uuidv7(),
      eventType: 'WalletBalanceChanged',
      version: 1,
      aggregateId: uuidv7(),
      correlationId: uuidv7(),
      occurredAt: new Date().toISOString(),
      data: { amount: '50.00' },
    };

    // First delivery (e.g. initial outbox publication)
    downstreamConsumer(duplicateEvent);
    expect(downstreamExecutionCount).toBe(1);

    // Crash recovery scenario: publisher died before commit, another instance redelivers
    downstreamConsumer(duplicateEvent);
    expect(downstreamExecutionCount).toBe(1); // Idempotent: NOT executed twice!
  });
});
