import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { AppModule } from '../../src/app.module';
import { CreateWalletUseCase } from '../../src/modules/wallet/application/use-cases/create-wallet.use-case';
import { GetWalletUseCase } from '../../src/modules/wallet/application/use-cases/get-wallet.use-case';
import { DebitWalletUseCase } from '../../src/modules/wallet/application/use-cases/debit-wallet.use-case';
import { CreditWalletUseCase } from '../../src/modules/wallet/application/use-cases/credit-wallet.use-case';
import { GetWalletLedgerUseCase } from '../../src/modules/ledger/application/use-cases/get-wallet-ledger.use-case';
import { WalletAlreadyExistsError, WalletNotFoundError } from '../../src/modules/wallet/domain/wallet.errors';
import { InsufficientFundsError } from '../../src/shared/domain/errors/domain.error';
import { Money } from '../../src/shared/domain/value-objects/money.value-object';
import { LedgerDirection } from '../../src/modules/ledger/domain/ledger-direction.enum';

describe('Wallet & Ledger Module (Integration)', () => {
  let app: INestApplication;
  let createWalletUseCase: CreateWalletUseCase;
  let getWalletUseCase: GetWalletUseCase;
  let debitWalletUseCase: DebitWalletUseCase;
  let creditWalletUseCase: CreditWalletUseCase;
  let getWalletLedgerUseCase: GetWalletLedgerUseCase;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    createWalletUseCase = app.get(CreateWalletUseCase);
    getWalletUseCase = app.get(GetWalletUseCase);
    debitWalletUseCase = app.get(DebitWalletUseCase);
    creditWalletUseCase = app.get(CreditWalletUseCase);
    getWalletLedgerUseCase = app.get(GetWalletLedgerUseCase);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  describe('Wallet Creation and Querying', () => {
    it('should create wallet with zero balance and no ledger entries', async () => {
      const playerId = uuidv7();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '0.00', currency: 'BRL' },
      });

      expect(wallet.id).toBeDefined();
      expect(wallet.playerId).toBe(playerId);
      expect(wallet.balance.amount).toBe('0.00');
      expect(wallet.version).toBe(1);

      const ledger = await getWalletLedgerUseCase.execute({ walletId: wallet.id });
      expect(ledger.items.length).toBe(0);
      expect(ledger.hasMore).toBe(false);
    });

    it('should create wallet with initial balance 1000.00, generating OPENING transaction and ledger entry', async () => {
      const playerId = uuidv7();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '1000.00', currency: 'BRL' },
      });

      expect(wallet.balance.amount).toBe('1000.00');
      expect(wallet.version).toBe(1);

      // Verify ledger has opening entry
      const ledger = await getWalletLedgerUseCase.execute({ walletId: wallet.id });
      expect(ledger.items.length).toBe(1);
      expect(ledger.items[0].direction).toBe(LedgerDirection.Credit);
      expect(ledger.items[0].money.amount).toBe('1000.00');
      expect(ledger.items[0].balanceBefore.amount).toBe('0.00');
      expect(ledger.items[0].balanceAfter.amount).toBe('1000.00');
    });

    it('should reject creating duplicate wallet for same player and currency', async () => {
      const playerId = uuidv7();
      await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      expect(
        createWalletUseCase.execute({
          playerId,
          initialBalance: { amount: '50.00', currency: 'BRL' },
        }),
      ).rejects.toThrow(WalletAlreadyExistsError);
    });

    it('should query existing wallet by ID', async () => {
      const playerId = uuidv7();
      const created = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '250.00', currency: 'BRL' },
      });

      const retrieved = await getWalletUseCase.execute(created.id);
      expect(retrieved.id).toBe(created.id);
      expect(retrieved.balance.amount).toBe('250.00');
    });

    it('should throw WalletNotFoundError for non-existent wallet', async () => {
      expect(getWalletUseCase.execute(uuidv7())).rejects.toThrow(WalletNotFoundError);
    });
  });

  describe('Debit & Credit Operations', () => {
    it('should debit wallet, update balance, increment version, and record ledger entry', async () => {
      const playerId = uuidv7();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '500.00', currency: 'BRL' },
      });

      const txId = uuidv7();
      const { wallet: debitedWallet, entry } = await debitWalletUseCase.execute({
        walletId: wallet.id,
        amount: Money.from({ amount: '150.00', currency: 'BRL' }),
        transactionId: txId,
      });

      expect(debitedWallet.balance.toString()).toBe('350.00');
      expect(debitedWallet.version).toBe(2);
      expect(entry.direction).toBe(LedgerDirection.Debit);
      expect(entry.balanceBefore.toString()).toBe('500.00');
      expect(entry.balanceAfter.toString()).toBe('350.00');

      // Verify persisted state matches
      const fetched = await getWalletUseCase.execute(wallet.id);
      expect(fetched.balance.amount).toBe('350.00');
      expect(fetched.version).toBe(2);
    });

    it('should reject debit when funds are insufficient without modifying balance or version', async () => {
      const playerId = uuidv7();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      expect(
        debitWalletUseCase.execute({
          walletId: wallet.id,
          amount: Money.from({ amount: '150.00', currency: 'BRL' }),
          transactionId: uuidv7(),
        }),
      ).rejects.toThrow(InsufficientFundsError);

      const unchanged = await getWalletUseCase.execute(wallet.id);
      expect(unchanged.balance.amount).toBe('100.00');
      expect(unchanged.version).toBe(1);
    });

    it('should credit wallet, update balance, increment version, and record ledger entry', async () => {
      const playerId = uuidv7();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const txId = uuidv7();
      const { wallet: creditedWallet, entry } = await creditWalletUseCase.execute({
        walletId: wallet.id,
        amount: Money.from({ amount: '300.00', currency: 'BRL' }),
        transactionId: txId,
      });

      expect(creditedWallet.balance.toString()).toBe('400.00');
      expect(creditedWallet.version).toBe(2);
      expect(entry.direction).toBe(LedgerDirection.Credit);
      expect(entry.balanceBefore.toString()).toBe('100.00');
      expect(entry.balanceAfter.toString()).toBe('400.00');

      const fetched = await getWalletUseCase.execute(wallet.id);
      expect(fetched.balance.amount).toBe('400.00');
      expect(fetched.version).toBe(2);
    });
  });

  describe('Stable Cursor Pagination & Financial Ledger Integrity', () => {
    it('should paginate ledger entries with stable opaque cursor and verify balance invariant', async () => {
      const playerId = uuidv7();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      // Perform 5 successive operations (1 opening + 5 ops = 6 ledger entries)
      await creditWalletUseCase.execute({
        walletId: wallet.id,
        amount: Money.from({ amount: '50.00', currency: 'BRL' }),
        transactionId: uuidv7(),
      });
      await debitWalletUseCase.execute({
        walletId: wallet.id,
        amount: Money.from({ amount: '30.00', currency: 'BRL' }),
        transactionId: uuidv7(),
      });
      await creditWalletUseCase.execute({
        walletId: wallet.id,
        amount: Money.from({ amount: '70.00', currency: 'BRL' }),
        transactionId: uuidv7(),
      });
      await debitWalletUseCase.execute({
        walletId: wallet.id,
        amount: Money.from({ amount: '40.00', currency: 'BRL' }),
        transactionId: uuidv7(),
      });
      await creditWalletUseCase.execute({
        walletId: wallet.id,
        amount: Money.from({ amount: '20.00', currency: 'BRL' }),
        transactionId: uuidv7(),
      });

      // Expected final balance: 100 + 50 - 30 + 70 - 40 + 20 = 170.00
      const currentWallet = await getWalletUseCase.execute(wallet.id);
      expect(currentWallet.balance.amount).toBe('170.00');

      // Fetch page 1 (limit 2)
      const page1 = await getWalletLedgerUseCase.execute({
        walletId: wallet.id,
        limit: 2,
      });
      expect(page1.items.length).toBe(2);
      expect(page1.hasMore).toBe(true);
      expect(page1.nextCursor).toBeDefined();

      // Fetch page 2 (limit 2) using nextCursor
      const page2 = await getWalletLedgerUseCase.execute({
        walletId: wallet.id,
        cursor: page1.nextCursor,
        limit: 2,
      });
      expect(page2.items.length).toBe(2);
      expect(page2.hasMore).toBe(true);
      expect(page2.nextCursor).toBeDefined();

      // Ensure no items overlap between page 1 and page 2
      const page1Ids = page1.items.map((i) => i.id);
      const page2Ids = page2.items.map((i) => i.id);
      expect(page1Ids.some((id) => page2Ids.includes(id))).toBe(false);

      // Fetch remaining page 3 (limit 10)
      const page3 = await getWalletLedgerUseCase.execute({
        walletId: wallet.id,
        cursor: page2.nextCursor,
        limit: 10,
      });
      expect(page3.items.length).toBe(2); // exactly remaining 2 entries
      expect(page3.hasMore).toBe(false);
      expect(page3.nextCursor).toBeUndefined();

      // Audit invariant: Sum of all ledger entries must equal current wallet balance
      const allEntries = [...page1.items, ...page2.items, ...page3.items];
      expect(allEntries.length).toBe(6);

      let reconstructedBalance = Money.zero('BRL');
      // Sort in chronological order (createdAt ascending) to reconstruct
      const chronological = [...allEntries].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );

      for (const entry of chronological) {
        const entryMoney = Money.from(entry.money);
        if (entry.direction === LedgerDirection.Credit) {
          reconstructedBalance = reconstructedBalance.add(entryMoney);
        } else {
          reconstructedBalance = reconstructedBalance.subtract(entryMoney);
        }
      }

      expect(reconstructedBalance.toString()).toBe('170.00');
      expect(reconstructedBalance.toString()).toBe(currentWallet.balance.amount);
    });
  });
});
