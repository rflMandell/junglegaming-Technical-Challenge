import { describe, it, expect } from 'bun:test';
import { v7 as uuidv7 } from 'uuid';
import { WagerTransactionProcessed } from '../../src/modules/wagering/domain/events/wager-transaction-processed.event';
import { WagerTransactionRejected } from '../../src/modules/wagering/domain/events/wager-transaction-rejected.event';
import { WagerTransactionPendingReference } from '../../src/modules/wagering/domain/events/wager-transaction-pending-reference.event';
import { WalletBalanceChanged } from '../../src/modules/wallet/domain/events/wallet-balance-changed.event';
import { WagerTransaction } from '../../src/modules/wagering/domain/wager-transaction.entity';
import { WagerTransactionKind } from '../../src/modules/wagering/domain/wager-transaction-kind.enum';
import { FailureCode } from '../../src/modules/wagering/domain/failure-code.enum';
import { Money } from '../../src/shared/domain/value-objects/money.value-object';
import { Wallet } from '../../src/modules/wallet/domain/wallet.aggregate';
import { LedgerDirection } from '../../src/modules/ledger/domain/ledger-direction.enum';
import { WalletLedgerEntry } from '../../src/modules/ledger/domain/wallet-ledger-entry.entity';

describe('Integration Events Envelope and Serialization (Unit)', () => {
  const correlationId = 'corr-123-abc';
  const causationId = 'caus-456-def';

  it('WagerTransactionProcessed should have standard envelope and decimal money string', () => {
    const tx = WagerTransaction.create({
      id: uuidv7(),
      providerId: 'provider-1',
      externalTransactionId: 'ext-tx-100',
      idempotencyKey: 'idemp-100',
      payloadHash: 'hash123',
      walletId: uuidv7(),
      playerId: uuidv7(),
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '50.25', currency: 'BRL' }),
    });
    tx.markProcessed(undefined, new Date('2026-11-15T12:00:00.000Z'));

    const event = WagerTransactionProcessed.from(tx, { correlationId, causationId });
    const json = event.toJSON();

    expect(json.eventId).toBeDefined();
    expect(json.eventType).toBe('WagerTransactionProcessed');
    expect(json.version).toBe(1);
    expect(json.aggregateId).toBe(tx.id);
    expect(json.correlationId).toBe(correlationId);
    expect(json.causationId).toBe(causationId);
    expect(json.occurredAt).toBe('2026-11-15T12:00:00.000Z');

    // Monetary assertion: must be string, not number/float
    expect(json.data.money.amount).toBe('50.25');
    expect(typeof json.data.money.amount).toBe('string');
    expect(json.data.money.currency).toBe('BRL');
  });

  it('WagerTransactionRejected should serialize failureCode and reason', () => {
    const tx = WagerTransaction.create({
      id: uuidv7(),
      providerId: 'provider-1',
      externalTransactionId: 'ext-tx-rej',
      idempotencyKey: 'idemp-rej',
      payloadHash: 'hash-rej',
      walletId: uuidv7(),
      playerId: uuidv7(),
      roundId: 'round-rej',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '999.99', currency: 'BRL' }),
    });
    tx.reject(FailureCode.InsufficientFunds);

    const event = WagerTransactionRejected.from(tx, 'Insufficient funds for bet', {
      correlationId,
    });
    const json = event.toJSON();

    expect(json.eventType).toBe('WagerTransactionRejected');
    expect(json.version).toBe(1);
    expect(json.data.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(json.data.reason).toBe('Insufficient funds for bet');
    expect(json.data.money.amount).toBe('999.99');
  });

  it('WalletBalanceChanged should serialize balanceBefore and balanceAfter as decimal strings', () => {
    const { wallet } = Wallet.open({
      id: uuidv7(),
      playerId: uuidv7(),
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    const txId = uuidv7();
    const entryId = uuidv7();
    const { entry } = wallet.debit(Money.from({ amount: '35.50', currency: 'BRL' }), txId, entryId);

    const event = WalletBalanceChanged.from(wallet, entry, { correlationId });
    const json = event.toJSON();

    expect(json.eventType).toBe('WalletBalanceChanged');
    expect(json.version).toBe(1);
    expect(json.aggregateId).toBe(wallet.id);
    expect(json.data.direction).toBe(LedgerDirection.Debit);
    expect(json.data.money.amount).toBe('35.50');
    expect(json.data.balanceBefore.amount).toBe('100.00');
    expect(json.data.balanceAfter.amount).toBe('64.50');
    expect(json.data.walletVersion).toBe(2);
  });

  it('WagerTransactionPendingReference should serialize reference info', () => {
    const tx = WagerTransaction.create({
      id: uuidv7(),
      providerId: 'provider-1',
      externalTransactionId: 'ext-refund-001',
      referenceExternalTransactionId: 'ext-bet-pending',
      idempotencyKey: 'idemp-ref',
      payloadHash: 'hash-ref',
      walletId: uuidv7(),
      playerId: uuidv7(),
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Refund,
      money: Money.from({ amount: '15.00', currency: 'BRL' }),
    });
    tx.markPendingReference(new Date('2026-11-15T12:05:00.000Z'));

    const event = WagerTransactionPendingReference.from(tx, { correlationId });
    const json = event.toJSON();

    expect(json.eventType).toBe('WagerTransactionPendingReference');
    expect(json.version).toBe(1);
    expect(json.data.referenceExternalTransactionId).toBe('ext-bet-pending');
    expect(json.data.money.amount).toBe('15.00');
    expect(json.data.nextRetryAt).toBe('2026-11-15T12:05:00.000Z');
  });
});
