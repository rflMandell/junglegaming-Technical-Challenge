# HTTP API Contracts & Response Codes

## 1. Visão Geral da API HTTP

A API do **Distributed Wagering Processor** oferece endpoints RESTful para gestão de carteiras, submissão síncrona de apostas, consultas auditáveis, histórico financeiro por cursor opaco e reconciliação financeira.

### Headers Globais
- `Content-Type: application/json`
- `X-Correlation-Id: <uuid>` (Opcional no envio; gerado pela API se ausente e retornado no cabeçalho de resposta).
- `Idempotency-Key: <string>` (Obrigatório em `POST /wagering/transactions`).

---

## 2. Especificação dos Endpoints

### 2.1 Criar Carteira (`POST /wallets`)
Cria uma nova carteira para um jogador com uma moeda específica e saldo inicial opcional.

#### Request
```http
POST /wallets HTTP/1.1
Content-Type: application/json

{
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "initialBalance": {
    "amount": "1000.00",
    "currency": "BRL"
  }
}
```

#### Response (201 Created)
```json
{
  "id": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "currency": "BRL",
  "balance": {
    "amount": "1000.00",
    "currency": "BRL"
  },
  "version": 1,
  "createdAt": "2026-11-14T21:00:00.000Z"
}
```

#### Respostas de Erro:
- `400 Bad Request`: Payload com campos obrigatórios ausentes ou `Money` inválido.
- `409 Conflict`: Já existe carteira para o par `(playerId, currency)`.

---

### 2.2 Consultar Carteira (`GET /wallets/:walletId`)
Retorna os dados cadastrais e saldo atual da carteira.

#### Response (200 OK)
```json
{
  "id": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "currency": "BRL",
  "balance": {
    "amount": "975.00",
    "currency": "BRL"
  },
  "version": 2,
  "createdAt": "2026-11-14T21:00:00.000Z",
  "updatedAt": "2026-11-14T21:05:00.000Z"
}
```

---

### 2.3 Consultar Histórico do Ledger (`GET /wallets/:walletId/ledger`)
Retorna os lançamentos do ledger paginados via **cursor estável e opaco**.

#### Parâmetros de Query:
- `cursor`: Token opaco codificado em Base64 contendo `(createdAt, id)` do último item lido.
- `limit`: Quantidade de itens (default: 50, máx: 100).

#### Response (200 OK)
```json
{
  "items": [
    {
      "id": "0192f298-345e-7e38-af88-e43f851a8190",
      "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
      "transactionId": "0192f298-345e-7e38-af88-e43f851a8190",
      "direction": "DEBIT",
      "money": { "amount": "25.00", "currency": "BRL" },
      "balanceBefore": { "amount": "1000.00", "currency": "BRL" },
      "balanceAfter": { "amount": "975.00", "currency": "BRL" },
      "createdAt": "2026-11-14T21:05:00.000Z"
    }
  ],
  "nextCursor": "ZXlKamJHbGpkR0Z5WldWME9qRXpNekV4TkRRNU9UQXhNVjh4TFRReU5qSXlPRFV5TlRFM01qSXpOVEkwTWpBPQ==",
  "hasMore": true
}
```

---

### 2.4 Submeter Transação de Aposta (`POST /wagering/transactions`)
Endpoint principal de processamento financeiro síncrono.

#### Headers:
- `Idempotency-Key: provider-a:transaction-123` (Obrigatório)

#### Request Body
```json
{
  "providerId": "provider-a",
  "externalTransactionId": "transaction-123",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": {
    "amount": "25.00",
    "currency": "BRL"
  },
  "referenceExternalTransactionId": null
}
```

#### Response (201 Created — Nova transação processada)
```json
{
  "transactionId": "0192f298-345e-7e38-af88-e43f851a8190",
  "status": "PROCESSED",
  "balance": {
    "amount": "975.00",
    "currency": "BRL"
  },
  "idempotentReplay": false
}
```

#### Response (200 OK — Replay Idêntico Idempotente)
```json
{
  "transactionId": "0192f298-345e-7e38-af88-e43f851a8190",
  "status": "PROCESSED",
  "balance": {
    "amount": "975.00",
    "currency": "BRL"
  },
  "idempotentReplay": true
}
```

#### Response (202 Accepted — Referência Pendente)
Ocorre quando `REFUND` ou `ROLLBACK` chega antes da transação referenciada:
```json
{
  "transactionId": "0192f298-345e-7e38-af88-e43f851a8192",
  "status": "PENDING_REFERENCE",
  "balance": {
    "amount": "975.00",
    "currency": "BRL"
  },
  "idempotentReplay": false
}
```

#### Respostas de Erro de Negócio e Conflito:
- `400 Bad Request`: Ausência do header `Idempotency-Key` ou corpo de requisição malformado.
- `409 Conflict`: Mesma `Idempotency-Key` enviada com payload divergente (`IDEMPOTENCY_PAYLOAD_MISMATCH`).
- `422 Unprocessable Entity`: Violação de regra de negócio:
  ```json
  {
    "statusCode": 422,
    "error": "Unprocessable Entity",
    "failureCode": "INSUFFICIENT_FUNDS",
    "message": "Insufficient funds to execute BET operation",
    "transactionId": "0192f298-345e-7e38-af88-e43f851a8193"
  }
  ```

---

### 2.5 Consultar Transação por ID Interno (`GET /wagering/transactions/:transactionId`)
Retorna os detalhes completos e auditáveis de uma transação pelo seu ID interno.

#### Response (200 OK)
```json
{
  "id": "0192f298-345e-7e38-af88-e43f851a8190",
  "providerId": "provider-a",
  "externalTransactionId": "transaction-123",
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" },
  "status": "PROCESSED",
  "failureCode": null,
  "createdAt": "2026-11-14T21:05:00.000Z",
  "processedAt": "2026-11-14T21:05:00.050Z"
}
```

---

### 2.6 Consultar Transação por Provedor e ID Externo (`GET /providers/:providerId/wagering/transactions/:externalTransactionId`)
Facilita reconciliação do lado do provedor utilizando os identificadores do próprio provedor.

#### Response (200 OK)
Mesma estrutura de `2.5`. Retorna `404 Not Found` se não localizada.

---

### 2.7 Reconciliação Financeira de Carteira (`POST /wallets/:walletId/reconciliation`)
Audita em tempo real o saldo materializado comparando-o com a somatória reconstruída a partir de todos os lançamentos do ledger da carteira.

#### Response (200 OK)
```json
{
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "storedBalance": {
    "amount": "975.00",
    "currency": "BRL"
  },
  "calculatedBalance": {
    "amount": "975.00",
    "currency": "BRL"
  },
  "difference": {
    "amount": "0.00",
    "currency": "BRL"
  },
  "consistent": true,
  "checkedEntries": 42
}
```
*Nota: Se `consistent === false`, o endpoint retorna HTTP 200 sinalizando a inconsistência no payload estruturado e dispara logs e alertas operacionais críticos.*

---

### 2.8 Health Checks
Endpoints públicos (sem autenticação) para sondas de orquestração (Kubernetes / Docker Compose):

- `GET /health/live`: Retorna `200 OK` (`{ "status": "ok" }`) se o processo Node/Bun estiver respondendo.
- `GET /health/ready`: Valida conectividade real com PostgreSQL e LocalStack SQS. Retorna `200 OK` se ambos estiverem operacionais; retorna `503 Service Unavailable` com relatório de dependências caso algum esteja inalcançável.
