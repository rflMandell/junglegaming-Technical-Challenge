import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe, BadRequestException } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { AppModule } from '../../src/app.module';
import { CreateWalletUseCase } from '../../src/modules/wallet/application/use-cases/create-wallet.use-case';
import { GetWalletUseCase } from '../../src/modules/wallet/application/use-cases/get-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '../../src/modules/wagering/application/use-cases/process-wager-transaction.use-case';
import { GetWagerTransactionUseCase } from '../../src/modules/wagering/application/use-cases/get-wager-transaction.use-case';
import { GetWalletLedgerUseCase } from '../../src/modules/ledger/application/use-cases/get-wallet-ledger.use-case';
import { WagerTransactionKind } from '../../src/modules/wagering/domain/wager-transaction-kind.enum';
import { WagerTransactionStatus } from '../../src/modules/wagering/domain/wager-transaction-status.enum';
import { FailureCode } from '../../src/modules/wagering/domain/failure-code.enum';
import { Money } from '../../src/shared/domain/value-objects/money.value-object';
import { LedgerDirection } from '../../src/modules/ledger/domain/ledger-direction.enum';

describe('Wagering Engine (Integration)', () => {
  let app: INestApplication;
  let createWalletUseCase: CreateWalletUseCase;
  let getWalletUseCase: GetWalletUseCase;
  let processWagerUseCase: ProcessWagerTransactionUseCase;
  let getWagerUseCase: GetWagerTransactionUseCase;
  let getLedgerUseCase: GetWalletLedgerUseCase;

  const providerId = 'provider-engine-test';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    createWalletUseCase = app.get(CreateWalletUseCase);
    getWalletUseCase = app.get(GetWalletUseCase);
    processWagerUseCase = app.get(ProcessWagerTransactionUseCase);
    getWagerUseCase = app.get(GetWagerTransactionUseCase);
    getLedgerUseCase = app.get(GetWalletLedgerUseCase);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('should reject external submission of OPENING transaction', async () => {
    const playerId = uuidv7();
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    expect(
      processWagerUseCase.execute({
        providerId,
        externalTransactionId: uuidv7(),
        playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Opening,
        money: { amount: '50.00', currency: 'BRL' },
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('should process valid BET transaction, deduct balance, and create DEBIT ledger entry', async () => {
    const playerId = uuidv7();
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const extId = `bet-${uuidv7()}`;
    const result = await processWagerUseCase.execute({
      providerId,
      externalTransactionId: extId,
      playerId,
      walletId: wallet.id,
      roundId: 'round-bet-1',
      gameId: 'slot-game',
      kind: WagerTransactionKind.Bet,
      money: { amount: '25.00', currency: 'BRL' },
    });

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance.amount).toBe('75.00');
    expect(result.idempotentReplay).toBe(false);

    const updatedWallet = await getWalletUseCase.execute(wallet.id);
    expect(updatedWallet.balance.amount).toBe('75.00');
    expect(updatedWallet.version).toBe(2);

    const ledger = await getLedgerUseCase.execute({ walletId: wallet.id });
    const betEntry = ledger.items.find((i) => i.transactionId === result.transactionId);
    expect(betEntry).toBeDefined();
    expect(betEntry?.direction).toBe(LedgerDirection.Debit);
    expect(betEntry?.money.amount).toBe('25.00');
    expect(betEntry?.balanceAfter.amount).toBe('75.00');
  });

  it('should reject BET with INSUFFICIENT_FUNDS when balance is too low without changing balance or creating ledger', async () => {
    const playerId = uuidv7();
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '30.00', currency: 'BRL' },
    });

    const extId = `bet-insufficient-${uuidv7()}`;
    const result = await processWagerUseCase.execute({
      providerId,
      externalTransactionId: extId,
      playerId,
      walletId: wallet.id,
      roundId: 'round-bet-2',
      gameId: 'slot-game',
      kind: WagerTransactionKind.Bet,
      money: { amount: '50.00', currency: 'BRL' },
    });

    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(result.balance.amount).toBe('30.00');

    // Balance and version must remain untouched
    const currentWallet = await getWalletUseCase.execute(wallet.id);
    expect(currentWallet.balance.amount).toBe('30.00');
    expect(currentWallet.version).toBe(1);

    // Ledger must not contain any entry for rejected transaction
    const ledger = await getLedgerUseCase.execute({ walletId: wallet.id });
    expect(ledger.items.some((i) => i.transactionId === result.transactionId)).toBe(false);
  });

  it('should process WIN transaction, credit balance, and create CREDIT ledger entry', async () => {
    const playerId = uuidv7();
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '50.00', currency: 'BRL' },
    });

    const extId = `win-${uuidv7()}`;
    const result = await processWagerUseCase.execute({
      providerId,
      externalTransactionId: extId,
      playerId,
      walletId: wallet.id,
      roundId: 'round-win-1',
      gameId: 'slot-game',
      kind: WagerTransactionKind.Win,
      money: { amount: '150.00', currency: 'BRL' },
    });

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance.amount).toBe('200.00');

    const updatedWallet = await getWalletUseCase.execute(wallet.id);
    expect(updatedWallet.balance.amount).toBe('200.00');
    expect(updatedWallet.version).toBe(2);

    const ledger = await getLedgerUseCase.execute({ walletId: wallet.id });
    const winEntry = ledger.items.find((i) => i.transactionId === result.transactionId);
    expect(winEntry).toBeDefined();
    expect(winEntry?.direction).toBe(LedgerDirection.Credit);
    expect(winEntry?.money.amount).toBe('150.00');
  });

  it('should process LOSS transaction: audit status PROCESSED with NO balance movement and NO ledger entry', async () => {
    const playerId = uuidv7();
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '50.00', currency: 'BRL' },
    });

    const extId = `loss-${uuidv7()}`;
    const result = await processWagerUseCase.execute({
      providerId,
      externalTransactionId: extId,
      playerId,
      walletId: wallet.id,
      roundId: 'round-loss-1',
      gameId: 'slot-game',
      kind: WagerTransactionKind.Loss,
      money: { amount: '0.00', currency: 'BRL' },
    });

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance.amount).toBe('50.00');

    const currentWallet = await getWalletUseCase.execute(wallet.id);
    expect(currentWallet.balance.amount).toBe('50.00');
    expect(currentWallet.version).toBe(1);

    const ledger = await getLedgerUseCase.execute({ walletId: wallet.id });
    expect(ledger.items.some((i) => i.transactionId === result.transactionId)).toBe(false);

    // Transaction is auditably saved
    const retrieved = await getWagerUseCase.executeById(result.transactionId);
    expect(retrieved.status).toBe(WagerTransactionStatus.Processed);
    expect(retrieved.kind).toBe(WagerTransactionKind.Loss);
  });

  describe('Reversals: REFUND & ROLLBACK', () => {
    it('should set REFUND to PENDING_REFERENCE when reference transaction is not yet present', async () => {
      const playerId = uuidv7();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const missingRefId = `bet-not-yet-${uuidv7()}`;
      const result = await processWagerUseCase.execute({
        providerId,
        externalTransactionId: `refund-${uuidv7()}`,
        playerId,
        walletId: wallet.id,
        roundId: 'round-oor',
        gameId: 'slot-game',
        kind: WagerTransactionKind.Refund,
        money: { amount: '25.00', currency: 'BRL' },
        referenceExternalTransactionId: missingRefId,
      });

      expect(result.status).toBe(WagerTransactionStatus.PendingReference);
      expect(result.balance.amount).toBe('100.00');
    });

    it('should process valid REFUND for processed BET, credit balance, and prevent duplicate REFUND', async () => {
      const playerId = uuidv7();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      // 1. Execute BET of 30.00 -> balance becomes 70.00
      const betExtId = `bet-refund-target-${uuidv7()}`;
      await processWagerUseCase.execute({
        providerId,
        externalTransactionId: betExtId,
        playerId,
        walletId: wallet.id,
        roundId: 'round-ref-1',
        gameId: 'slot-game',
        kind: WagerTransactionKind.Bet,
        money: { amount: '30.00', currency: 'BRL' },
      });

      const afterBet = await getWalletUseCase.execute(wallet.id);
      expect(afterBet.balance.amount).toBe('70.00');

      // 2. Execute REFUND of 30.00 -> balance restored to 100.00
      const refundExtId = `refund-succ-${uuidv7()}`;
      const refundResult = await processWagerUseCase.execute({
        providerId,
        externalTransactionId: refundExtId,
        playerId,
        walletId: wallet.id,
        roundId: 'round-ref-1',
        gameId: 'slot-game',
        kind: WagerTransactionKind.Refund,
        money: { amount: '30.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
      });

      expect(refundResult.status).toBe(WagerTransactionStatus.Processed);
      expect(refundResult.balance.amount).toBe('100.00');

      const afterRefund = await getWalletUseCase.execute(wallet.id);
      expect(afterRefund.balance.amount).toBe('100.00');

      // 3. Duplicate REFUND on same BET must be rejected with REFERENCE_ALREADY_REVERSED
      const dupRefundResult = await processWagerUseCase.execute({
        providerId,
        externalTransactionId: `refund-dup-${uuidv7()}`,
        playerId,
        walletId: wallet.id,
        roundId: 'round-ref-1',
        gameId: 'slot-game',
        kind: WagerTransactionKind.Refund,
        money: { amount: '30.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
      });

      expect(dupRefundResult.status).toBe(WagerTransactionStatus.Rejected);
      expect(dupRefundResult.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
      expect(dupRefundResult.balance.amount).toBe('100.00');
    });

    it('should reject REFUND if amount differs from referenced BET (AMOUNT_MISMATCH)', async () => {
      const playerId = uuidv7();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const betExtId = `bet-amount-test-${uuidv7()}`;
      await processWagerUseCase.execute({
        providerId,
        externalTransactionId: betExtId,
        playerId,
        walletId: wallet.id,
        roundId: 'round-amt',
        gameId: 'slot-game',
        kind: WagerTransactionKind.Bet,
        money: { amount: '40.00', currency: 'BRL' },
      });

      // Try refund with 20.00 instead of 40.00
      const result = await processWagerUseCase.execute({
        providerId,
        externalTransactionId: `refund-wrong-amt-${uuidv7()}`,
        playerId,
        walletId: wallet.id,
        roundId: 'round-amt',
        gameId: 'slot-game',
        kind: WagerTransactionKind.Refund,
        money: { amount: '20.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
      });

      expect(result.status).toBe(WagerTransactionStatus.Rejected);
      expect(result.failureCode).toBe(FailureCode.AmountMismatch);
    });

    it('should reject ROLLBACK if reversal would produce negative wallet balance', async () => {
      const playerId = uuidv7();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '10.00', currency: 'BRL' },
      });

      // 1. Player wins 100.00 -> balance becomes 110.00
      const winExtId = `win-rollback-target-${uuidv7()}`;
      await processWagerUseCase.execute({
        providerId,
        externalTransactionId: winExtId,
        playerId,
        walletId: wallet.id,
        roundId: 'round-rb-neg',
        gameId: 'slot-game',
        kind: WagerTransactionKind.Win,
        money: { amount: '100.00', currency: 'BRL' },
      });

      // 2. Player bets 100.00 on another round -> balance becomes 10.00
      await processWagerUseCase.execute({
        providerId,
        externalTransactionId: `bet-drain-${uuidv7()}`,
        playerId,
        walletId: wallet.id,
        roundId: 'round-rb-neg-2',
        gameId: 'slot-game',
        kind: WagerTransactionKind.Bet,
        money: { amount: '100.00', currency: 'BRL' },
      });

      const walletBeforeRb = await getWalletUseCase.execute(wallet.id);
      expect(walletBeforeRb.balance.amount).toBe('10.00');

      // 3. Rollback of the 100.00 WIN attempted: current balance 10.00 < 100.00!
      // Must be explicitly rejected with REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE
      const rbResult = await processWagerUseCase.execute({
        providerId,
        externalTransactionId: `rb-neg-${uuidv7()}`,
        playerId,
        walletId: wallet.id,
        roundId: 'round-rb-neg',
        gameId: 'slot-game',
        kind: WagerTransactionKind.Rollback,
        money: { amount: '100.00', currency: 'BRL' },
        referenceExternalTransactionId: winExtId,
      });

      expect(rbResult.status).toBe(WagerTransactionStatus.Rejected);
      expect(rbResult.failureCode).toBe(FailureCode.ReversalWouldCauseNegativeBalance);
      expect(rbResult.balance.amount).toBe('10.00');

      // Invariant: Balance unchanged and never negative
      const walletAfterRb = await getWalletUseCase.execute(wallet.id);
      expect(walletAfterRb.balance.amount).toBe('10.00');
    });

    it('should process valid ROLLBACK of WIN, inverting direction to DEBIT', async () => {
      const playerId = uuidv7();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '200.00', currency: 'BRL' },
      });

      const winExtId = `win-to-rb-${uuidv7()}`;
      await processWagerUseCase.execute({
        providerId,
        externalTransactionId: winExtId,
        playerId,
        walletId: wallet.id,
        roundId: 'round-rb-win',
        gameId: 'slot-game',
        kind: WagerTransactionKind.Win,
        money: { amount: '50.00', currency: 'BRL' },
      });

      const afterWin = await getWalletUseCase.execute(wallet.id);
      expect(afterWin.balance.amount).toBe('250.00');

      // Rollback the 50.00 WIN -> debits 50.00 -> balance returns to 200.00
      const rbResult = await processWagerUseCase.execute({
        providerId,
        externalTransactionId: `rb-win-${uuidv7()}`,
        playerId,
        walletId: wallet.id,
        roundId: 'round-rb-win',
        gameId: 'slot-game',
        kind: WagerTransactionKind.Rollback,
        money: { amount: '50.00', currency: 'BRL' },
        referenceExternalTransactionId: winExtId,
      });

      expect(rbResult.status).toBe(WagerTransactionStatus.Processed);
      expect(rbResult.balance.amount).toBe('200.00');

      const ledger = await getLedgerUseCase.execute({ walletId: wallet.id });
      const rbEntry = ledger.items.find((i) => i.transactionId === rbResult.transactionId);
      expect(rbEntry).toBeDefined();
      expect(rbEntry?.direction).toBe(LedgerDirection.Debit);
      expect(rbEntry?.money.amount).toBe('50.00');
    });
  });

  describe('Universal Invariant Check', () => {
    it('verifies wallet balance equals reconstructed ledger sum across all operations', async () => {
      const playerId = uuidv7();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      // Chain of various operations
      const bet1 = `chain-bet-1-${uuidv7()}`;
      await processWagerUseCase.execute({
        providerId,
        externalTransactionId: bet1,
        playerId,
        walletId: wallet.id,
        roundId: 'chain-r1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet,
        money: { amount: '20.00', currency: 'BRL' },
      });

      const win1 = `chain-win-1-${uuidv7()}`;
      await processWagerUseCase.execute({
        providerId,
        externalTransactionId: win1,
        playerId,
        walletId: wallet.id,
        roundId: 'chain-r1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Win,
        money: { amount: '60.00', currency: 'BRL' },
      });

      // Loss (0.00, no balance change)
      await processWagerUseCase.execute({
        providerId,
        externalTransactionId: `chain-loss-${uuidv7()}`,
        playerId,
        walletId: wallet.id,
        roundId: 'chain-r2',
        gameId: 'game-1',
        kind: WagerTransactionKind.Loss,
        money: { amount: '0.00', currency: 'BRL' },
      });

      // Refund bet1 (+20.00)
      await processWagerUseCase.execute({
        providerId,
        externalTransactionId: `chain-refund-${uuidv7()}`,
        playerId,
        walletId: wallet.id,
        roundId: 'chain-r1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Refund,
        money: { amount: '20.00', currency: 'BRL' },
        referenceExternalTransactionId: bet1,
      });

      // Expected final balance: 100 - 20 + 60 + 20 = 160.00
      const currentWallet = await getWalletUseCase.execute(wallet.id);
      expect(currentWallet.balance.amount).toBe('160.00');

      // Reconstruct from ledger
      const ledger = await getLedgerUseCase.execute({ walletId: wallet.id, limit: 100 });
      let calculated = Money.zero('BRL');

      const chronological = [...ledger.items].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );

      for (const item of chronological) {
        const itemMoney = Money.from(item.money);
        if (item.direction === LedgerDirection.Credit) {
          calculated = calculated.add(itemMoney);
        } else {
          calculated = calculated.subtract(itemMoney);
        }
      }

      expect(calculated.toString()).toBe('160.00');
      expect(calculated.toString()).toBe(currentWallet.balance.amount);
    });
  });
});
