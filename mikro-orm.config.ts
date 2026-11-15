import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { ProviderEntity } from './src/modules/providers/infrastructure/provider.entity';
import { WalletEntity } from './src/modules/wallet/infrastructure/wallet.entity';
import { WagerTransactionEntity } from './src/modules/wagering/infrastructure/wager-transaction.entity';
import { WalletLedgerEntryEntity } from './src/modules/ledger/infrastructure/wallet-ledger-entry.entity';
import { InboxMessageEntity } from './src/modules/messaging/infrastructure/inbox-message.entity';
import { OutboxMessageEntity } from './src/modules/messaging/infrastructure/outbox-message.entity';

export default defineConfig({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  dbName: process.env.DB_NAME || 'wagering_db',
  entities: [
    ProviderEntity,
    WalletEntity,
    WagerTransactionEntity,
    WalletLedgerEntryEntity,
    InboxMessageEntity,
    OutboxMessageEntity,
  ],
  extensions: [Migrator],
  migrations: {
    path: './migrations',
    pathTs: './migrations',
    glob: '!(*.d).{js,ts}',
    transactional: true,
    allOrNothing: true,
  },
  pool: {
    min: Number(process.env.DB_POOL_MIN) || 2,
    max: Number(process.env.DB_POOL_MAX) || 20,
  },
  debug: false,
});
