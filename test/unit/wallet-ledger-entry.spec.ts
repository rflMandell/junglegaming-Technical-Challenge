import { describe, it, expect } from 'bun:test';
import { WalletLedgerEntry } from '../../src/modules/ledger/domain/wallet-ledger-entry.entity';
import { LedgerDirection } from '../../src/modules/ledger/domain/ledger-direction.enum';
import { Money } from '../../src/shared/domain/value-objects/money.value-object';
import { UnbalancedLedgerEntryError } from '../../src/shared/domain/errors/domain.error';

describe('WalletLedgerEntry Entity (Unit)', () => {
  const defaultProps = {
    id: 'entry-1',
    walletId: 'wallet-1',
    transactionId: 'tx-1',
    money: Money.from({ amount: '50.00', currency: 'BRL' }),
  };

  it('should create valid CREDIT ledger entry with balanced arithmetic', () => {
    const entry = WalletLedgerEntry.create({
      ...defaultProps,
      direction: LedgerDirection.Credit,
      balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
      balanceAfter: Money.from({ amount: '150.00', currency: 'BRL' }),
    });

    expect(entry.isBalanced()).toBe(true);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.money.toString()).toBe('50.00');
  });

  it('should create valid DEBIT ledger entry with balanced arithmetic', () => {
    const entry = WalletLedgerEntry.create({
      ...defaultProps,
      direction: LedgerDirection.Debit,
      balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
      balanceAfter: Money.from({ amount: '50.00', currency: 'BRL' }),
    });

    expect(entry.isBalanced()).toBe(true);
    expect(entry.direction).toBe(LedgerDirection.Debit);
  });

  it('should throw UnbalancedLedgerEntryError if arithmetic does not match', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...defaultProps,
        direction: LedgerDirection.Credit,
        balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
        balanceAfter: Money.from({ amount: '120.00', currency: 'BRL' }), // wrong arithmetic!
      }),
    ).toThrow(UnbalancedLedgerEntryError);

    expect(() =>
      WalletLedgerEntry.create({
        ...defaultProps,
        direction: LedgerDirection.Debit,
        balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
        balanceAfter: Money.from({ amount: '80.00', currency: 'BRL' }), // wrong arithmetic!
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  it('should rehydrate without re-running transition checks', () => {
    const entry = WalletLedgerEntry.rehydrate({
      ...defaultProps,
      direction: LedgerDirection.Credit,
      balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
      balanceAfter: Money.from({ amount: '150.00', currency: 'BRL' }),
      createdAt: new Date('2026-01-01'),
    });

    expect(entry.id).toBe('entry-1');
    expect(entry.isBalanced()).toBe(true);
  });
});
