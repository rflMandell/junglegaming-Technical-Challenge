# Domain Modeling & Business Rules Specification

## 1. Visão Geral do Domínio

O domínio do **Distributed Wagering Processor** gerencia a liquidação financeira de apostas e prêmios entre provedores de jogos de cassino e jogadores, mantendo a integridade incondicional do saldo e um histórico auditável imutável (*ledger*).

---

## 2. Modelos do Domínio (Domain Entities & Value Objects)

### 2.1 Value Object: `Money`
Objeto de valor **estritamente imutável** que encapsula valor monetário e moeda (ISO-4217).

- **Encapsulamento:** Construtor `private` com factory methods estáticos `from(props)` e `zero(currency)`.
- **Aritmética Exata:** Uso de `Decimal.js` com escala fixa de **2 casas decimais** (`Decimal.ROUND_HALF_EVEN` / Banker's Rounding quando aplicável).
- **Invariantes:**
  - `amount` é serializado e deserializado como string decimal com 2 casas (ex: `"25.00"`).
  - Rejeita explicitamente `NaN`, `Infinity`, strings vazias, notação científica (`1e5`), números com mais de 2 casas decimais e valores numéricos em ponto flutuante.
  - Rejeita valores negativos em contratos de entrada que requerem magnitude positiva.
  - Operações entre moedas diferentes disparam `CurrencyMismatchError`.
- **Métodos de Domínio:**
  - `add(other: Money): Money`
  - `subtract(other: Money): Money`
  - `negate(): Money`
  - `isZero(): boolean`
  - `isPositive(): boolean`
  - `isNegative(): boolean`
  - `isLessThan(other: Money): boolean`
  - `equals(other: Money): boolean`
  - `toJSON(): MoneyProps` (com `{ amount: string, currency: string }`)
  - `toString(): string`

---

### 2.2 Aggregate Root: `Wallet`
Representa a carteira do jogador para uma moeda específica.

- **Identidade e Unicidade:** Identificada por `id` (UUIDv7) e com regra de unicidade no par `(playerId, currency)`.
- **Propriedades:**
  - `id: string`
  - `playerId: string`
  - `currency: string`
  - `_balance: Money` (privado)
  - `_version: number` (inicia em 1, incrementa exclusivamente em mutações de saldo)
  - `createdAt: Date`
  - `_updatedAt: Date`
- **Invariantes do Agregado:**
  - Saldo nunca pode ser negativo (`_balance.isNegative() === false`).
  - Cada movimentação de saldo (`credit` ou `debit`) gera obrigatoriamente um `WalletLedgerEntry` correspondente.
  - `version` inicia em 1 na abertura da carteira e é incrementada a cada crédito ou débito aplicado.
  - A moeda da operação deve coincidir exatamente com a moeda da carteira.
- **Transições e Comportamentos:**
  - `static open(props: { id: string, playerId: string, initialBalance: Money }): { wallet: Wallet, entry?: WalletLedgerEntry }`
    - Se `initialBalance > 0`, gera lançamento de crédito de abertura com direção `CREDIT`.
  - `debit(amount: Money, transactionId: string): { entry: WalletLedgerEntry }`
    - Lança `InsufficientBalanceError` se `_balance.isLessThan(amount)`.
    - Deduz saldo, incrementa `version`, atualiza `_updatedAt` e gera `WalletLedgerEntry` com direção `DEBIT`.
  - `credit(amount: Money, transactionId: string): { entry: WalletLedgerEntry }`
    - Adiciona saldo, incrementa `version`, atualiza `_updatedAt` e gera `WalletLedgerEntry` com direção `CREDIT`.
  - `static rehydrate(state: WalletState): Wallet`
    - Reconstrói a carteira a partir da persistência sem disparar validações de transição de estado.

---

### 2.3 Entidade: `WagerTransaction`
Representa a transação de aposta solicitada por um provedor.

#### Tipos de Transação (`WagerTransactionKind`):
- `OPENING`: Crédito inicial interno na abertura da carteira. **Nunca submetido via API ou mensageria externa.**
- `BET`: Débito de aposta na carteira do jogador.
- `WIN`: Crédito de prêmio ganho pelo jogador em uma rodada.
- `LOSS`: Resultado de rodada perdida sem premiação (não altera saldo, não gera ledger).
- `REFUND`: Estorno de uma aposta (`BET`) cancelada ou anulada.
- `ROLLBACK`: Reversão de uma transação anterior (`BET`, `WIN` ou `REFUND`).

#### Ciclo de Vida e Estados (`WagerTransactionStatus`):
```
                       ┌────────────────────────┐
                       │        PENDING         │
                       └───────────┬────────────┘
                                   │
               ┌───────────────────┼───────────────────┐
               ▼                   ▼                   ▼
    ┌──────────────────────┐ ┌───────────┐ ┌──────────────────────┐
    │  PENDING_REFERENCE   │ │ PROCESSED │ │       REJECTED       │
    └──────────┬───────────┘ └───────────┘ └──────────────────────┘
               │ (retry / timeout)
               ├───────────────────┐
               ▼                   ▼
         ┌───────────┐       ┌───────────┐
         │ PROCESSED │       │ REJECTED  │
         └───────────┘       └───────────┘
```

- `PENDING`: Estado inicial após recebimento e validação estrutural.
- `PENDING_REFERENCE`: Transação dependente (`REFUND` ou `ROLLBACK`) aguardando a chegada da transação referenciada.
- `PROCESSED`: **Terminal.** Transação aplicada com sucesso financeiro.
- `REJECTED`: **Terminal.** Transação rejeitada por regra de negócio (ex: saldo insuficiente, referência inválida, tipo incompatível).
- `FAILED`: **Terminal.** Falha permanente auditável de infraestrutura.

#### Regras de Transição e Invariantes:
- Uma vez em estado terminal (`PROCESSED`, `REJECTED`, `FAILED`), qualquer tentativa de transição subsequente lança `InvalidTransactionStateError`.
- `payloadHash`: SHA-256 do JSON canônico dos campos de negócio.
- Replay com a mesma chave e mesmo hash é idempotente; mesmo hash diferente gera `409 Conflict`.
- `requiresReference()`: retorna `true` para `REFUND` e `ROLLBACK`.
- `affectsBalance()`: retorna `false` para `LOSS`.

---

### 2.4 Entidade Imutável: `WalletLedgerEntry`
Registro contábil financeiro do ledger. **Estritamente imutável**: sem métodos de mutação (`setters`).

- **Propriedades:**
  - `id: string` (UUIDv7 ordenável cronologicamente)
  - `walletId: string`
  - `transactionId: string`
  - `direction: LedgerDirection` (`DEBIT` ou `CREDIT`)
  - `money: Money`
  - `balanceBefore: Money`
  - `balanceAfter: Money`
  - `createdAt: Date`
- **Validação Aritmética na Factory:**
  ```ts
  if (direction === LedgerDirection.Credit) {
    balanceBefore.add(money).equals(balanceAfter) === true;
  } else {
    balanceBefore.subtract(money).equals(balanceAfter) === true;
  }
  ```
  Se a equação contábil falhar, o construtor/factory lança `UnbalancedLedgerEntryError`.
- **Invariante de Cardinalidade:** No máximo 1 lançamento por transação financeira e carteira.

---

### 2.5 Entidade: `InboxMessage`
Responsável pela deduplicação persistente de mensagens recebidas de mensageria assíncrona (SQS).

- `messageId: string`
- `consumerName: string`
- `payloadHash: string`
- `receivedAt: Date`
- `_processedAt?: Date`
- Métodos: `markProcessed(at: Date): void`, `isProcessed(): boolean`.

---

### 2.6 Entidade: `OutboxMessage`
Responsável pelo padrão Transactional Outbox para publicação atômica e recuperável de eventos de integração.

- `id: string`
- `aggregateId: string`
- `eventType: string`
- `payload: Record<string, unknown>` (Envelope padronizado)
- `occurredAt: Date`
- `_attempts: number`
- `_nextAttemptAt?: Date`
- `_publishedAt?: Date`
- Métodos: `markPublished(at: Date)`, `scheduleRetry(now: Date, delaySeconds: number)`.

---

## 3. Matriz de Operações de Apostas

| Operação | Efeito no Saldo | Direção no Ledger | Exige Referência? | Tipos de Referência Aceitos | Regra Específica |
|---|---|---|---|---|---|
| `OPENING` | Crédito | `CREDIT` | Não | N/A | Exclusivo para saldo inicial da carteira na criação. |
| `BET` | Débito | `DEBIT` | Não | N/A | Rejeita com `INSUFFICIENT_FUNDS` se saldo < aposta. |
| `WIN` | Crédito | `CREDIT` | Opcional | `BET` | Pode referenciar a `BET` da mesma rodada para rastreabilidade. |
| `LOSS` | Nenhum | Nenhuma entrada | Opcional | `BET` | Registra encerramento da rodada sem movimentação de saldo. |
| `REFUND` | Crédito | `CREDIT` | **Sim** | `BET` | Reverte uma `BET` processada. Valor idêntico. Reversão única. |
| `ROLLBACK` | Inverso da referência | Inverso da referência | **Sim** | `BET`, `WIN`, `REFUND` | Inverte o efeito financeiro da transação referenciada. Valor idêntico. |

---

## 4. Taxonomia de Códigos de Falha (`FailureCode`)

Toda rejeição de negócio é persistida com um `FailureCode` padronizado e auditável:

| FailureCode | Significado | HTTP Status |
|---|---|---|
| `INSUFFICIENT_FUNDS` | Carteira não possui saldo suficiente para debitar a aposta. | `422 Unprocessable Entity` |
| `REFERENCE_NOT_FOUND` | Transação referenciada não existe ou expirou aguardando reprocessamento. | `422 Unprocessable Entity` |
| `REFERENCE_ALREADY_REVERSED` | A transação referenciada já sofreu reversão anterior pelo mesmo tipo. | `422 Unprocessable Entity` |
| `INVALID_REFERENCE_KIND` | O tipo da transação referenciada não é compatível com a operação atual. | `422 Unprocessable Entity` |
| `REFERENCE_MISMATCH` | Incompatibilidade de provedor, jogador, moeda, carteira ou rodada com a referência. | `422 Unprocessable Entity` |
| `AMOUNT_MISMATCH` | O valor da reversão difere do valor da transação referenciada. | `422 Unprocessable Entity` |
| `REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE` | O rollback de um crédito anterior produziria saldo negativo na carteira. | `422 Unprocessable Entity` |
| `CURRENCY_MISMATCH` | A moeda enviada na operação é incompatível com a carteira ou com a referência. | `422 Unprocessable Entity` |
| `INVALID_PAYLOAD` | Dados estruturais inválidos no payload da requisição. | `400 Bad Request` |
| `IDEMPOTENCY_PAYLOAD_MISMATCH` | Mesma Idempotency-Key enviada com payload divergente. | `409 Conflict` |
| `TRANSACTION_ALREADY_TERMINAL` | Tentativa inválida de alterar transação já finalizada. | `409 Conflict` |
| `INTERNAL_INFRASTRUCTURE_ERROR` | Falha inesperada de infraestrutura de banco ou mensageria. | `500 Internal Server Error` |
