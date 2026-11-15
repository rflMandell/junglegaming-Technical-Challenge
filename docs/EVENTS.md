# Integration Events Specification & Contracts

## 1. Visão Geral dos Eventos de Integração

O **Distributed Wagering Processor** utiliza eventos de integração para comunicar mudanças de estado do domínio para sistemas externos e downstream consumers (analytics, auditoria, backoffice, relatórios em tempo real).

Todos os eventos são persistidos via **Transactional Outbox** na mesma transação atômica das mutações financeiras e publicados de forma assíncrona com semântica *at-least-once*.

---

## 2. Envelope Padrão de Integração (`IntegrationEvent`)

Todos os eventos estendem a classe abstrata `IntegrationEvent<T>` com envelope uniforme:

```ts
export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = Object.freeze(props.data);
  }

  toJSON() {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      version: this.version,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      causationId: this.causationId,
      occurredAt: this.occurredAt.toISOString(),
      data: this.data,
    };
  }
}
```

### Regras do Envelope:
1. `eventId`: Identificador único do evento (UUIDv7).
2. `eventType`: Nome canônico da classe de evento.
3. `version`: Versão numérica inteira do schema do evento (inicia em 1).
4. `aggregateId`: ID do agregado principal (`walletId` ou `transactionId`).
5. `correlationId`: ID de correlação ponta a ponta (propagado do request HTTP ou mensagem SQS).
6. `causationId`: ID da mensagem ou transação causal imediata.
7. `occurredAt`: Timestamp ISO-8601 em UTC.
8. `data`: Payload com tipagem estrita. **Valores monetários sempre trafegam como `MoneyProps` (`{ amount: string, currency: string }`), jamais como floats ou instâncias ricas da classe `Money`.**

---

## 3. Eventos Mínimos do Sistema

### 3.1 `WalletBalanceChanged`
Disparado **somente** quando há alteração efetiva de saldo na carteira (seja por `OPENING`, `BET`, `WIN`, `REFUND` ou `ROLLBACK`).

```json
{
  "eventId": "0192f298-345e-7e38-af88-e43f851a819d",
  "eventType": "WalletBalanceChanged",
  "version": 1,
  "aggregateId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "correlationId": "corr-987-abc",
  "causationId": "0192f298-345e-7e38-af88-e43f851a8190",
  "occurredAt": "2026-11-14T21:00:00.000Z",
  "data": {
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "transactionId": "0192f298-345e-7e38-af88-e43f851a8190",
    "direction": "DEBIT",
    "money": {
      "amount": "25.00",
      "currency": "BRL"
    },
    "balanceBefore": {
      "amount": "100.00",
      "currency": "BRL"
    },
    "balanceAfter": {
      "amount": "75.00",
      "currency": "BRL"
    },
    "walletVersion": 2
  }
}
```

---

### 3.2 `WagerTransactionProcessed`
Disparado quando qualquer transação é aplicada com sucesso, **inclusive `LOSS`** (que não afeta saldo).

```json
{
  "eventId": "0192f298-345e-7e38-af88-e43f851a819e",
  "eventType": "WagerTransactionProcessed",
  "version": 1,
  "aggregateId": "0192f298-345e-7e38-af88-e43f851a8190",
  "correlationId": "corr-987-abc",
  "causationId": "msg-123",
  "occurredAt": "2026-11-14T21:00:00.000Z",
  "data": {
    "transactionId": "0192f298-345e-7e38-af88-e43f851a8190",
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": {
      "amount": "25.00",
      "currency": "BRL"
    },
    "referenceTransactionId": null,
    "processedAt": "2026-11-14T21:00:00.000Z"
  }
}
```

---

### 3.3 `WagerTransactionRejected`
Disparado quando uma transação é rejeitada por violação de regra de negócio (ex: saldo insuficiente, reversão inválida, timeout de referência).

```json
{
  "eventId": "0192f298-345e-7e38-af88-e43f851a819f",
  "eventType": "WagerTransactionRejected",
  "version": 1,
  "aggregateId": "0192f298-345e-7e38-af88-e43f851a8191",
  "correlationId": "corr-987-xyz",
  "causationId": "msg-456",
  "occurredAt": "2026-11-14T21:00:01.000Z",
  "data": {
    "transactionId": "0192f298-345e-7e38-af88-e43f851a8191",
    "providerId": "provider-a",
    "externalTransactionId": "transaction-456",
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "kind": "BET",
    "money": {
      "amount": "500.00",
      "currency": "BRL"
    },
    "failureCode": "INSUFFICIENT_FUNDS",
    "reason": "Wallet current balance is lower than the requested bet amount"
  }
}
```

---

### 3.4 `WagerTransactionPendingReference`
Disparado quando uma operação de estorno/reversão (`REFUND` ou `ROLLBACK`) chega antes da transação referenciada.

```json
{
  "eventId": "0192f298-345e-7e38-af88-e43f851a81a0",
  "eventType": "WagerTransactionPendingReference",
  "version": 1,
  "aggregateId": "0192f298-345e-7e38-af88-e43f851a8192",
  "correlationId": "corr-987-ooo",
  "causationId": "msg-789",
  "occurredAt": "2026-11-14T21:00:02.000Z",
  "data": {
    "transactionId": "0192f298-345e-7e38-af88-e43f851a8192",
    "providerId": "provider-a",
    "externalTransactionId": "transaction-789",
    "referenceExternalTransactionId": "transaction-123",
    "kind": "REFUND",
    "money": {
      "amount": "25.00",
      "currency": "BRL"
    },
    "nextRetryAt": "2026-11-14T21:00:07.000Z"
  }
}
```

---

## 4. Diretrizes de Versionamento e Evolução de Contratos

1. **Adições Não Quebrantes (Backward Compatible):**
   - Novos campos opcionais no objeto `data` não alteram a versão do evento.
   - Consumidores devem ignorar campos desconhecidos (*tolerant reader pattern*).
2. **Alterações Quebrantes (Breaking Changes):**
   - Renomear ou remover campos existentes ou alterar a semântica exige incremento do campo `version` (ex: `version: 2`).
   - A Outbox e publicadores devem suportar publicar ambas as versões durante períodos de migração caso existam consumidores legados.
