import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry.entity';

export const LEDGER_REPOSITORY_TOKEN = 'LEDGER_REPOSITORY_PORT';

export interface LedgerCursorPayload {
  createdAt: string;
  id: string;
}

export interface GetLedgerQuery {
  walletId: string;
  cursor?: string;
  limit?: number;
}

export interface PaginatedLedgerResult {
  items: WalletLedgerEntry[];
  nextCursor?: string;
  hasMore: boolean;
}

export interface LedgerRepositoryPort {
  findByWalletWithCursor(query: GetLedgerQuery): Promise<PaginatedLedgerResult>;
  save(entry: WalletLedgerEntry): Promise<void>;
  countByWalletId(walletId: string): Promise<number>;
}
