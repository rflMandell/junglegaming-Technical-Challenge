import { IntegrationEvent } from '../../../../shared/domain/events/integration-event';
import { MoneyProps } from '../../../../shared/domain/value-objects/money.value-object';
import { LedgerDirection } from '../../../ledger/domain/ledger-direction.enum';
import { Wallet } from '../wallet.aggregate';
import { WalletLedgerEntry } from '../../../ledger/domain/wallet-ledger-entry.entity';
import { v7 as uuidv7 } from 'uuid';

export interface WalletBalanceChangedData {
  walletId: string;
  playerId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  public static from(
    wallet: Wallet,
    entry: WalletLedgerEntry,
    context?: { correlationId?: string; causationId?: string },
  ): WalletBalanceChanged {
    return new WalletBalanceChanged({
      eventId: uuidv7(),
      aggregateId: wallet.id,
      correlationId: context?.correlationId || uuidv7(),
      causationId: context?.causationId || entry.transactionId,
      occurredAt: entry.createdAt,
      data: {
        walletId: wallet.id,
        playerId: wallet.playerId,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}
