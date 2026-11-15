import { WagerTransaction } from '../wager-transaction.entity';
import { WagerTransactionKind } from '../wager-transaction-kind.enum';
import { WagerTransactionStatus } from '../wager-transaction-status.enum';
import { FailureCode } from '../failure-code.enum';
import { Wallet } from '../../../wallet/domain/wallet.aggregate';

export interface ValidationSuccess {
  valid: true;
}

export interface ValidationFailure {
  valid: false;
  failureCode: FailureCode;
  reason: string;
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

export class WagerTransactionValidatorService {
  /**
   * Validates reference transaction business rules for REFUND and ROLLBACK.
   */
  public static validateReference(
    tx: WagerTransaction,
    reference: WagerTransaction,
    wallet: Wallet,
    existingReversals: WagerTransaction[],
  ): ValidationResult {
    // 1. Reference must belong to the same provider, player, wallet, and round
    if (
      tx.providerId !== reference.providerId ||
      tx.playerId !== reference.playerId ||
      tx.walletId !== reference.walletId ||
      tx.roundId !== reference.roundId
    ) {
      return {
        valid: false,
        failureCode: FailureCode.ReferenceMismatch,
        reason: 'Reference transaction does not match provider, player, wallet, or round of the current operation',
      };
    }

    // 2. Reference currency must match
    if (tx.money.currency !== reference.money.currency || tx.money.currency !== wallet.currency) {
      return {
        valid: false,
        failureCode: FailureCode.CurrencyMismatch,
        reason: 'Operation currency does not match reference transaction or wallet currency',
      };
    }

    // 3. Amount of REFUND or ROLLBACK must be equal to reference amount
    if (!tx.money.equals(reference.money)) {
      return {
        valid: false,
        failureCode: FailureCode.AmountMismatch,
        reason: `Reversal amount (${tx.money.toString()}) must match reference amount (${reference.money.toString()})`,
      };
    }

    // 4. Reference must be in PROCESSED status
    if (reference.status !== WagerTransactionStatus.Processed) {
      return {
        valid: false,
        failureCode: FailureCode.InvalidReferenceKind,
        reason: `Cannot reverse reference transaction with status '${reference.status}' (must be PROCESSED)`,
      };
    }

    // 5. Allowed reference kinds:
    // REFUND can only reference BET
    if (tx.kind === WagerTransactionKind.Refund) {
      if (reference.kind !== WagerTransactionKind.Bet) {
        return {
          valid: false,
          failureCode: FailureCode.InvalidReferenceKind,
          reason: `REFUND can only reference a BET transaction (found: '${reference.kind}')`,
        };
      }
    }

    // ROLLBACK can reference BET, WIN, or REFUND
    if (tx.kind === WagerTransactionKind.Rollback) {
      const allowedRollbackKinds = [
        WagerTransactionKind.Bet,
        WagerTransactionKind.Win,
        WagerTransactionKind.Refund,
      ];
      if (!allowedRollbackKinds.includes(reference.kind)) {
        return {
          valid: false,
          failureCode: FailureCode.InvalidReferenceKind,
          reason: `ROLLBACK can only reference BET, WIN, or REFUND transactions (found: '${reference.kind}')`,
        };
      }
    }

    // 6. Cannot reverse the same reference twice by the same operation kind
    const alreadyReversed = existingReversals.some(
      (r) =>
        r.kind === tx.kind &&
        r.status === WagerTransactionStatus.Processed &&
        r.referenceExternalTransactionId === tx.referenceExternalTransactionId,
    );
    if (alreadyReversed) {
      return {
        valid: false,
        failureCode: FailureCode.ReferenceAlreadyReversed,
        reason: `Reference transaction '${reference.externalTransactionId}' has already been reversed by a ${tx.kind} operation`,
      };
    }

    // 7. Check if reversal would cause negative balance (e.g. ROLLBACK of a WIN)
    if (tx.kind === WagerTransactionKind.Rollback && reference.kind === WagerTransactionKind.Win) {
      if (wallet.balance.isLessThan(tx.money)) {
        return {
          valid: false,
          failureCode: FailureCode.ReversalWouldCauseNegativeBalance,
          reason: `Rollback of WIN would cause negative wallet balance (current: ${wallet.balance.toString()}, required: ${tx.money.toString()})`,
        };
      }
    }

    return { valid: true };
  }
}
