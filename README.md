# Distributed Wagering Processor 🦧

Serviço financeiro distribuído de alta resiliência e correção contábil para processamento de transações de apostas de cassino online (iGaming), desenvolvido conforme as especificações do **Technical Challenge — Distributed Wagering Processor** da Jungle Gaming.

---

## 1. Stack Tecnológica Obrigatória

| Camada | Tecnologia | Detalhes |
|---|---|---|
| **Runtime & Test Runner** | **Bun 1.x** (v1.4.4) | Execução veloz, resolução nativa de TypeScript e executor de testes |
| **Linguagem** | **TypeScript** | Strict mode habilitado em todo o projeto |
| **Framework** | **NestJS 11** | Monólito Modular com Arquitetura Hexagonal |
| **Banco de Dados** | **PostgreSQL 16** | ACID, Constraints invioláveis e Lock Pessimista por linha |
| **ORM** | **MikroORM 6** | Unit of Work, Identity Map explícito e Migrations reversíveis |
| **Mensageria** | **AWS SQS FIFO** | Filas FIFO locais via LocalStack 3.8 com DLQ |
| **Orquestração Local** | **Docker Compose** | Contêineres reproduzíveis |
| **Aritmética Financeira** | **Decimal.js** | Escala fixa de 2 casas decimais, zero float/double |
| **Logs Estruturados** | **Pino (nestjs-pino)** | JSON estruturado com Correlation ID e mascaramento de dados |
| **Métricas** | **Prometheus Telemetry** | `/metrics` padrão com quantis e suporte a JSON estruturado |

---

## 2. Requisitos Prévios

- [Bun](https://bun.sh/) `>= 1.1.0`
- [Docker](https://www.docker.com/) e Docker Compose

---

## 3. Configuração Rápida do Ambiente Local

### 1. Clonar e Instalar Dependências
```bash
bun install
```

### 2. Configurar Variáveis de Ambiente
```bash
cp .env.example .env
```

### 3. Subir Serviços em Contêineres (PostgreSQL + LocalStack SQS)
```bash
docker compose up -d postgres localstack
```

As filas FIFO são criadas automaticamente pelo script de inicialização do LocalStack (`docker/init-sqs.sh`):
- `wager-transactions-dlq.fifo` (Dead Letter Queue)
- `wager-transactions.fifo` (Fila principal com RedrivePolicy apontando para a DLQ)

---

## 4. Executando a Aplicação

### Em modo de desenvolvimento (Hot-reload):
```bash
bun run dev
```

### Build e Execução de Produção:
```bash
bun run build
bun run start
```

### Executar a stack completa via Docker Compose:
```bash
docker compose up -d
```

### Documentação OpenAPI / Swagger interativa:
Acesse no navegador:
👉 **[http://localhost:3000/api/docs](http://localhost:3000/api/docs)**

---

## 5. Exemplos de Uso com cURL

### 5.1 Criar Carteira com Saldo Inicial
```bash
curl -X POST http://localhost:3000/wallets \
  -H "Content-Type: application/json" \
  -d '{
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "initialBalance": {
      "amount": "1000.00",
      "currency": "BRL"
    }
  }'
```

### 5.2 Consultar Saldo da Carteira
```bash
curl http://localhost:3000/wallets/0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1
```

### 5.3 Consultar Extrato Contábil com Paginação por Cursor
```bash
curl "http://localhost:3000/wallets/<walletId>/ledger?limit=10"
```

### 5.4 Processar Aposta com Idempotência Estrita
```bash
curl -X POST http://localhost:3000/wagering/transactions \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: provider-1:bet-tx-001" \
  -d '{
    "providerId": "provider-1",
    "externalTransactionId": "bet-tx-001",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "<walletId>",
    "roundId": "round-100",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "50.00", "currency": "BRL" }
  }'
```

*Repetir o mesmo comando com o mesmo cabeçalho retorna imediatamente `idempotentReplay: true` sem duplicar o débito.*

### 5.5 Reconciliação Financeira em Tempo Real
```bash
curl -X POST http://localhost:3000/wallets/<walletId>/reconciliation
```
Retorno:
```json
{
  "walletId": "...",
  "storedBalance":     { "amount": "950.00", "currency": "BRL" },
  "calculatedBalance": { "amount": "950.00", "currency": "BRL" },
  "difference":        { "amount": "0.00",   "currency": "BRL" },
  "consistent": true,
  "checkedEntries": 2
}
```

### 5.6 Telemetria e Métricas Prometheus
```bash
# Formato padrão Prometheus:
curl http://localhost:3000/metrics

# Formato JSON estruturado:
curl "http://localhost:3000/metrics?format=json"
```

### 5.7 Health Checks (Liveness e Readiness)
```bash
# Sonda de Liveness (processo ativo):
curl http://localhost:3000/health/live

# Sonda de Readiness (PostgreSQL + SQS operacionais):
curl http://localhost:3000/health/ready
```

---

## 6. Comandos de Testes

Os testes executam contra instâncias reais em contêineres do PostgreSQL e LocalStack SQS:

```bash
# Executar toda a suíte (unitários, integração e concorrência)
bun run test

# Executar apenas testes unitários (Money, Wallet, Ledger, Eventos)
bun run test:unit

# Executar testes de integração (Banco, Transações, SQS, Outbox, Reconciliação, Observabilidade)
bun run test:integration

# Executar testes de concorrência real (50 apostas simultâneas, hot wallet 2x80 em 100)
bun run test:concurrency
```

---

## 7. Destaques de Arquitetura e Decisões Técnicas

- **Pessimistic Lock (`SELECT ... FOR UPDATE`):** O `walletId` é a unidade de concorrência. Evita lost updates e saldos negativos sem a tempestade de rollbacks característica do Optimistic Locking.
- **Idempotência Canônica Persistente:** Normalização de JSON e hash SHA-256 no banco garantem replay idêntico e rejeição de conflitos com `409 Conflict`.
- **Inbox & Transactional Outbox:** Garantia de entrega *Exactly-Once semântica*. Operações de banco comitam atomicamente o débito, o ledger, o Inbox e a Outbox.
- **Operações Fora de Ordem (`PENDING_REFERENCE`):** Reversões (`REFUND`/`ROLLBACK`) que chegam antes da `BET` aguardam em estado pendente e são reprocessadas com backoff pelo worker agendado.
- **Auditoria Contábil Contínua:** Ledger de partidas dobradas e endpoint de reconciliação que audita o saldo sem correções silenciosas.

---

## 8. Limitações Declaradas

1. **Escala Geodistribuída Multi-Região Ativo-Ativo:** Locks pessimistas por linha exigem baixa latência com o cluster primário de banco de dados. Em produção global, requer particionamento geográfico de carteiras por região.
2. **Separação de Leitura (CQRS):** Em cenários de tráfego de leitura massivo, queries de extrato contábil devem ser apontadas para réplicas de leitura assíncronas do PostgreSQL.

---

## 9. Documentação Detalhada

- 📘 [ARCHITECTURE.md](ARCHITECTURE.md) / [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — Decisões de design, perguntas da apresentação técnica e trade-offs
- 📐 [docs/DOMAIN.md](docs/DOMAIN.md) — Agregados, Value Objects, matriz de operações e invariantes
- 🗄️ [docs/DATABASE.md](docs/DATABASE.md) — Schema relacional PostgreSQL, índices e constraints invioláveis
- 📨 [docs/EVENTS.md](docs/EVENTS.md) — Contratos e envelopes de eventos de integração versionados
- 🌐 [docs/API.md](docs/API.md) — Especificação Swagger/OpenAPI e contratos REST
- 🧪 [docs/TESTING.md](docs/TESTING.md) — Estratégia de testes e os cenários obrigatórios de concorrência
- 🗺️ [docs/ROADMAP.md](docs/ROADMAP.md) — Roteiro de fases concluído
