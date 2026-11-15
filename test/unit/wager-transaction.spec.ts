import { describe, it, expect } from 'bun:test';
import { WagerTransaction } from '../../src/modules/wagering/domain/wager-transaction.entity';
import { WagerTransactionKind } from '../../src/modules/wagering/domain/wager-transaction-kind.enum';
import { WagerTransactionStatus } from '../../src/modules/wagering/domain/wager-transaction-status.enum';
import { FailureCode } from '../../src/modules/wagering/domain/failure-code.enum';
import { Money } from '../../src/shared/domain/value-objects/money.value-object';
import {
  DomainError,
  InvalidTransactionStateError,
} from '../../src/shared/domain/errors/domain.error';
import { LedgerDirection } from '../../src/modules/ledger/domain/ledger-direction.enum';

describe('WagerTransaction Entity (Unit)', () => {
  const defaultProps = {
    id: '0192f298-345e-7e38-af88-e43f851a8190',
    providerId: 'provider-a',
    externalTransactionId: 'tx-ext-100',
    idempotencyKey: 'provider-a:tx-ext-100',
    payloadHash: 'hash-abc-123',
    walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
    playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    roundId: 'round-1',
    gameId: 'game-1',
    money: Money.from({ amount: '25.00', currency: 'BRL' }),
  };

  it('should create BET transaction in PENDING status', () => {
    const tx = WagerTransaction.create({
      ...defaultProps,
      kind: WagerTransactionKind.Bet,
    });

    expect(tx.status).toBe(WagerTransactionStatus.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.affectsBalance()).toBe(true);
    expect(tx.requiresReference()).toBe(false);
    expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
  });

  it('should require referenceExternalTransactionId for REFUND and ROLLBACK', () => {
    expect(() =>
      WagerTransaction.create({
        ...defaultProps,
        kind: WagerTransactionKind.Refund,
      }),
    ).toThrow(DomainError);

    expect(() =>
      WagerTransaction.create({
        ...defaultProps,
        kind: WagerTransactionKind.Rollback,
      }),
    ).toThrow(DomainError);

    const validRefund = WagerTransaction.create({
      ...defaultProps,
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'tx-ext-bet-1',
    });
    expect(validRefund.requiresReference()).toBe(true);
    expect(validRefund.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  it('should correctly determine ROLLBACK ledger direction by inverting reference direction', () => {
    const betTx = WagerTransaction.create({
      ...defaultProps,
      kind: WagerTransactionKind.Bet,
    });

    const rollbackBet = WagerTransaction.create({
      ...defaultProps,
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: betTx.externalTransactionId,
    });
    expect(rollbackBet.ledgerDirectionFor(betTx)).toBe(LedgerDirection.Credit);

    const winTx = WagerTransaction.create({
      ...defaultProps,
      kind: WagerTransactionKind.Win,
    });

    const rollbackWin = WagerTransaction.create({
      ...defaultProps,
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: winTx.externalTransactionId,
    });
    expect(rollbackWin.ledgerDirectionFor(winTx)).toBe(LedgerDirection.Debit);
  });

  it('should handle LOSS transaction properties', () => {
    const loss = WagerTransaction.create({
      ...defaultProps,
      kind: WagerTransactionKind.Loss,
      money: Money.zero('BRL'),
    });

    expect(loss.affectsBalance()).toBe(false);
    expect(() => loss.ledgerDirectionFor()).toThrow(DomainError);
  });

  it('should transition through valid state machine flow to PROCESSED', () => {
    const tx = WagerTransaction.create({
      ...defaultProps,
      kind: WagerTransactionKind.Bet,
    });

    const processedAt = new Date();
    tx.markProcessed(undefined, processedAt);

    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.isTerminal()).toBe(true);
    expect(tx.processedAt).toBe(processedAt);

    // Any further transition must be rejected with InvalidTransactionStateError
    expect(() => tx.reject(FailureCode.InsufficientFunds)).toThrow(InvalidTransactionStateError);
    expect(() => tx.fail(FailureCode.InternalInfrastructureError)).toThrow(
      InvalidTransactionStateError,
    );
    expect(() => tx.markProcessed(undefined, new Date())).toThrow(InvalidTransactionStateError);
  });

  it('should transition to PENDING_REFERENCE and increment retry count', () => {
    const tx = WagerTransaction.create({
      ...defaultProps,
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'tx-ext-bet-pending',
    });

    const nextRetry = new Date(Date.now() + 5000);
    tx.markPendingReference(nextRetry);

    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.retryCount).toBe(1);
    expect(tx.nextRetryAt).toBe(nextRetry);
  });

  it('should reject transaction with a stable FailureCode', () => {
    const tx = WagerTransaction.create({
      ...defaultProps,
      kind: WagerTransactionKind.Bet,
    });

    tx.reject(FailureCode.InsufficientFunds);

    expect(tx.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(tx.isTerminal()).toBe(true);
    expect(tx.affectsBalance()).toBe(false);
  });

  it('should match payload hash correctly', () => {
    const tx = WagerTransaction.create({
      ...defaultProps,
      kind: WagerTransactionKind.Bet,
    });

    expect(tx.matchesPayload('hash-abc-123')).toBe(true);
    expect(tx.matchesPayload('different-hash')).toBe(false);
  });
});
