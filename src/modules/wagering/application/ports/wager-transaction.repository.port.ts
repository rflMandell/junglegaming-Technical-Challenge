import { WagerTransaction } from '../../domain/wager-transaction.entity';
import { IntegrationEvent } from '../../../../shared/domain/events/integration-event';
import { Wallet } from '../../../wallet/domain/wallet.aggregate';
import { WalletLedgerEntry } from '../../../ledger/domain/wallet-ledger-entry.entity';
import { ProcessWagerTransactionDto } from '../dtos/process-wager-transaction.dto';
import { ProcessWagerTransactionResponseDto } from '../dtos/wager-transaction-response.dto';

export const WAGER_TRANSACTION_REPOSITORY_TOKEN = 'WAGER_TRANSACTION_REPOSITORY_PORT';

export interface AtomicWagerParams {
  transaction: WagerTransaction;
  wallet: Wallet;
  ledgerEntry?: WalletLedgerEntry;
  events: IntegrationEvent<unknown>[];
}

export interface TransactionalWagerParams {
  dto: ProcessWagerTransactionDto;
  idempotencyKey: string;
  payloadHash: string;
  correlationId?: string;
  inbox?: {
    consumerName: string;
    messageId: string;
  };
}

export interface WagerTransactionRepositoryPort {
  findById(id: string): Promise<WagerTransaction | null>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | null>;
  findReversalsFor(providerId: string, referenceExternalTransactionId: string): Promise<WagerTransaction[]>;
  save(transaction: WagerTransaction, events?: IntegrationEvent<unknown>[]): Promise<void>;
  executeAtomicWager(params: AtomicWagerParams): Promise<void>;
  executeTransactionalWager(params: TransactionalWagerParams): Promise<ProcessWagerTransactionResponseDto>;
}
