import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { v7 as uuidv7 } from 'uuid';
import { AppModule } from '../../src/app.module';
import { CreateWalletUseCase } from '../../src/modules/wallet/application/use-cases/create-wallet.use-case';
import { DebitWalletUseCase } from '../../src/modules/wallet/application/use-cases/debit-wallet.use-case';
import { CreditWalletUseCase } from '../../src/modules/wallet/application/use-cases/credit-wallet.use-case';
import { ReconcileWalletUseCase } from '../../src/modules/reconciliation/application/use-cases/reconcile-wallet.use-case';
import { WalletNotFoundError } from '../../src/modules/wallet/domain/wallet.errors';
import { Money } from '../../src/shared/domain/value-objects/money.value-object';
import { ENTITY_MANAGER_TOKEN } from '../../src/infrastructure/database/database.module';

describe('Financial Reconciliation Module (Integration)', () => {
  let app: INestApplication;
  let createWalletUseCase: CreateWalletUseCase;
  let debitWalletUseCase: DebitWalletUseCase;
  let creditWalletUseCase: CreditWalletUseCase;
  let reconcileWalletUseCase: ReconcileWalletUseCase;
  let em: EntityManager;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    await app.listen(0);

    const port = (app.getHttpServer().address() as any).port;
    baseUrl = `http://localhost:${port}`;

    createWalletUseCase = app.get(CreateWalletUseCase);
    debitWalletUseCase = app.get(DebitWalletUseCase);
    creditWalletUseCase = app.get(CreditWalletUseCase);
    reconcileWalletUseCase = app.get(ReconcileWalletUseCase);
    em = app.get<EntityManager>(ENTITY_MANAGER_TOKEN);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  describe('Consistent Wallet Scenarios', () => {
    it('should reconcile a wallet with zero balance and zero ledger entries', async () => {
      const playerId = uuidv7();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '0.00', currency: 'BRL' },
      });

      const report = await reconcileWalletUseCase.execute(wallet.id);

      expect(report.walletId).toBe(wallet.id);
      expect(report.consistent).toBe(true);
      expect(report.storedBalance.amount).toBe('0.00');
      expect(report.calculatedBalance.amount).toBe('0.00');
      expect(report.difference.amount).toBe('0.00');
      expect(report.checkedEntries).toBe(0);
    });

    it('should reconcile a wallet with multiple credits and debits accurately', async () => {
      const playerId = uuidv7();
      // 1. Initial balance 200.00 BRL (opening entry: 1)
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '200.00', currency: 'BRL' },
      });

      // 2. Debit 50.00 BRL -> 150.00 BRL (entry: 2)
      await debitWalletUseCase.execute({
        walletId: wallet.id,
        amount: Money.from({ amount: '50.00', currency: 'BRL' }),
        transactionId: uuidv7(),
      });

      // 3. Credit 120.00 BRL -> 270.00 BRL (entry: 3)
      await creditWalletUseCase.execute({
        walletId: wallet.id,
        amount: Money.from({ amount: '120.00', currency: 'BRL' }),
        transactionId: uuidv7(),
      });

      // 4. Debit 30.00 BRL -> 240.00 BRL (entry: 4)
      await debitWalletUseCase.execute({
        walletId: wallet.id,
        amount: Money.from({ amount: '30.00', currency: 'BRL' }),
        transactionId: uuidv7(),
      });

      const report = await reconcileWalletUseCase.execute(wallet.id);

      expect(report.walletId).toBe(wallet.id);
      expect(report.consistent).toBe(true);
      expect(report.storedBalance.amount).toBe('240.00');
      expect(report.calculatedBalance.amount).toBe('240.00');
      expect(report.difference.amount).toBe('0.00');
      expect(report.checkedEntries).toBe(4);
    });
  });

  describe('Divergence Detection and Invariant Protection', () => {
    it('should detect positive divergence (stored > calculated) and NEVER silently correct it', async () => {
      const playerId = uuidv7();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      // Debit 20.00 BRL -> Stored & Ledger = 80.00 BRL (2 entries)
      await debitWalletUseCase.execute({
        walletId: wallet.id,
        amount: Money.from({ amount: '20.00', currency: 'BRL' }),
        transactionId: uuidv7(),
      });

      // Artificially tamper with the wallet balance directly in the database
      const fork = em.fork();
      await fork.execute(
        `UPDATE wallets SET balance = 150.00, updated_at = NOW() WHERE id = ?`,
        [wallet.id],
      );

      // Execute reconciliation
      const report = await reconcileWalletUseCase.execute(wallet.id);

      expect(report.walletId).toBe(wallet.id);
      expect(report.consistent).toBe(false);
      expect(report.storedBalance.amount).toBe('150.00');
      expect(report.calculatedBalance.amount).toBe('80.00');
      expect(report.difference.amount).toBe('70.00');
      expect(report.checkedEntries).toBe(2);

      // Verify that NO SILENT CORRECTION occurred: balance in database remains 150.00
      const verifyFork = em.fork();
      const rawWalletResult: any[] = await verifyFork.execute(
        `SELECT balance FROM wallets WHERE id = ?`,
        [wallet.id],
      );
      expect(rawWalletResult[0].balance).toBe('150.00');
    });

    it('should detect negative divergence (stored < calculated) accurately', async () => {
      const playerId = uuidv7();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '250.00', currency: 'BRL' },
      });

      // Artificially tamper balance to 100.00 (while ledger sum is 250.00)
      const fork = em.fork();
      await fork.execute(
        `UPDATE wallets SET balance = 100.00, updated_at = NOW() WHERE id = ?`,
        [wallet.id],
      );

      const report = await reconcileWalletUseCase.execute(wallet.id);

      expect(report.consistent).toBe(false);
      expect(report.storedBalance.amount).toBe('100.00');
      expect(report.calculatedBalance.amount).toBe('250.00');
      expect(report.difference.amount).toBe('-150.00');
      expect(report.checkedEntries).toBe(1);

      // Verify no silent repair
      const verifyFork = em.fork();
      const rawWalletResult: any[] = await verifyFork.execute(
        `SELECT balance FROM wallets WHERE id = ?`,
        [wallet.id],
      );
      expect(rawWalletResult[0].balance).toBe('100.00');
    });
  });

  describe('Multi-page Ledger Pagination Audit', () => {
    it('should accurately traverse paginated ledger entries when total entries exceed single page limit', async () => {
      const playerId = uuidv7();
      // 1 initial entry: 100.00 BRL
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      // Generate 105 credits of 1.00 BRL sequentially -> 105 entries
      for (let i = 0; i < 105; i++) {
        await creditWalletUseCase.execute({
          walletId: wallet.id,
          amount: Money.from({ amount: '1.00', currency: 'BRL' }),
          transactionId: uuidv7(),
        });
      }

      // Total entries: 1 + 105 = 106 entries (> 100 limit per page)
      // Total balance: 100.00 + 105.00 = 205.00 BRL
      const report = await reconcileWalletUseCase.execute(wallet.id);

      expect(report.consistent).toBe(true);
      expect(report.storedBalance.amount).toBe('205.00');
      expect(report.calculatedBalance.amount).toBe('205.00');
      expect(report.difference.amount).toBe('0.00');
      expect(report.checkedEntries).toBe(106);
    });
  });

  describe('HTTP API Endpoints', () => {
    it('POST /wallets/:walletId/reconciliation should return structured reconciliation report', async () => {
      const playerId = uuidv7();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '75.50', currency: 'BRL' },
      });

      const res = await fetch(`${baseUrl}/wallets/${wallet.id}/reconciliation`, {
        method: 'POST',
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.walletId).toBe(wallet.id);
      expect(data.consistent).toBe(true);
      expect(data.storedBalance).toEqual({ amount: '75.50', currency: 'BRL' });
      expect(data.calculatedBalance).toEqual({ amount: '75.50', currency: 'BRL' });
      expect(data.difference).toEqual({ amount: '0.00', currency: 'BRL' });
      expect(data.checkedEntries).toBe(1);
    });

    it('GET /wallets/:walletId/reconciliation should return the same audit report', async () => {
      const playerId = uuidv7();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '50.00', currency: 'BRL' },
      });

      const res = await fetch(`${baseUrl}/wallets/${wallet.id}/reconciliation`, {
        method: 'GET',
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.walletId).toBe(wallet.id);
      expect(data.consistent).toBe(true);
      expect(data.storedBalance.amount).toBe('50.00');
      expect(data.calculatedBalance.amount).toBe('50.00');
      expect(data.difference.amount).toBe('0.00');
    });

    it('POST /wallets/:walletId/reconciliation should return 404 when wallet does not exist', async () => {
      const nonExistentWalletId = uuidv7();
      const res = await fetch(`${baseUrl}/wallets/${nonExistentWalletId}/reconciliation`, {
        method: 'POST',
      });

      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.statusCode).toBe(404);
    });

    it('should throw WalletNotFoundError when use case is called directly with non-existent wallet', async () => {
      const nonExistentWalletId = uuidv7();
      expect(reconcileWalletUseCase.execute(nonExistentWalletId)).rejects.toThrow(WalletNotFoundError);
    });
  });
});
