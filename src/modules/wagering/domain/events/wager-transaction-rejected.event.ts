import { IntegrationEvent } from '../../../../shared/domain/events/integration-event';
import { MoneyProps } from '../../../../shared/domain/value-objects/money.value-object';
import { WagerTransactionKind } from '../wager-transaction-kind.enum';
import { FailureCode } from '../failure-code.enum';
import { WagerTransaction } from '../wager-transaction.entity';
import { v7 as uuidv7 } from 'uuid';

export interface WagerTransactionRejectedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  failureCode: FailureCode;
  reason: string;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  public static from(
    tx: WagerTransaction,
    reason: string,
    context?: { correlationId?: string; causationId?: string },
  ): WagerTransactionRejected {
    return new WagerTransactionRejected({
      eventId: uuidv7(),
      aggregateId: tx.id,
      correlationId: context?.correlationId || uuidv7(),
      causationId: context?.causationId || tx.id,
      occurredAt: tx.processedAt || new Date(),
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        playerId: tx.playerId,
        kind: tx.kind,
        money: tx.money.toJSON(),
        failureCode: tx.failureCode || FailureCode.InvalidPayload,
        reason,
      },
    });
  }
}
