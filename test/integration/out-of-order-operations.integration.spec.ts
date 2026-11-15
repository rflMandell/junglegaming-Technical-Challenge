import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { EntityManager } from '@mikro-orm/postgresql';
import { AppModule } from '../../src/app.module';
import { CreateWalletUseCase } from '../../src/modules/wallet/application/use-cases/create-wallet.use-case';
import { GetWalletUseCase } from '../../src/modules/wallet/application/use-cases/get-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '../../src/modules/wagering/application/use-cases/process-wager-transaction.use-case';
import { ReprocessPendingReferenceUseCase } from '../../src/modules/wagering/application/use-cases/reprocess-pending-reference.use-case';
import { PendingReferenceWorker } from '../../src/modules/wagering/infrastructure/workers/pending-reference.worker';
import { WagerTransactionKind } from '../../src/modules/wagering/domain/wager-transaction-kind.enum';
import { WagerTransactionStatus } from '../../src/modules/wagering/domain/wager-transaction-status.enum';
import { FailureCode } from '../../src/modules/wagering/domain/failure-code.enum';
import { WagerTransactionEntity } from '../../src/modules/wagering/infrastructure/wager-transaction.entity';
import { WalletLedgerEntryEntity } from '../../src/modules/ledger/infrastructure/wallet-ledger-entry.entity';
import { OutboxMessageEntity } from '../../src/modules/messaging/infrastructure/outbox-message.entity';
import { ENTITY_MANAGER_TOKEN } from '../../src/infrastructure/database/database.module';

describe('Out-of-Order Operations & Pending Reference Worker (Integration)', () => {
  let app: INestApplication;
  let createWalletUseCase: CreateWalletUseCase;
  let getWalletUseCase: GetWalletUseCase;
  let processWagerUseCase: ProcessWagerTransactionUseCase;
  let pendingWorker: PendingReferenceWorker;
  let em: EntityManager;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    createWalletUseCase = app.get(CreateWalletUseCase);
    getWalletUseCase = app.get(GetWalletUseCase);
    processWagerUseCase = app.get(ProcessWagerTransactionUseCase);
    pendingWorker = app.get(PendingReferenceWorker);
    em = app.get(ENTITY_MANAGER_TOKEN);
  });

  afterAll(async () => {
    if (pendingWorker) {
      await pendingWorker.stop();
    }
    if (app) {
      await app.close();
    }
  });

  it('should handle full out-of-order flow: REFUND arrives before BET, holds in PENDING_REFERENCE, and reprocesses when BET arrives', async () => {
    const playerId = uuidv7();
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const runId = uuidv7();
    const providerId = `provider-ooo-${runId}`;
    const betExtId = `ext-bet-${runId}`;
    const refundExtId = `ext-refund-${runId}`;
    const roundId = `round-${runId}`;

    // 1. REFUND arrives BEFORE the BET transaction exists
    const refundRes = await processWagerUseCase.execute({
      providerId,
      externalTransactionId: refundExtId,
      referenceExternalTransactionId: betExtId, // Does NOT exist yet!
      playerId,
      walletId: wallet.id,
      roundId,
      gameId: 'game-roulette',
      kind: WagerTransactionKind.Refund,
      money: { amount: '30.00', currency: 'BRL' },
    });

    // 2. Must not be discarded; persisted as PENDING_REFERENCE without mutating balance
    expect(refundRes.status).toBe(WagerTransactionStatus.PendingReference);
    const walletCheck1 = await getWalletUseCase.execute(wallet.id);
    expect(walletCheck1.balance.amount).toBe('100.00'); // Unchanged

    const fork = em.fork();
    const refundTx = await fork.findOne(WagerTransactionEntity, { id: refundRes.transactionId });
    expect(refundTx).not.toBeNull();
    expect(refundTx!.status).toBe(WagerTransactionStatus.PendingReference);
    expect(refundTx!.nextRetryAt).toBeDefined();

    // Verify Outbox recorded WagerTransactionPendingReference event
    const outboxPending = await fork.findOne(OutboxMessageEntity, {
      aggregateId: refundRes.transactionId,
      eventType: 'WagerTransactionPendingReference',
    });
    expect(outboxPending).not.toBeNull();

    // 3. Now the BET arrives and is processed
    const betRes = await processWagerUseCase.execute({
      providerId,
      externalTransactionId: betExtId,
      playerId,
      walletId: wallet.id,
      roundId,
      gameId: 'game-roulette',
      kind: WagerTransactionKind.Bet,
      money: { amount: '30.00', currency: 'BRL' },
    });

    expect(betRes.status).toBe(WagerTransactionStatus.Processed);
    const walletCheck2 = await getWalletUseCase.execute(wallet.id);
    expect(walletCheck2.balance.amount).toBe('70.00'); // 100 - 30 = 70.00

    // 4. Worker executes a poll batch: discovers REFUND can now be resolved!
    const batchResult = await pendingWorker.processBatch();
    expect(batchResult.processedCount).toBeGreaterThanOrEqual(1);

    // 5. Verify REFUND transitioned to PROCESSED
    const freshFork = em.fork();
    const refundAfter = await freshFork.findOne(WagerTransactionEntity, { id: refundRes.transactionId });
    expect(refundAfter!.status).toBe(WagerTransactionStatus.Processed);
    expect(refundAfter!.referenceTransactionId).toBe(betRes.transactionId);

    // 6. Verify wallet balance was credited by the refund: 70 + 30 = 100.00
    const walletFinal = await getWalletUseCase.execute(wallet.id);
    expect(walletFinal.balance.amount).toBe('100.00');

    // 7. Verify ledger entries: exactly 1 DEBIT (bet) and 1 CREDIT (refund) besides opening
    const ledger = await freshFork.find(WalletLedgerEntryEntity, { walletId: wallet.id });
    const betLedger = ledger.find((l) => l.transactionId === betRes.transactionId);
    const refundLedger = ledger.find((l) => l.transactionId === refundRes.transactionId);

    expect(betLedger).toBeDefined();
    expect(betLedger!.direction).toBe('DEBIT');
    expect(betLedger!.amount).toBe('30.00');

    expect(refundLedger).toBeDefined();
    expect(refundLedger!.direction).toBe('CREDIT');
    expect(refundLedger!.amount).toBe('30.00');
  });

  it('should handle out-of-order ROLLBACK arriving before WIN and reversing it correctly', async () => {
    const playerId = uuidv7();
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '20.00', currency: 'BRL' },
    });

    const runId = uuidv7();
    const providerId = `provider-rb-${runId}`;
    const winExtId = `ext-win-${runId}`;
    const rollbackExtId = `ext-rollback-${runId}`;
    const roundId = `round-rb-${runId}`;

    // 1. ROLLBACK arrives before WIN exists
    const rbRes = await processWagerUseCase.execute({
      providerId,
      externalTransactionId: rollbackExtId,
      referenceExternalTransactionId: winExtId,
      playerId,
      walletId: wallet.id,
      roundId,
      gameId: 'game-slot',
      kind: WagerTransactionKind.Rollback,
      money: { amount: '50.00', currency: 'BRL' },
    });

    expect(rbRes.status).toBe(WagerTransactionStatus.PendingReference);

    // 2. WIN arrives and credits 50.00 (20 + 50 = 70.00)
    const winRes = await processWagerUseCase.execute({
      providerId,
      externalTransactionId: winExtId,
      playerId,
      walletId: wallet.id,
      roundId,
      gameId: 'game-slot',
      kind: WagerTransactionKind.Win,
      money: { amount: '50.00', currency: 'BRL' },
    });

    expect(winRes.status).toBe(WagerTransactionStatus.Processed);
    const walletAfterWin = await getWalletUseCase.execute(wallet.id);
    expect(walletAfterWin.balance.amount).toBe('70.00');

    // 3. Worker resolves pending ROLLBACK, reversing the WIN
    const batchResult = await pendingWorker.processBatch();
    expect(batchResult.processedCount).toBeGreaterThanOrEqual(1);

    const fork = em.fork();
    const rbAfter = await fork.findOne(WagerTransactionEntity, { id: rbRes.transactionId });
    expect(rbAfter!.status).toBe(WagerTransactionStatus.Processed);

    // Balance after rollback debits 50.00: 70 - 50 = 20.00
    const walletFinal = await getWalletUseCase.execute(wallet.id);
    expect(walletFinal.balance.amount).toBe('20.00');
  });

  it('should reschedule with exponential backoff when referenced transaction is still absent', async () => {
    const playerId = uuidv7();
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '50.00', currency: 'BRL' },
    });

    const runId = uuidv7();
    const providerId = `provider-missing-${runId}`;

    // Operation references a transaction that will never arrive
    const pendingRes = await processWagerUseCase.execute({
      providerId,
      externalTransactionId: `ext-orphan-${runId}`,
      referenceExternalTransactionId: `ext-non-existent-${runId}`,
      playerId,
      walletId: wallet.id,
      roundId: 'round-orphan',
      gameId: 'game-1',
      kind: WagerTransactionKind.Refund,
      money: { amount: '10.00', currency: 'BRL' },
    });

    expect(pendingRes.status).toBe(WagerTransactionStatus.PendingReference);

    // Worker poll attempt 1
    const now = new Date();
    await pendingWorker.processBatch(now);

    const fork = em.fork();
    const txAttempt1 = await fork.findOne(WagerTransactionEntity, { id: pendingRes.transactionId });
    expect(txAttempt1!.status).toBe(WagerTransactionStatus.PendingReference);
    expect(txAttempt1!.retryCount).toBeGreaterThanOrEqual(1);
    expect(txAttempt1!.nextRetryAt!.getTime()).toBeGreaterThan(now.getTime());
  });

  it('should reject with REFERENCE_NOT_FOUND when max retries or TTL is exhausted', async () => {
    const playerId = uuidv7();
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '50.00', currency: 'BRL' },
    });

    const runId = uuidv7();
    const providerId = `provider-exhaust-${runId}`;

    const pendingRes = await processWagerUseCase.execute({
      providerId,
      externalTransactionId: `ext-exhaust-${runId}`,
      referenceExternalTransactionId: `ext-never-found-${runId}`,
      playerId,
      walletId: wallet.id,
      roundId: 'round-exhaust',
      gameId: 'game-1',
      kind: WagerTransactionKind.Refund,
      money: { amount: '10.00', currency: 'BRL' },
    });

    // Simulate time past TTL (now + 301 seconds) and maxRetries reached
    const pastTtlTime = new Date(Date.now() + 350 * 1000);
    const batchResult = await pendingWorker.processBatch(pastTtlTime);
    expect(batchResult.rejectedCount).toBeGreaterThanOrEqual(1);

    const fork = em.fork();
    const exhaustedTx = await fork.findOne(WagerTransactionEntity, { id: pendingRes.transactionId });
    expect(exhaustedTx!.status).toBe(WagerTransactionStatus.Rejected);
    expect(exhaustedTx!.failureCode).toBe(FailureCode.ReferenceNotFound);

    // Verify Outbox recorded rejection event
    const outboxRejection = await fork.findOne(OutboxMessageEntity, {
      aggregateId: pendingRes.transactionId,
      eventType: 'WagerTransactionRejected',
    });
    expect(outboxRejection).not.toBeNull();
    expect((outboxRejection!.payload.data as any).failureCode).toBe(FailureCode.ReferenceNotFound);
  });

  it('should ensure reprocessing does NOT duplicate effects if called again', async () => {
    const playerId = uuidv7();
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const runId = uuidv7();
    const providerId = `provider-replay-${runId}`;
    const betExtId = `ext-bet-r-${runId}`;
    const refundExtId = `ext-refund-r-${runId}`;
    const roundId = `round-r-${runId}`;

    // REFUND arrives first
    const refundRes = await processWagerUseCase.execute({
      providerId,
      externalTransactionId: refundExtId,
      referenceExternalTransactionId: betExtId,
      playerId,
      walletId: wallet.id,
      roundId,
      gameId: 'game-1',
      kind: WagerTransactionKind.Refund,
      money: { amount: '40.00', currency: 'BRL' },
    });

    // BET arrives
    await processWagerUseCase.execute({
      providerId,
      externalTransactionId: betExtId,
      playerId,
      walletId: wallet.id,
      roundId,
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: { amount: '40.00', currency: 'BRL' },
    });

    // First batch: processes REFUND
    const result1 = await pendingWorker.processBatch();
    expect(result1.processedCount).toBeGreaterThanOrEqual(1);

    const walletAfterFirst = await getWalletUseCase.execute(wallet.id);
    expect(walletAfterFirst.balance.amount).toBe('100.00');

    // Second batch immediately after: REFUND is already PROCESSED, must do NOTHING
    const result2 = await pendingWorker.processBatch();
    expect(result2.processedCount).toBe(0);

    const walletAfterSecond = await getWalletUseCase.execute(wallet.id);
    expect(walletAfterSecond.balance.amount).toBe('100.00'); // Strictly preserved!
  });
});
