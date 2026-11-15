# Database Schema & Relational Model Specification

## 1. Visão Geral do Modelo Relacional

O schema do banco de dados PostgreSQL foi desenhado para ser a **âncora inegociável da consistência e integridade financeira** do sistema. Conforme a restrição inviolável nº 9 do desafio:
> *As garantias de unicidade, imutabilidade e não-negatividade devem ser aplicadas no schema do banco, não apenas em código de aplicação.*

O banco de dados utiliza tipos exatos, constraints de integridade e índices especializados para alta concorrência e consultas ordenadas por cursor estável.

---

## 2. Tabelas e Definições de Schema

### 2.1 Tabela `providers`
Identificação e registro dos provedores de jogos integrados.

```sql
CREATE TABLE providers (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

### 2.2 Tabela `wallets`
Armazena a carteira do jogador com saldo materializado e controle de concorrência.

```sql
CREATE TABLE wallets (
    id UUID PRIMARY KEY,
    player_id UUID NOT NULL,
    currency VARCHAR(3) NOT NULL,
    balance NUMERIC(18, 2) NOT NULL,
    version BIGINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Invariante: Saldo nunca negativo garantido pelo banco
    CONSTRAINT chk_wallets_balance_non_negative CHECK (balance >= 0),
    
    -- Invariante: No máximo uma wallet por jogador e moeda
    CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency)
);

CREATE INDEX idx_wallets_player_id ON wallets (player_id);
```

---

### 2.3 Tabela `wager_transactions`
Registra as transações de apostas, idempotência persistente e resolução de referências.

```sql
CREATE TYPE wager_transaction_kind AS ENUM (
    'OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'
);

CREATE TYPE wager_transaction_status AS ENUM (
    'PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'
);

CREATE TABLE wager_transactions (
    id UUID PRIMARY KEY,
    provider_id VARCHAR(64) NOT NULL REFERENCES providers(id),
    external_transaction_id VARCHAR(128) NOT NULL,
    idempotency_key VARCHAR(255) NOT NULL,
    payload_hash VARCHAR(64) NOT NULL,
    wallet_id UUID NOT NULL REFERENCES wallets(id),
    player_id UUID NOT NULL,
    round_id VARCHAR(128) NOT NULL,
    game_id VARCHAR(128) NOT NULL,
    kind wager_transaction_kind NOT NULL,
    amount NUMERIC(18, 2) NOT NULL,
    currency VARCHAR(3) NOT NULL,
    reference_external_transaction_id VARCHAR(128) NULL,
    reference_transaction_id UUID NULL REFERENCES wager_transactions(id),
    status wager_transaction_status NOT NULL DEFAULT 'PENDING',
    failure_code VARCHAR(64) NULL,
    processed_at TIMESTAMPTZ NULL,
    retry_count INT NOT NULL DEFAULT 0,
    next_retry_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Invariante de valor positivo em requisições
    CONSTRAINT chk_wager_transactions_amount_non_negative CHECK (amount >= 0),

    -- Invariante: Idempotency Key única por provedor
    CONSTRAINT uq_wager_transactions_provider_idempotency UNIQUE (provider_id, idempotency_key),

    -- Invariante: Identificador externo único por provedor
    CONSTRAINT uq_wager_transactions_provider_external_id UNIQUE (provider_id, external_transaction_id)
);

-- Índices estratégicos
CREATE INDEX idx_wager_tx_wallet_created ON wager_transactions (wallet_id, created_at DESC);
CREATE INDEX idx_wager_tx_round_id ON wager_transactions (round_id);
CREATE INDEX idx_wager_tx_pending_reference ON wager_transactions (status, next_retry_at) 
    WHERE status = 'PENDING_REFERENCE';
CREATE INDEX idx_wager_tx_ref_lookup ON wager_transactions (provider_id, external_transaction_id);
```

---

### 2.4 Tabela `wallet_ledger_entries`
Histórico financeiro imutável de partidas contábeis.

```sql
CREATE TYPE ledger_direction AS ENUM ('DEBIT', 'CREDIT');

CREATE TABLE wallet_ledger_entries (
    id UUID PRIMARY KEY,
    wallet_id UUID NOT NULL REFERENCES wallets(id),
    transaction_id UUID NOT NULL REFERENCES wager_transactions(id),
    direction ledger_direction NOT NULL,
    amount NUMERIC(18, 2) NOT NULL,
    currency VARCHAR(3) NOT NULL,
    balance_before NUMERIC(18, 2) NOT NULL,
    balance_after NUMERIC(18, 2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Invariante: Saldo anterior e posterior nunca negativos
    CONSTRAINT chk_ledger_balance_before_non_negative CHECK (balance_before >= 0),
    CONSTRAINT chk_ledger_balance_after_non_negative CHECK (balance_after >= 0),
    CONSTRAINT chk_ledger_amount_positive CHECK (amount > 0),

    -- Invariante: No máximo um lançamento por transação e carteira
    CONSTRAINT uq_ledger_transaction_wallet UNIQUE (transaction_id, wallet_id),

    -- Invariante contábil: consistência estrita de saldo antes/depois no banco
    CONSTRAINT chk_ledger_arithmetic_balance CHECK (
        (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
        (direction = 'DEBIT'  AND balance_after = balance_before - amount)
    )
);

-- Índice para paginação por cursor estável ordenado cronologicamente
CREATE INDEX idx_ledger_wallet_cursor ON wallet_ledger_entries (wallet_id, created_at DESC, id DESC);
```

---

### 2.5 Tabela `inbox_messages`
Garante a deduplicação persistente de mensagens SQS por consumidor.

```sql
CREATE TABLE inbox_messages (
    message_id VARCHAR(255) NOT NULL,
    consumer_name VARCHAR(128) NOT NULL,
    payload_hash VARCHAR(64) NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ NULL,

    -- Chave primária composta para deduplicação por consumidor
    PRIMARY KEY (consumer_name, message_id)
);

CREATE INDEX idx_inbox_messages_processed ON inbox_messages (consumer_name, processed_at);
```

---

### 2.6 Tabela `outbox_messages`
Padrão Transactional Outbox para publicação atômica e resiliente de eventos de integração.

```sql
CREATE TABLE outbox_messages (
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

-- Índice parcial crucial para concorrência de múltiplos publishers (SKIP LOCKED)
CREATE INDEX idx_outbox_pending ON outbox_messages (occurred_at ASC)
    WHERE published_at IS NULL;

CREATE INDEX idx_outbox_retry ON outbox_messages (next_attempt_at ASC)
    WHERE published_at IS NULL;
```

---

## 3. Estratégia de Migrations (MikroORM)

1. **Versionadas e Reversíveis:**
   - Todas as alterações estruturais são versionadas em arquivos TypeScript gerenciados pelo `@mikro-orm/migrations`.
   - Cada migração possui os métodos `up(): Promise<void>` e `down(): Promise<void>`.
2. **Execução Automatizada:**
   - Na inicialização do contêiner da aplicação ou via comando CLI explícito (`bun run migration:up`), garantindo sincronização transparente do schema.
3. **Imutabilidade de Scripts Já Aplicados:**
   - Migrações já aplicadas em ambientes compartilhados são imutáveis; novas alterações exigem nova migração sequencial.
