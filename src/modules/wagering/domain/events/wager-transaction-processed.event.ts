import { IntegrationEvent } from '../../../../shared/domain/events/integration-event';
import { MoneyProps } from '../../../../shared/domain/value-objects/money.value-object';
import { WagerTransactionKind } from '../wager-transaction-kind.enum';
import { WagerTransaction } from '../wager-transaction.entity';
import { v7 as uuidv7 } from 'uuid';

export interface WagerTransactionProcessedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceTransactionId?: string;
  processedAt: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  public static from(
    tx: WagerTransaction,
    context?: { correlationId?: string; causationId?: string },
  ): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
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
        roundId: tx.roundId,
        gameId: tx.gameId,
        kind: tx.kind,
        money: tx.money.toJSON(),
        referenceTransactionId: tx.referenceTransactionId,
        processedAt: (tx.processedAt || new Date()).toISOString(),
      },
    });
  }
}
