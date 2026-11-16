# Architecture Decision Record & System Architecture

## 1. Visão Geral e Filosofia Arquitetural

O **Distributed Wagering Processor** é projetado como um **Monólito Modular** com foco estrito em **Domain-Driven Design (DDD)** e **Arquitetura Hexagonal (Ports and Adapters)**.

A escolha do monólito modular sobre microserviços distribui a complexidade de forma pragmática:
- Elimina a sobrecarga de rede desnecessária e latência RPC entre domínios fortemente acoplados (Wallet, Ledger, Wagering).
- Permite manter **garantias transacionais ACID estritas** no PostgreSQL para operações atômicas entre transação de aposta, movimentação de saldo, registro no ledger, deduplicação (Inbox) e publicação de eventos (Transactional Outbox).
- Mantém fronteiras modulares limpas e desacopladas no código (`domain`, `application`, `infrastructure`, `presentation`), permitindo futura extração em microserviços caso haja necessidade real de escala independente.

---

## 2. Padrões Arquiteturais e Separação de Camadas

Cada módulo do sistema adota a Arquitetura Hexagonal com isolamento estrito de responsabilidades:

```
src/modules/<modulo>/
├── domain/            # Regras puras, entidades, value objects, invariantes, domain errors.
│                      # ZERO dependências de frameworks, ORM ou bibliotecas externas (exceto Decimal.js).
├── application/       # Casos de uso (UseCases / Command Handlers), DTOs de aplicação,
│                      # portas de entrada (Input Ports) e portas de saída (Output Ports / Repositories).
├── infrastructure/    # Adaptadores secundários: MikroORM entities, repositórios concretos,
│                      # clientes SQS, publishers, outbox workers, adapters de relógio.
└── presentation/      # Adaptadores primários: Controllers HTTP (NestJS), Consumers SQS,
                       # DTOs de requisição/resposta, interceptors e filtros.
```

### Princípios de Dependência
1. **Regra de Dependência:** O fluxo de dependência aponta exclusivamente para dentro. O Domínio não conhece Aplicação nem Infraestrutura. A Aplicação conhece o Domínio e define Interfaces (Portas). A Infraestrutura e Apresentação implementam as Interfaces.
2. **Isolamento de ORM:** As entidades de domínio (`Wallet`, `WagerTransaction`, `WalletLedgerEntry`) são completamente desacopladas de anotações do MikroORM. O mapeamento relacional é feito através de entidades de persistência (`*Schema` ou entidades ORM isoladas em `infrastructure`) com mapeadores bidirecionais (`toDomain` e `toPersistence`), utilizando as factories estáticas `rehydrate` do domínio.

---

## 3. Concorrência e Estratégia de Lock por Carteira (`walletId`)

### Problema
Em cassinos online, operações financeiras concorrentes em uma mesma carteira ("hot wallet") podem causar *lost updates*, inconsistências no saldo ou permitir que o saldo fique negativo quando duas apostas simultâneas competem pelo mesmo saldo restante.

### Decisão Técnica: Pessimistic Locking com Serialização por `walletId`
1. **Unidade de Concorrência:** A unidade de concorrência é estritamente o `walletId`. Não há lock global que degrade o throughput entre jogadores diferentes.
2. **Estratégia de Bloqueio:**
   - Adotamos **Pessimistic Write Lock (`SELECT ... FOR UPDATE`)** no registro da `Wallet` no início da transação de banco.
   - No MikroORM: `em.findOne(WalletEntity, { id: walletId }, { lockMode: LockMode.PESSIMISTIC_WRITE })`.
3. **Justificativa do Pessimistic Locking sobre Optimistic Locking puro:**
   - Em cenários de alta disputa na mesma carteira (ex: múltiplas rodadas rápidas, giros automáticos, chamadas de liquidação e perdas concorrentes), o *Optimistic Locking* puro causa alta taxa de *rollback*, desperdício de CPU, estouro de conexões e necessidade de múltiplos retries com contenção crescente.
   - O lock pessimista por linha enfileira determinística e temporariamente as operações daquela carteira específica no PostgreSQL, mantendo transações SQL ultracurtas (menos de 5ms).
   - Carteiras distintas processam em total paralelismo sem nenhum tipo de contenção.
4. **Proteção Adicional: Versão e Check Constraint no Banco:**
   - A entidade `Wallet` possui coluna `version`, incrementada a cada mutação de saldo.
   - O schema do banco possui `CHECK (balance >= 0)`. Mesmo diante de falhas de código ou comandos manuais, o banco de dados rejeita qualquer tentativa de deixar o saldo negativo.

---

## 4. Idempotência Persistente e Algoritmo Canônico

### Header Obrigatório
Toda operação de aposta submetida via HTTP deve fornecer o header:
```http
Idempotency-Key: <providerId>:<externalTransactionId>
```
Se omitido, a API rejeita a requisição com `400 Bad Request`.

### Algoritmo de Hashing Canônico
Para garantir que a requisição seja determinística independentemente da ordem das propriedades no JSON enviado pelo provedor:
1. Extraem-se estritamente os campos de negócio:
   - `providerId`
   - `externalTransactionId`
   - `playerId`
   - `walletId`
   - `roundId`
   - `gameId`
   - `kind`
   - `money.amount`
   - `money.currency`
   - `referenceExternalTransactionId` (se presente)
2. Normalização:
   - Chaves ordenadas alfabeticamente de forma recursiva (Canonical JSON stringify).
   - Sem espaços em branco desnecessários.
3. Hashing:
   - Algoritmo: **SHA-256**.
   - O hash hexadecimal resultante é gravado no campo `payload_hash` da tabela `wager_transactions`.

### Tratamento de Replay vs Conflito
- **Replay Idêntico:** Se `(provider_id, idempotency_key)` já existe e o `payload_hash` gravado é idêntico ao calculado, o sistema retorna imediatamente o resultado original previamente persistido com `idempotentReplay: true` e status HTTP apropriado (200 OK / 201 Created conforme a operação original).
- **Conflito de Payload:** Se a `idempotency_key` já existe para o mesmo provedor, mas o `payload_hash` difere, o sistema **rejeita imediatamente** com status `409 Conflict`, código de erro `IDEMPOTENCY_PAYLOAD_MISMATCH`. Nenhuma alteração financeira ou mutação é realizada.

---

## 5. Padrões de Resiliência: Inbox e Transactional Outbox

```
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

### Inbox Pattern
- Utilizado no processamento assíncrono via SQS.
- Tabela `inbox_messages` armazena `(message_id, consumer_name, payload_hash, received_at, processed_at)`.
- Chave primária composta: `(consumer_name, message_id)`.
- Se a mensagem já foi processada por este consumidor, é feito ACK imediato no SQS sem reprocessamento.
- A inserção/atualização do Inbox ocorre **dentro da mesma transação SQL** que executa o negócio.
- O ACK no SQS ocorre **estritamente após o commit** da transação no PostgreSQL.

### Transactional Outbox Pattern
- Eventos de integração de domínio **nunca** são publicados diretamente no broker antes ou durante a transação financeira (evitando o clássico problema de dual-write / publicação fantasma se o banco falhar no commit).
- Os eventos são persistidos na tabela `outbox_messages` dentro da mesma transação SQL que atualiza a carteira e o ledger.
- Um worker dedicado (`OutboxPublisherWorker`) pesquisa mensagens pendentes (`published_at IS NULL AND next_attempt_at <= NOW()`).
- Para suportar **múltiplas instâncias concorrentes**, a consulta utiliza:
  ```sql
  SELECT * FROM outbox_messages
  WHERE published_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
  ORDER BY occurred_at ASC
  LIMIT 50
  FOR UPDATE SKIP LOCKED;
  ```
  `FOR UPDATE SKIP LOCKED` garante que instâncias paralelas processem lotes disjuntos sem colisão de locks e sem duplicar publicações ativas.
- Em caso de falha de publicação no SQS, aplica-se retry com backoff exponencial (`next_attempt_at = NOW() + backoff(attempts)`).

---

## 6. Operações Fora de Ordem e Dependências

Provedores de jogos operam em redes distribuídas onde operações dependentes (`REFUND`, `ROLLBACK`) podem chegar ao broker antes da transação referenciada (`BET`).

1. **Chegada Prematura:**
   - Quando um `REFUND` ou `ROLLBACK` chega e a transação referenciada `(providerId, referenceExternalTransactionId)` não é encontrada ou ainda está em processamento, a transação **não é descartada nem causa erro fatal**.
   - A transação é persistida com status `PENDING_REFERENCE`.
   - Evento `WagerTransactionPendingReference` é gerado na Outbox.
2. **Reprocessamento Automático:**
   - Um worker agendado (`PendingReferenceWorker`) busca transações em `PENDING_REFERENCE` elegíveis para retry.
   - Quando a `BET` correspondente tiver sido processada, o worker executa a transação dependente mantendo todas as regras financeiras e de ledger.
3. **Dead-Letter e Expiração:**
   - Limite configurável de tentativas (ex: 5 retries com backoff exponencial) ou TTL (ex: 15 minutos).
   - Esgotado o limite sem a chegada da referência, a transação transiciona para `REJECTED` com o failure code `REFERENCE_TRANSACTION_NOT_FOUND`, publicando o evento `WagerTransactionRejected`.

---

## 7. Decisão de Autenticação

Conforme a seção 2 de `docs/DESAFIO.md`, autenticação não pontua na avaliação técnica e não deve competir com a correção financeira e resiliência distribuída.

### Decisão
1. **Ambiente Local e Avaliação:**
   - Adotamos o padrão **Hexagonal com Ponto de Extensão Explícito**.
   - O sistema define a porta `ProviderIdentityPort` e um `AuthGuard` estruturado no NestJS.
   - Por padrão, disponibilizamos uma implementação configurável:
     - Em modo `DEVELOPMENT`/`EVALUATION`, o guard valida a presença e integridade do header `X-Provider-Id` (ou bearer token simulado), associando a identidade do provedor ao contexto da requisição.
     - Endpoints `/health/live` e `/health/ready` são explicitamente públicos (sem autenticação).
     - Consumidores SQS tratam a fila como canal de transporte interno confiável, aplicando validações rigorosas de domínio sobre a identidade do provedor contida na mensagem.
2. **Arquitetura de Produção Proposta:**
   - Em produção, o serviço integrará com um Identity Provider (IdP) OIDC como **Keycloak** ou **Zitadel** via tokens JWT (Client Credentials Flow para cada Provedor de Jogos).
   - O `AuthGuard` validará assinatura assimétrica (JWKS), emissor, audiência e claims de escopo (`roles: ["wager:write", "wallet:read"]`).

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

## 9. Perguntas Técnicas da Apresentação

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

## 10. Limitações Conhecidas e Evoluções Futuras

1. **Shard de Banco por Tenant/Provedor:** Em cenários de escala massiva (> 50.000 req/s em dezenas de milhares de carteiras distintas), recomenda-se particionamento declarativo do PostgreSQL (ex: particionamento por hash de `walletId` ou shard com Citus).
2. **Cluster Multi-Região Ativo-Ativo:** Locks pessimistas por linha (`SELECT FOR UPDATE`) requerem latência baixa com o cluster primário de banco de dados. Para multi-região ativo-ativo geodistribuído, seria necessário particionamento geográfico de carteiras (jogadores ancorados à região primária de sua carteira).
3. **Desacoplamento de Leitura com CQRS:** Leituras de saldo e extrato paginado podem ser direcionadas a réplicas de leitura (*read replicas* assíncronas) do PostgreSQL, aliviando a instância primária para focar exclusivamente em transações de escrita e locks.

