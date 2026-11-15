import { IntegrationEvent } from '../../../../shared/domain/events/integration-event';
import { MoneyProps } from '../../../../shared/domain/value-objects/money.value-object';
import { WagerTransactionKind } from '../wager-transaction-kind.enum';
import { WagerTransaction } from '../wager-transaction.entity';
import { v7 as uuidv7 } from 'uuid';

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  referenceExternalTransactionId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  nextRetryAt?: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  public static from(
    tx: WagerTransaction,
    context?: { correlationId?: string; causationId?: string },
  ): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
      eventId: uuidv7(),
      aggregateId: tx.id,
      correlationId: context?.correlationId || uuidv7(),
      causationId: context?.causationId || tx.id,
      occurredAt: tx.createdAt,
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        referenceExternalTransactionId: tx.referenceExternalTransactionId || '',
        kind: tx.kind,
        money: tx.money.toJSON(),
        nextRetryAt: tx.nextRetryAt?.toISOString(),
      },
    });
  }
}
