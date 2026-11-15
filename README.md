# Distributed Wagering Processor 🦧

Serviço financeiro distribuído de alta resiliência e correção contábil para processamento de transações de apostas de cassino online (iGaming), desenvolvido conforme os requisitos do **Technical Challenge — Distributed Wagering Processor** da Jungle Gaming.

---

## 1. Stack Tecnológica Obrigatória

| Camada | Tecnologia | Detalhes |
|---|---|---|
| **Runtime & Test Runner** | **Bun 1.x** (v1.4.4) | Execução veloz, resolução nativa de TypeScript e executor de testes |
| **Linguagem** | **TypeScript** | Strict mode habilitado |
| **Framework** | **NestJS 11** | Modular Monolith com Arquitetura Hexagonal |
| **Banco de Dados** | **PostgreSQL 16** | ACID, Constraints invioláveis e Lock Pessimista por linha |
| **ORM** | **MikroORM 6** | Unit of Work, Identity Map explícito e Migrations reversíveis |
| **Mensageria** | **AWS SQS FIFO** | Filas FIFO locais via LocalStack 3.8 com DLQ |
| **Orquestração Local** | **Docker Compose** | Contêineres reproduzíveis |
| **Aritmética Financeira** | **Decimal.js** | Escala fixa de 2 casas, zero float/double |
| **Logs Estruturados** | **Pino** | JSON estruturado com correlação e mascaramento de dados sensíveis |

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

As seguintes filas FIFO são criadas automaticamente pelo script de inicialização do LocalStack (`docker/init-sqs.sh`):
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

---

## 5. Endpoints de Verificação e Saúde

- `GET http://localhost:3000/health/live` — Sonda de Liveness (processo vivo)
- `GET http://localhost:3000/health/ready` — Sonda de Readiness (validação em tempo real de PostgreSQL e AWS SQS)

Exemplo de retorno do `/health/ready`:
```json
{
  "status": "ok",
  "info": {
    "postgres": { "status": "up" },
    "sqs": { "status": "up", "queuesFound": 2 }
  },
  "error": {},
  "details": {
    "postgres": { "status": "up" },
    "sqs": { "status": "up", "queuesFound": 2 }
  }
}
```

---

## 6. Comandos de Testes

```bash
# Executar todos os testes
bun run test

# Executar apenas testes unitários
bun run test:unit

# Executar testes de integração (com PostgreSQL e SQS reais em contêineres)
bun run test:integration

# Executar testes de concorrência e race conditions
bun run test:concurrency

# Executar teste de carga (diferencial)
bun run test:load
```

---

## 7. Documentação Completa do Projeto

- 📘 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — Decisões de arquitetura, concorrência, idempotência e resiliência
- 📐 [docs/DOMAIN.md](docs/DOMAIN.md) — Modelos, Value Objects, estados e matriz de operações
- 🗄️ [docs/DATABASE.md](docs/DATABASE.md) — Schema relacional, constraints invioláveis e índices
- 📨 [docs/EVENTS.md](docs/EVENTS.md) — Envelopes de eventos de integração e contratos
- 🌐 [docs/API.md](docs/API.md) — Contratos REST, status HTTP e paginação por cursor
- 🧪 [docs/TESTING.md](docs/TESTING.md) — Estratégia de testes e os 8 cenários obrigatórios de concorrência
- 🗺️ [docs/ROADMAP.md](docs/ROADMAP.md) — Roteiro de fases e critérios de aceitação
