import { Migration } from '@mikro-orm/migrations';

export class Migration20261114000000_InitialSchema extends Migration {
  async up(): Promise<void> {
    // 1. Providers table
    this.addSql(`
      CREATE TABLE IF NOT EXISTS providers (
        id VARCHAR(64) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // 2. Wallets table
    this.addSql(`
      CREATE TABLE IF NOT EXISTS wallets (
        id UUID PRIMARY KEY,
        player_id UUID NOT NULL,
        currency VARCHAR(3) NOT NULL,
        balance NUMERIC(18, 2) NOT NULL,
        version BIGINT NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_wallets_balance_non_negative CHECK (balance >= 0),
        CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency)
      );
    `);
    this.addSql(`CREATE INDEX IF NOT EXISTS idx_wallets_player_id ON wallets (player_id);`);

    // 3. Wager Transactions table
    this.addSql(`
      CREATE TABLE IF NOT EXISTS wager_transactions (
        id UUID PRIMARY KEY,
        provider_id VARCHAR(64) NOT NULL REFERENCES providers(id),
        external_transaction_id VARCHAR(128) NOT NULL,
        idempotency_key VARCHAR(255) NOT NULL,
        payload_hash VARCHAR(64) NOT NULL,
        wallet_id UUID NOT NULL REFERENCES wallets(id),
        player_id UUID NOT NULL,
        round_id VARCHAR(128) NOT NULL,
        game_id VARCHAR(128) NOT NULL,
        kind VARCHAR(32) NOT NULL,
        amount NUMERIC(18, 2) NOT NULL,
        currency VARCHAR(3) NOT NULL,
        reference_external_transaction_id VARCHAR(128) NULL,
        reference_transaction_id UUID NULL REFERENCES wager_transactions(id),
        status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
        failure_code VARCHAR(64) NULL,
        processed_at TIMESTAMPTZ NULL,
        retry_count INT NOT NULL DEFAULT 0,
        next_retry_at TIMESTAMPTZ NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_wager_transactions_amount_non_negative CHECK (amount >= 0),
        CONSTRAINT uq_wager_transactions_provider_idempotency UNIQUE (provider_id, idempotency_key),
        CONSTRAINT uq_wager_transactions_provider_external_id UNIQUE (provider_id, external_transaction_id)
      );
    `);
    this.addSql(`CREATE INDEX IF NOT EXISTS idx_wager_tx_wallet_created ON wager_transactions (wallet_id, created_at DESC);`);
    this.addSql(`CREATE INDEX IF NOT EXISTS idx_wager_tx_round_id ON wager_transactions (round_id);`);
    this.addSql(`CREATE INDEX IF NOT EXISTS idx_wager_tx_pending_reference ON wager_transactions (status, next_retry_at) WHERE status = 'PENDING_REFERENCE';`);
    this.addSql(`CREATE INDEX IF NOT EXISTS idx_wager_tx_ref_lookup ON wager_transactions (provider_id, external_transaction_id);`);

    // 4. Wallet Ledger Entries table
    this.addSql(`
      CREATE TABLE IF NOT EXISTS wallet_ledger_entries (
        id UUID PRIMARY KEY,
        wallet_id UUID NOT NULL REFERENCES wallets(id),
        transaction_id UUID NOT NULL REFERENCES wager_transactions(id),
        direction VARCHAR(16) NOT NULL,
        amount NUMERIC(18, 2) NOT NULL,
        currency VARCHAR(3) NOT NULL,
        balance_before NUMERIC(18, 2) NOT NULL,
        balance_after NUMERIC(18, 2) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_ledger_balance_before_non_negative CHECK (balance_before >= 0),
        CONSTRAINT chk_ledger_balance_after_non_negative CHECK (balance_after >= 0),
        CONSTRAINT chk_ledger_amount_positive CHECK (amount > 0),
        CONSTRAINT uq_ledger_transaction_wallet UNIQUE (transaction_id, wallet_id),
        CONSTRAINT chk_ledger_arithmetic_balance CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
          (direction = 'DEBIT'  AND balance_after = balance_before - amount)
        )
      );
    `);
    this.addSql(`CREATE INDEX IF NOT EXISTS idx_ledger_wallet_cursor ON wallet_ledger_entries (wallet_id, created_at DESC, id DESC);`);

    // 5. Inbox Messages table
    this.addSql(`
      CREATE TABLE IF NOT EXISTS inbox_messages (
        message_id VARCHAR(255) NOT NULL,
        consumer_name VARCHAR(128) NOT NULL,
        payload_hash VARCHAR(64) NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMPTZ NULL,
        PRIMARY KEY (consumer_name, message_id)
      );
    `);
    this.addSql(`CREATE INDEX IF NOT EXISTS idx_inbox_messages_processed ON inbox_messages (consumer_name, processed_at);`);

    // 6. Outbox Messages table
    this.addSql(`
      CREATE TABLE IF NOT EXISTS outbox_messages (
        id UUID PRIMARY KEY,
        aggregate_id VARCHAR(64) NOT NULL,
        event_type VARCHAR(128) NOT NULL,
        payload JSONB NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL,
        attempts INT NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ NULL,
        published_at TIMESTAMPTZ NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    this.addSql(`CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox_messages (occurred_at ASC) WHERE published_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS idx_outbox_retry ON outbox_messages (next_attempt_at ASC) WHERE published_at IS NULL;`);
  }

  async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS outbox_messages CASCADE;`);
    this.addSql(`DROP TABLE IF EXISTS inbox_messages CASCADE;`);
    this.addSql(`DROP TABLE IF EXISTS wallet_ledger_entries CASCADE;`);
    this.addSql(`DROP TABLE IF EXISTS wager_transactions CASCADE;`);
    this.addSql(`DROP TABLE IF EXISTS wallets CASCADE;`);
    this.addSql(`DROP TABLE IF EXISTS providers CASCADE;`);
  }
}
