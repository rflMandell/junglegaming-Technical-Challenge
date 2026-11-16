# Architecture & System Design — Distributed Wagering Processor

> Documentação oficial de arquitetura, padrões distribuídos, concorrência, resiliência e decisões técnicas do **Distributed Wagering Processor**.

---

## 1. Visão Geral e Filosofia Arquitetural

O **Distributed Wagering Processor** foi construído como um **Monólito Modular** com foco estrito em **Domain-Driven Design (DDD)** e **Arquitetura Hexagonal (Ports and Adapters)**.

### Por que Monólito Modular sobre Microserviços?
- **Garantia ACID Estrita:** Permite transações atômicas nativas no PostgreSQL entre alteração de saldo, registro no ledger contábil, deduplicação no Inbox e registro no Transactional Outbox.
- **Zero Overhead de Rede Interna:** Elimina a latência e o risco de falhas parciais (dual-write, Sagas com consistência eventual) entre serviços altamente acoplados (Wallet, Ledger, Wagering).
- **Fronteiras Claras:** Os módulos possuem isolamento estrito de código (`domain`, `application`, `infrastructure`, `presentation`). Se no futuro um módulo demandar escalabilidade independente, sua extração para microsserviço é direta.

---

## 2. Padrões Arquiteturais e Separação de Camadas

```text
src/modules/<modulo>/
├── domain/            # Regras puras, entidades, value objects, invariantes, domain errors.
│                      # ZERO dependências de frameworks ou ORM (exceto Decimal.js).
├── application/       # Casos de uso (UseCases), DTOs de aplicação, portas de entrada e saída.
├── infrastructure/    # Adaptadores secundários: MikroORM entities, repositórios, workers, SQS.
└── presentation/      # Adaptadores primários: Controllers HTTP (NestJS), Consumers SQS, filtros.
```

### Princípios de Dependência
1. **Regra de Dependência:** O fluxo de dependência aponta exclusivamente para dentro. O Domínio não conhece Aplicação nem Infraestrutura. A Aplicação define interfaces (Portas). A Infraestrutura implementa essas interfaces (Adaptadores).
2. **Isolamento de ORM:** As entidades de domínio (`Wallet`, `WagerTransaction`, `WalletLedgerEntry`) são completamente desacopladas do MikroORM. O mapeamento relacional utiliza entidades em `infrastructure` com mapeadores bidirecionais (`toDomain` e `fromDomain`).

---

## 3. Concorrência e Estratégia de Lock por Carteira (`walletId`)

### Decisão Técnica: Pessimistic Write Lock (`SELECT ... FOR UPDATE`)
1. **Unidade de Concorrência:** O `walletId` é a unidade exclusiva de concorrência. Não há locks globais. Carteiras distintas processam em total paralelismo.
2. **Serialização por Linha:** Ao iniciar uma transação sobre uma carteira, o sistema executa:
   ```sql
   SELECT * FROM wallets WHERE id = :walletId FOR UPDATE;
   ```
   Isso enfileira temporária e deterministicamente as operações simultâneas sobre a mesma carteira diretamente no engine do PostgreSQL.
3. **Pessimistic vs Optimistic Locking:** Em carteiras ativas com apostas simultâneas, o Optimistic Locking gera tempestades de aborts, retries caros e consumo excessivo de CPU. O Pessimistic Lock mantém transações SQL curtas (< 5ms) com tempo previsível.
4. **Proteção Inviolável do Banco:** Tabela `wallets` possui constraint `CHECK (balance >= 0)`.

---

## 4. Idempotência Persistente e Hashing Canônico

### Header Obrigatório
Toda operação financeira enviada via HTTP exige:
```http
Idempotency-Key: <providerId>:<externalTransactionId>
```

### Algoritmo de Hashing Canônico
1. **Campos Relevantes:** `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money.amount`, `money.currency`, `referenceExternalTransactionId`.
2. **Normalização:** Chaves ordenadas alfabeticamente de forma recursiva (Canonical JSON) e sem espaços desnecessários.
3. **Hash SHA-256:** O hash hexadecimal resultante é gravado no campo `payload_hash`.
4. **Tratamento:**
   - **Replay Idêntico:** Mesma chave e mesmo hash $\rightarrow$ retorna resultado original com `idempotentReplay: true`.
   - **Conflito de Payload:** Mesma chave com hash divergente $\rightarrow$ rejeição imediata com `409 Conflict` (`IDEMPOTENCY_PAYLOAD_MISMATCH`).

---

## 5. Padrões de Resiliência: Inbox e Transactional Outbox

```text
                               ┌──────────────────────────────────────────────┐
                               │            Transação Atômica PostgreSQL       │
                               │                                              │
 [SQS Message / HTTP Request] ──► [1. Inbox / Idempotency Check]               │
                               │  [2. Wallet Lock (FOR UPDATE) & Balance Mod] │
                               │  [3. Ledger Entry Insertion]                 │
                               │  [4. WagerTransaction Insertion/Update]      │
                               │  [5. Outbox Message Insertion]               │
                               └──────────────────────┬───────────────────────┘
                                                      │ COMMIT
                                                      ▼
                                         [Outbox Background Worker]
                                                      │
                                                      ▼
                                         [AWS SQS / Event Topic]
```

- **Inbox Pattern:** Tabela `inbox_messages` (`consumer_name`, `message_id`). Deduplica mensagens assíncronas do SQS atomicamente dentro da transação financeira. O ACK na fila só ocorre após o commit no banco de dados.
- **Transactional Outbox:** Eventos de integração são gravados na tabela `outbox_messages` atomicamente com a mutação financeira. Um worker com `SELECT ... FOR UPDATE SKIP LOCKED` lê os eventos e publica no SQS, garantindo entrega sem perda mesmo diante de crash do processo.

---

## 6. Operações Fora de Ordem (`REFUND` / `ROLLBACK` antes de `BET`)

1. **Estado `PENDING_REFERENCE`:** Se `REFUND` ou `ROLLBACK` chega antes da `BET`, a transação é gravada como `PENDING_REFERENCE` e o evento correspondente é emitido na Outbox.
2. **Reprocessamento Automático:** O `PendingReferenceWorker` consulta transações elegíveis com backoff exponencial via `FOR UPDATE SKIP LOCKED`. Assim que a `BET` é processada, a operação dependente é concluída.
3. **Expiração Segura:** Caso o limite de retries ou TTL se esgote sem a chegada da referência, a transação transiciona para `REJECTED` com o código `REFERENCE_NOT_FOUND`.

---

## 7. Perguntas Técnicas da Apresentação

### 1. Por que DDD foi escolhido?
O processamento de apostas envolve regras financeiras críticas e invariantes rígidas (saldo não-negativo, balanço exato entre débito/crédito e ledger, imutabilidade de lançamentos contábeis, idempotência e matriz de estados de transação). O DDD permite isolar toda a lógica e integridade de negócio dentro de agregados e Value Objects puros (`Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`), desacoplados de frameworks e bancos de dados, tornando as invariantes testáveis com zero dependência externa.

### 2. Como o sistema evita lost updates?
Através da definição do `walletId` como a unidade exclusiva de concorrência e da aplicação de **Pessimistic Write Lock (`SELECT ... FOR UPDATE`)** diretamente na linha da carteira no PostgreSQL no início da transação financeira. Múltiplas requisições disputando a mesma carteira são enfileiradas determinística e temporariamente no banco, enquanto carteiras distintas processam em total paralelismo. Adicionalmente, a tabela `wallets` possui a constraint `CHECK (balance >= 0)`.

### 3. Como funciona a idempotência persistente?
Toda transação exige o cabeçalho `Idempotency-Key: <providerId>:<externalTransactionId>`. Um hash canônico (SHA-256) é gerado a partir do payload JSON normalizado recursivamente. Caso a chave já exista no banco:
- Se o hash gravado for idêntico ao recebido, o sistema realiza **idempotent replay** retornando a resposta original persistida com `idempotentReplay: true`.
- Se o hash diferir, o sistema rejeita a operação com status `409 Conflict` (`IDEMPOTENCY_PAYLOAD_MISMATCH`).
- Concorrência de submissões idênticas é tratada por constraint única no banco `(provider_id, idempotency_key)` com captura de violação de unicidade e retorno seguro do resultado comitado.

### 4. Por que utilizar Inbox e Outbox?
Para assegurar a garantia de entrega **Exactly-Once semântica** e evitar o problema clássico de *dual-write*:
- **Inbox Pattern:** Persiste `(consumer_name, message_id)` dentro da transação financeira no PostgreSQL. Redeliveries do SQS são detectadas antes de qualquer mutação, realizando ACK sem duplicar débitos. O ACK no SQS só ocorre após o commit no banco.
- **Transactional Outbox Pattern:** Eventos de integração são gravados na tabela `outbox_messages` atomicamente com a transação financeira. Um worker com polling `FOR UPDATE SKIP LOCKED` lê os eventos pendentes e os publica no broker com retry exponencial, impedindo a perda de eventos caso o processo caia logo após o commit.

### 5. Como a atomicidade é garantida?
Todas as operações financeiras — inserção do Inbox, bloqueio e débito/crédito da `Wallet`, criação do `WalletLedgerEntry`, transição de estado da `WagerTransaction` e enfileiramento na `OutboxMessage` — são executadas sob uma **única transação PostgreSQL gerenciada pelo MikroORM**. Se qualquer validação falhar ou o banco de dados reiniciar, ocorre rollback completo.

### 6. Como operações fora de ordem são tratadas?
Quando uma operação dependente (`REFUND` ou `ROLLBACK`) chega antes da transação referenciada (`BET`), o sistema **não** a descarta nem gera falha permanente. Ela é persistida com o status `PENDING_REFERENCE`. O `PendingReferenceWorker` periodicamente busca transações pendentes usando `FOR UPDATE SKIP LOCKED` e aplica backoff exponencial. Quando a transação referenciada for comitada, a operação dependente é reprocessada e concluída. Caso atinja o limite de retries ou TTL, ela é rejeitada como `REFERENCE_NOT_FOUND`.

### 7. Como o sistema se recupera após falhas?
- Se o processo morrer antes do commit: PostgreSQL desfaz as alterações (rollback automático por desconexão), o SQS devolve a visibilidade da mensagem e outra instância reassume.
- Se o processo morrer após o commit e antes do ACK: a mensagem reaparece na fila e o `InboxMessageEntity` impede nova execução, executando apenas o ACK pendente.
- Se o broker de mensageria estiver temporariamente indisponível: eventos aguardam com segurança na tabela Outbox e são publicados assim que o broker for restabelecido.

### 8. Como a consistência financeira é comprovada?
Pelo princípio da contabilidade de partidas dobradas e reconciliação contínua:
- Cada mutação de saldo gera obrigatoriamente um lançamento de ledger imutável (`WalletLedgerEntry`) com `balanceBefore`, `balanceAfter` e `direction`.
- O endpoint `POST /wallets/:walletId/reconciliation` soma todos os lançamentos do ledger da carteira e compara com o saldo atual:
  $$\text{difference} = \text{storedBalance} - \text{calculatedBalance}$$
- Divergências nunca são corrigidas silenciosamente: emitem alertas críticos, sinais de métricas operacionais e relatório estruturado de auditoria.

---

## 8. Trade-offs e Decisões Técnicas Justificadas

| Decisão | Alternativa Rejeitada | Justificativa |
|---|---|---|
| **Pessimistic Lock (`FOR UPDATE`) por `walletId`** | Optimistic Lock puro com versionamento | Alta concorrência na mesma carteira causa tempestade de rollbacks e retries excessivos no Optimistic Lock. O Pessimistic Lock por linha serializa com segurança no PostgreSQL com latência de poucos milissegundos. |
| **`NUMERIC(18, 2)` no PostgreSQL** | `INTEGER` / `BIGINT` em centavos | `NUMERIC(18, 2)` evita discrepâncias de escala com moedas que possam exigir divisões ou regras futuras, permite queries auditáveis diretas em SQL sem conversão mental de centavos e garante precisão exata pelo engine do PostgreSQL. |
| **Transactional Outbox com polling `SKIP LOCKED`** | CDC via Debezium / Postgres Logical Replication | Debezium adiciona dependência operacional pesada (Kafka, Kafka Connect, Zookeeper/KRaft) desnecessária para o escopo do desafio. `SKIP LOCKED` provê throughput de centenas de mensagens/segundo com zero infraestrutura externa adicional. |
| **Monólito Modular** | Microserviços (Wallet Service + Wagering Service) | Evita transações distribuídas (Saga/2PC) entre saldo de carteira e ledger financeiro, que introduziriam risco de consistência eventual inaceitável para débito de apostas. |
| **MikroORM** | TypeORM / Prisma | MikroORM possui Unit of Work genuíno, Identity Map limpo e suporte robusto a transações explícitas e locks pessimistas nativos. |
| **Decimal.js** | Tipos nativos `number` / `float` | Pontos flutuantes IEEE 754 geram erros de arredondamento acumulados (ex: `0.1 + 0.2 = 0.30000000000000004`), o que é inaceitável e eliminatório em sistemas financeiros. |

---

## 9. Limitações Conhecidas e Evoluções Futuras

1. **Shard de Banco por Tenant/Provedor:** Em cenários de escala massiva (> 50.000 req/s em dezenas de milhares de carteiras distintas), recomenda-se particionamento declarativo do PostgreSQL (ex: particionamento por hash de `walletId` ou shard com Citus).
2. **Cluster Multi-Região Ativo-Ativo:** Locks pessimistas por linha (`SELECT FOR UPDATE`) requerem latência baixa com o cluster primário de banco de dados. Para multi-região ativo-ativo geodistribuído, seria necessário particionamento geográfico de carteiras (jogadores ancorados à região primária de sua carteira).
3. **Desacoplamento de Leitura com CQRS:** Leituras de saldo e extrato paginado podem ser direcionadas a réplicas de leitura (*read replicas* assíncronas) do PostgreSQL, aliviando a instância primária para focar exclusivamente em transações de escrita e locks.
