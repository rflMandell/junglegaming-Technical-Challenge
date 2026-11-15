import { Wallet } from '../../domain/wallet.aggregate';
import { WalletLedgerEntry } from '../../../ledger/domain/wallet-ledger-entry.entity';
import { IntegrationEvent } from '../../../../shared/domain/events/integration-event';
import { WagerTransaction } from '../../../wagering/domain/wager-transaction.entity';
import { Money } from '../../../../shared/domain/value-objects/money.value-object';
import { WalletBalanceChanged } from '../../domain/events/wallet-balance-changed.event';

export const WALLET_REPOSITORY_TOKEN = 'WALLET_REPOSITORY_PORT';

export interface WalletRepositoryPort {
  findById(id: string): Promise<Wallet | null>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null>;
  save(
    wallet: Wallet,
    ledgerEntry?: WalletLedgerEntry,
    outboxEvent?: IntegrationEvent<unknown>,
    openingTx?: WagerTransaction,
  ): Promise<void>;
  debitWithLock(
    walletId: string,
    amount: Money,
    transactionId: string,
    correlationId?: string,
  ): Promise<{ wallet: Wallet; entry: WalletLedgerEntry; event: WalletBalanceChanged }>;
  creditWithLock(
    walletId: string,
    amount: Money,
    transactionId: string,
    correlationId?: string,
  ): Promise<{ wallet: Wallet; entry: WalletLedgerEntry; event: WalletBalanceChanged }>;
}
