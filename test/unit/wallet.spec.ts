import { describe, it, expect } from 'bun:test';
import { Wallet } from '../../src/modules/wallet/domain/wallet.aggregate';
import { Money } from '../../src/shared/domain/value-objects/money.value-object';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
} from '../../src/shared/domain/errors/domain.error';
import { LedgerDirection } from '../../src/modules/ledger/domain/ledger-direction.enum';

describe('Wallet Aggregate Root (Unit)', () => {
  const walletId = '0192f291-27dd-7d3f-8071-5f8685deef37';
  const playerId = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';

  it('should open a wallet with initial balance 0 and no opening entry', () => {
    const { wallet, entry } = Wallet.open({
      id: walletId,
      playerId,
      initialBalance: Money.zero('BRL'),
    });

    expect(wallet.id).toBe(walletId);
    expect(wallet.playerId).toBe(playerId);
    expect(wallet.currency).toBe('BRL');
    expect(wallet.balance.toString()).toBe('0.00');
    expect(wallet.version).toBe(1);
    expect(entry).toBeUndefined();
  });

  it('should open a wallet with positive balance and generate opening CREDIT ledger entry', () => {
    const initial = Money.from({ amount: '1000.00', currency: 'BRL' });
    const { wallet, entry } = Wallet.open({
      id: walletId,
      playerId,
      initialBalance: initial,
      openingTransactionId: 'tx-opening-1',
      openingEntryId: 'entry-opening-1',
    });

    expect(wallet.balance.toString()).toBe('1000.00');
    expect(wallet.version).toBe(1);
    expect(entry).toBeDefined();
    expect(entry?.direction).toBe(LedgerDirection.Credit);
    expect(entry?.money.toString()).toBe('1000.00');
    expect(entry?.balanceBefore.toString()).toBe('0.00');
    expect(entry?.balanceAfter.toString()).toBe('1000.00');
  });

  it('should successfully debit funds and increment version', () => {
    const initial = Money.from({ amount: '100.00', currency: 'BRL' });
    const { wallet } = Wallet.open({ id: walletId, playerId, initialBalance: initial });

    const debitAmount = Money.from({ amount: '40.00', currency: 'BRL' });
    const { entry } = wallet.debit(debitAmount, 'tx-bet-1', 'entry-bet-1');

    expect(wallet.balance.toString()).toBe('60.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toString()).toBe('100.00');
    expect(entry.balanceAfter.toString()).toBe('60.00');
  });

  it('should reject debit when balance is insufficient without changing balance or version', () => {
    const initial = Money.from({ amount: '50.00', currency: 'BRL' });
    const { wallet } = Wallet.open({ id: walletId, playerId, initialBalance: initial });

    const debitAmount = Money.from({ amount: '80.00', currency: 'BRL' });
    expect(() => wallet.debit(debitAmount, 'tx-bet-2', 'entry-bet-2')).toThrow(
      InsufficientFundsError,
    );

    // Assert invariants: balance and version untouched
    expect(wallet.balance.toString()).toBe('50.00');
    expect(wallet.version).toBe(1);
  });

  it('should successfully credit funds and increment version', () => {
    const initial = Money.from({ amount: '50.00', currency: 'BRL' });
    const { wallet } = Wallet.open({ id: walletId, playerId, initialBalance: initial });

    const creditAmount = Money.from({ amount: '150.00', currency: 'BRL' });
    const { entry } = wallet.credit(creditAmount, 'tx-win-1', 'entry-win-1');

    expect(wallet.balance.toString()).toBe('200.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceBefore.toString()).toBe('50.00');
    expect(entry.balanceAfter.toString()).toBe('200.00');
  });

  it('should reject operations with mismatched currency', () => {
    const initial = Money.from({ amount: '50.00', currency: 'BRL' });
    const { wallet } = Wallet.open({ id: walletId, playerId, initialBalance: initial });

    const usd = Money.from({ amount: '10.00', currency: 'USD' });
    expect(() => wallet.debit(usd, 'tx-1', 'entry-1')).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(usd, 'tx-2', 'entry-2')).toThrow(CurrencyMismatchError);
  });

  it('should rehydrate from state without revalidating rules', () => {
    const rehydrated = Wallet.rehydrate({
      id: walletId,
      playerId,
      currency: 'BRL',
      balance: Money.from({ amount: '750.00', currency: 'BRL' }),
      version: 5,
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-02'),
    });

    expect(rehydrated.id).toBe(walletId);
    expect(rehydrated.balance.toString()).toBe('750.00');
    expect(rehydrated.version).toBe(5);
  });
});
