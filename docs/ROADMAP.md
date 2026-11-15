# Roadmap --- Distributed Wagering Processor

> Plano de desenvolvimento baseado no documento **Technical Challenge
> --- Distributed Wagering Processor**, da Jungle Gaming.

## 1. Visão geral

O objetivo é construir um serviço financeiro distribuído capaz de
processar transações de apostas recebidas de múltiplos provedores,
mantendo a integridade financeira mesmo diante de mensagens duplicadas,
entregas fora de ordem, concorrência entre instâncias e falhas de
infraestrutura.

O projeto não deve ser tratado como uma simples API CRUD. O foco está
em:

-   Correção financeira.
-   Concorrência entre múltiplas instâncias.
-   Idempotência persistente.
-   Consistência entre saldo materializado e ledger.
-   Processamento assíncrono e recuperação após falhas.
-   Clareza e justificativa das decisões arquiteturais.

### Invariante central

O saldo de cada carteira deve permanecer consistente com o histórico
financeiro registrado no ledger. O sistema não pode duplicar créditos ou
débitos, perder eventos confirmados nem permitir saldo negativo.

------------------------------------------------------------------------

## 2. Stack tecnológica

  -----------------------------------------------------------------------
  Categoria               Tecnologia              Responsabilidade
  ----------------------- ----------------------- -----------------------
  Runtime / package       Bun 1.x                 Execução, dependências
  manager / test runner                           e testes

  Linguagem               TypeScript strict       Implementação da
                                                  aplicação

  Framework               NestJS                  Estrutura modular e API

  Banco de dados          PostgreSQL              Persistência e
                                                  garantias transacionais

  ORM                     MikroORM                Mapeamento, Unit of
                                                  Work e transações

  Mensageria              AWS SQS                 Processamento
                                                  assíncrono

  Emulação AWS local      LocalStack ou MiniStack Ambiente local de
                                                  mensageria

  Orquestração            Docker Compose          Execução dos serviços

  Migrations              Versionadas e           Evolução do schema
                          reversíveis             
  -----------------------------------------------------------------------

### Ferramentas complementares recomendadas

-   Decimal.js para operações monetárias exatas.
-   Pino para logs estruturados.
-   Swagger/OpenAPI para documentação HTTP.
-   OpenTelemetry para instrumentação e tracing.
-   Prometheus e Grafana como evolução opcional da observabilidade.

As ferramentas complementares não substituem os requisitos obrigatórios
do desafio. A adoção de cada uma deve ter justificativa técnica.

------------------------------------------------------------------------

## 3. Princípios e restrições inegociáveis

1.  Não utilizar `number`, `float` ou `double` para representar
    dinheiro.
2.  Não utilizar cache em memória como garantia de idempotência.
3.  Não depender exclusivamente de SQS FIFO para consistência.
4.  Não publicar eventos antes do commit da transação financeira.
5.  Não sobrescrever nem excluir lançamentos do ledger.
6.  Não utilizar lock global compartilhado por todas as carteiras.
7.  Não executar `read → calculate → update` sem controle de
    concorrência.
8.  Garantir correção com múltiplas instâncias da aplicação.
9.  Aplicar unicidade, imutabilidade e não-negatividade no schema do
    banco, e não somente na aplicação.
10. Manter Inbox, movimentação financeira, ledger e Outbox na mesma
    transação SQL quando aplicável.

------------------------------------------------------------------------

## 4. Roadmap de desenvolvimento

### Fase 0 --- Planejamento e arquitetura

**Objetivo:** definir as decisões arquiteturais, as fronteiras dos
módulos e as regras que orientarão a implementação.

**Atividades:**

-   Definir monólito modular com NestJS.
-   Definir DDD e separação entre Domain, Application e Infrastructure.
-   Definir arquitetura Hexagonal (Ports and Adapters).
-   Definir PostgreSQL como fonte da verdade.
-   Definir SQS para processamento assíncrono.
-   Definir estratégia de concorrência por `walletId`.
-   Definir estratégia de idempotência persistente.
-   Definir o uso de Inbox e Transactional Outbox.
-   Definir estratégia de autenticação ou documentar sua não
    implementação.
-   Registrar trade-offs e decisões técnicas.

**Documentos iniciais:**

  Documento           Conteúdo
  ------------------- ------------------------------------------------
  `ARCHITECTURE.md`   Arquitetura, decisões, trade-offs e limitações
  `DOMAIN.md`         Entidades, Value Objects, estados e regras
  `DATABASE.md`       Modelo relacional, constraints e índices
  `EVENTS.md`         Contratos e versionamento dos eventos
  `API.md`            Contratos HTTP e códigos de resposta
  `TESTING.md`        Estratégia e cenários de testes
  `ROADMAP.md`        Plano de execução do projeto

**Critérios de conclusão:**

-   [x] Arquitetura geral definida.
-   [x] Módulos e responsabilidades definidos.
-   [x] Estratégias de concorrência e idempotência documentadas.
-   [x] Decisão sobre autenticação registrada.
-   [x] Documentação inicial criada.

**Entregável:** documentação arquitetural inicial e plano de
implementação aprovado.

------------------------------------------------------------------------

### Fase 1 --- Infraestrutura e ambiente

**Objetivo:** preparar o ambiente de desenvolvimento e execução.

**Atividades:**

1.  Inicializar o projeto com Bun.
2.  Configurar TypeScript em modo estrito.
3.  Instalar e configurar NestJS.
4.  Configurar MikroORM.
5.  Configurar PostgreSQL.
6.  Configurar LocalStack ou MiniStack e SQS.
7.  Criar Docker Compose.
8.  Configurar variáveis de ambiente e `.env.example`.
9.  Configurar scripts de desenvolvimento, build e testes.
10. Implementar health checks iniciais.
11. Validar a comunicação entre a aplicação e os serviços.

**Estrutura inicial sugerida:**

``` text
distributed-wagering-processor/
├── src/
│   ├── modules/
│   ├── shared/
│   ├── infrastructure/
│   ├── app.module.ts
│   └── main.ts
├── test/
├── migrations/
├── docs/
├── docker/
├── docker-compose.yml
├── Dockerfile
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

**Critérios de conclusão:**

-   [x] Aplicação NestJS inicia corretamente.
-   [x] PostgreSQL fica disponível pelo Docker Compose.
-   [x] SQS local fica disponível.
-   [x] Aplicação conecta-se ao banco e à mensageria.
-   [x] Variáveis de ambiente estão documentadas.
-   [x] Scripts básicos funcionam.

**Entregável:** ambiente local reproduzível com aplicação, PostgreSQL e
SQS.

------------------------------------------------------------------------

### Fase 2 --- Modelagem de domínio

**Objetivo:** implementar o núcleo do negócio sem dependência de NestJS,
banco de dados ou mensageria.

**Componentes principais:**

  Componente            Responsabilidade
  --------------------- ------------------------------------------
  `Money`               Representação monetária exata e imutável
  `Wallet`              Aggregate Root da carteira
  `WagerTransaction`    Operação de aposta e suas transições
  `WalletLedgerEntry`   Registro financeiro imutável
  `InboxMessage`        Estado de deduplicação de mensagens
  `OutboxMessage`       Estado de publicação de eventos

**Atividades:**

-   Implementar `Money` com string decimal na entrada e saída e escala
    fixa de duas casas.
-   Implementar adição, subtração, negação, comparação e igualdade
    monetária.
-   Rejeitar valores inválidos e operações entre moedas diferentes.
-   Implementar factories estáticas `create`, `from`, `open` e
    `rehydrate`, conforme cada modelo.
-   Encapsular o estado das entidades.
-   Definir transições válidas de `WagerTransaction`.
-   Definir estados terminais e códigos de falha.
-   Implementar validação aritmética do ledger.
-   Definir quais operações afetam o saldo e quais exigem referência.

**Critérios de conclusão:**

-   [x] `Money` é imutável e não utiliza tipos de ponto flutuante.
-   [x] Entradas monetárias inválidas são rejeitadas.
-   [x] Conflitos de moeda são tratados.
-   [x] Entidades possuem estado encapsulado.
-   [x] Reidratação não reexecuta regras de transição.
-   [x] Transições e estados terminais estão definidos.
-   [x] Testes unitários do domínio estão passando.

**Entregável:** domínio implementado e testado independentemente da
infraestrutura.

------------------------------------------------------------------------

### Fase 3 --- Persistência e banco de dados

**Objetivo:** transformar os invariantes do domínio em garantias do
PostgreSQL.

**Tabelas principais:**

  Tabela                    Finalidade
  ------------------------- ---------------------------------------
  `wallets`                 Carteiras e saldo materializado
  `wager_transactions`      Operações recebidas e seus estados
  `wallet_ledger_entries`   Histórico financeiro imutável
  `inbox_messages`          Deduplicação persistente de mensagens
  `outbox_messages`         Eventos pendentes de publicação
  `providers`               Identificação e dados dos provedores

**Atividades:**

-   Criar migrations versionadas e reversíveis.
-   Definir chaves primárias e estrangeiras.
-   Criar unicidade de `playerId + currency`.
-   Criar unicidade das chaves de idempotência.
-   Impedir mais de um lançamento por transação e carteira.
-   Aplicar constraints de valores e não-negatividade.
-   Criar índices para consultas, referências e workers.
-   Definir precisão e escala das colunas monetárias.
-   Validar o comportamento das constraints no banco real.

**Critérios de conclusão:**

-   [x] Migrations executam e revertem corretamente.
-   [x] Constraints críticas estão no schema.
-   [x] Índices necessários foram criados.
-   [x] Relacionamentos e unicidades foram testados.
-   [x] Persistência e reidratação preservam os valores do domínio.

**Entregável:** schema relacional, migrations e constraints validadas.

------------------------------------------------------------------------

### Fase 4 --- Wallet e Ledger

**Objetivo:** implementar as operações fundamentais das carteiras e seu
histórico financeiro.

**Funcionalidades:**

-   Criar carteira.
-   Consultar carteira.
-   Consultar saldo.
-   Creditar saldo.
-   Debitar saldo.
-   Registrar lançamentos.
-   Consultar histórico financeiro com cursor estável.
-   Criar transação interna `OPENING` quando houver saldo inicial
    positivo.

**Regras:**

-   Uma carteira por jogador e moeda.
-   Saldo nunca negativo.
-   Toda alteração de saldo tem lançamento correspondente.
-   Saldo e ledger são atualizados na mesma transação SQL.
-   Lançamentos são imutáveis.
-   A versão da carteira incrementa somente quando o saldo muda.

**Critérios de conclusão:**

-   [x] Criação de carteira funciona.
-   [x] Crédito e débito funcionam.
-   [x] Saldo insuficiente é impedido.
-   [x] `OPENING` gera lançamento correspondente.
-   [x] Ledger não pode ser alterado ou excluído pelo fluxo normal.
-   [x] Saldo e ledger permanecem consistentes.

**Entregável:** módulo financeiro básico funcional.

------------------------------------------------------------------------

### Fase 5 --- Motor de transações

**Objetivo:** implementar as regras de processamento das operações de
apostas.

  Operação     Efeito no saldo         Lançamento
  ------------ ----------------------- -----------------
  `BET`        Débito                  `DEBIT`
  `WIN`        Crédito                 `CREDIT`
  `LOSS`       Nenhum                  Nenhum
  `REFUND`     Crédito                 `CREDIT`
  `ROLLBACK`   Inverso da referência   Direção inversa

**Atividades:**

-   Implementar processamento de cada tipo.
-   Validar provedor, jogador, carteira, moeda e rodada.
-   Resolver referências por provedor e identificador externo.
-   Validar os tipos de transação que podem ser revertidos.
-   Impedir reversões duplicadas.
-   Exigir igualdade de valor nas reversões.
-   Rejeitar reversões que produziriam saldo negativo.
-   Registrar rejeições com `failureCode` estável.
-   Garantir que `OPENING` não seja submetida pela API ou fila.

**Critérios de conclusão:**

-   [x] Todas as operações estão implementadas.
-   [x] Regras de referência são respeitadas.
-   [x] Reversões duplicadas são impedidas.
-   [x] Rejeições são auditáveis.
-   [x] Operações sem efeito no saldo não criam ledger.
-   [x] Testes unitários cobrem regras válidas e inválidas.

**Entregável:** motor de transações financeiras completo.

------------------------------------------------------------------------

### Fase 6 --- Idempotência e concorrência

**Objetivo:** garantir correção diante de requisições repetidas e
operações simultâneas.

#### Idempotência

**Atividades:**

-   Exigir `Idempotency-Key`.
-   Adotar como padrão recomendado
    `{providerId}:{externalTransactionId}`.
-   Calcular `payloadHash` sobre JSON canônico dos campos de negócio.
-   Persistir a chave e o hash.
-   Retornar o resultado original em replay idêntico.
-   Retornar conflito quando a mesma chave vier com payload diferente.
-   Não depender de estruturas em memória.

#### Concorrência

**Atividades:**

-   Definir a carteira (`walletId`) como unidade de concorrência.
-   Implementar estratégia de locking por carteira.
-   Avaliar pessimistic locking e optimistic locking com retry limitado.
-   Manter transações SQL curtas.
-   Evitar lost updates.
-   Permitir processamento paralelo de carteiras diferentes.
-   Validar a estratégia com múltiplas instâncias.

**Cenário obrigatório:**

-   Saldo inicial: `100.00 BRL`.
-   Duas apostas simultâneas: `80.00 BRL` cada.
-   Resultado: exatamente uma `PROCESSED` e uma `REJECTED`.
-   Saldo final: `20.00 BRL`.
-   Exatamente um lançamento de débito.
-   Retries não podem duplicar o débito.

**Critérios de conclusão:**

-   [x] Replay idêntico retorna resultado original.
-   [x] Payload divergente com a mesma chave gera conflito.
-   [x] Cinquenta submissões paralelas da mesma aposta geram um único
    efeito.
-   [x] O cenário de duas apostas concorrentes produz o resultado
    esperado.
-   [x] Múltiplas instâncias preservam as invariantes.
-   [x] Wallets diferentes podem ser processadas em paralelo.

**Entregável:** processamento idempotente e concorrente seguro.

------------------------------------------------------------------------

### Fase 7 --- API HTTP

**Objetivo:** disponibilizar as funcionalidades por meio de contratos
HTTP consistentes.

**Endpoints previstos:**

  -----------------------------------------------------------------------------------------------------------
  Método                              Endpoint
  ----------------------------------- -----------------------------------------------------------------------
  `POST`                              `/wallets`

  `GET`                               `/wallets/:walletId`

  `GET`                               `/wallets/:walletId/ledger?cursor=...&limit=50`

  `POST`                              `/wagering/transactions`

  `GET`                               `/wagering/transactions/:transactionId`

  `GET`                               `/providers/:providerId/wagering/transactions/:externalTransactionId`

  `POST`                              `/wallets/:walletId/reconciliation`

  `GET`                               `/health/live`

  `GET`                               `/health/ready`
  -----------------------------------------------------------------------------------------------------------

**Atividades:**

-   Criar controllers e DTOs.
-   Validar payloads.
-   Implementar casos de uso na camada Application.
-   Padronizar respostas e exceções.
-   Definir códigos HTTP para payload inválido, conflito de
    idempotência, rejeição de negócio, processamento pendente e falha
    transitória.
-   Implementar paginação por cursor.
-   Documentar contratos com Swagger/OpenAPI.
-   Manter health checks sem autenticação.

**Critérios de conclusão:**

-   [x] Todos os endpoints obrigatórios estão disponíveis.
-   [x] Validações de entrada funcionam.
-   [x] Respostas e erros são consistentes.
-   [x] Idempotência HTTP está integrada.
-   [x] Documentação OpenAPI está acessível.
-   [x] Health checks distinguem liveness e readiness.

**Entregável:** API HTTP documentada e funcional.

------------------------------------------------------------------------

### Fase 8 --- Processamento assíncrono com SQS

**Objetivo:** processar operações por workers independentes e
resilientes.

**Filas:**

``` text
wager-transactions.fifo
wager-transactions-dlq.fifo
```

**Atividades:**

1.  Implementar publicação de mensagens.
2.  Implementar consumidores SQS.
3.  Reutilizar o mesmo caso de uso utilizado pela entrada HTTP.
4.  Deduplicar por `(consumerName, messageId)` com Inbox persistente.
5.  Confirmar a mensagem (`ack`) somente após o commit.
6.  Classificar erros de negócio, transitórios e permanentes.
7.  Implementar retry com backoff.
8.  Configurar limite de tentativas e DLQ.
9.  Tratar `SIGTERM`, concluindo mensagens ou devolvendo sua
    visibilidade.
10. Garantir segurança diante de redelivery.

**Critérios de conclusão:**

-   [ ] Consumidor recebe e processa mensagens.
-   [ ] Inbox persiste a deduplicação.
-   [ ] ACK ocorre após commit.
-   [ ] Erros são classificados corretamente.
-   [ ] Retry e DLQ funcionam.
-   [ ] Redelivery não duplica efeitos.
-   [ ] Encerramento do worker é seguro.

**Entregável:** processamento assíncrono confiável.

------------------------------------------------------------------------

### Fase 9 --- Transactional Outbox

**Objetivo:** garantir publicação recuperável dos eventos de integração.

**Eventos mínimos:**

-   `WagerTransactionProcessed`
-   `WagerTransactionRejected`
-   `WalletBalanceChanged`
-   `WagerTransactionPendingReference`

**Atividades:**

-   Persistir eventos na Outbox dentro da transação financeira.
-   Criar envelope de evento com `eventId`, `eventType`, `aggregateId`,
    `correlationId`, `causationId`, `occurredAt`, `version` e `data`.
-   Serializar valores monetários como strings decimais.
-   Criar worker publicador.
-   Permitir múltiplos publishers concorrentes.
-   Controlar tentativas e próximo horário de publicação.
-   Implementar backoff.
-   Marcar eventos publicados.
-   Tornar consumidores seguros contra publicações duplicadas.

**Cenário de recuperação:**

1.  PostgreSQL confirma o commit.
2.  Processo morre antes da publicação.
3.  Outra instância assume o trabalho.
4.  Evento é publicado.
5.  Uma publicação duplicada continua segura para o consumidor.

**Critérios de conclusão:**

-   [ ] Evento é gravado atomicamente com a operação financeira.
-   [ ] Worker encontra eventos pendentes.
-   [ ] Múltiplos publishers não perdem eventos.
-   [ ] Falhas provocam novas tentativas.
-   [ ] Publicações duplicadas são seguras.
-   [ ] Eventos possuem contratos versionados.

**Entregável:** publicação confiável com Transactional Outbox.

------------------------------------------------------------------------

### Fase 10 --- Operações fora de ordem

**Objetivo:** tratar operações dependentes que chegam antes da transação
referenciada.

**Fluxo esperado:**

``` text
1. REFUND chega antes da BET.
2. Sistema não encontra a referência.
3. REFUND é persistida como PENDING_REFERENCE.
4. BET chega e é processada.
5. Worker identifica a referência disponível.
6. REFUND é reprocessada.
7. REFUND é processada ou rejeitada conforme as regras.
```

**Atividades:**

-   Identificar referências ausentes.
-   Persistir estado `PENDING_REFERENCE`.
-   Implementar worker agendado.
-   Consultar referências disponíveis.
-   Aplicar backoff exponencial.
-   Definir limite de tentativas e TTL.
-   Rejeitar após esgotamento com código específico.
-   Publicar o evento correspondente.

**Critérios de conclusão:**

-   [ ] Operações sem referência não são descartadas.
-   [ ] Estado pendente é persistido.
-   [ ] Worker reprocessa operações elegíveis.
-   [ ] Backoff, limite e TTL funcionam.
-   [ ] Esgotamento resulta em rejeição auditável.
-   [ ] Reprocessamento não duplica movimentações.

**Entregável:** processamento de operações fora de ordem.

------------------------------------------------------------------------

### Fase 11 --- Reconciliação financeira

**Objetivo:** detectar divergências entre o saldo materializado e o
saldo reconstruído pelo ledger.

**Atividades:**

-   Reconstruir saldo a partir dos lançamentos.
-   Comparar saldo calculado e saldo armazenado.
-   Calcular diferença.
-   Informar quantidade de lançamentos verificados.
-   Registrar divergências.
-   Emitir métricas e sinais operacionais.
-   Retornar resultado estruturado pelo endpoint de reconciliação.

**Regra:** divergências não devem ser corrigidas silenciosamente.

**Critérios de conclusão:**

-   [ ] Saldo calculado pelo ledger está disponível.
-   [ ] Comparação com saldo materializado funciona.
-   [ ] Diferenças são reportadas.
-   [ ] Divergências são observáveis.
-   [ ] Nenhuma correção silenciosa é realizada.

**Entregável:** mecanismo de auditoria e reconciliação.

------------------------------------------------------------------------

### Fase 12 --- Observabilidade e resiliência

**Objetivo:** permitir diagnóstico e acompanhamento operacional.

**Logs estruturados:** incluir, quando aplicável:

-   `correlationId`
-   `messageId`
-   `transactionId`
-   `walletId`
-   `providerId`

Não registrar dados sensíveis ou payloads financeiros completos nos
logs.

**Métricas obrigatórias:**

-   Transações por status.
-   Duplicatas detectadas.
-   Retries.
-   Mensagens na DLQ.
-   Conflitos de lock.
-   Outbox lag.
-   Latência de processamento.

**Atividades adicionais:**

-   Separar liveness e readiness.
-   Instrumentar operações relevantes.
-   Adicionar tracing distribuído com OpenTelemetry, se adotado.
-   Preparar dashboards como evolução opcional.
-   Testar indisponibilidade temporária de PostgreSQL e SQS.
-   Validar recuperação após restabelecimento dos serviços.

**Critérios de conclusão:**

-   [ ] Logs estruturados estão disponíveis.
-   [ ] Campos de correlação são propagados.
-   [ ] Dados sensíveis não são expostos.
-   [ ] Métricas obrigatórias estão instrumentadas.
-   [ ] Health checks refletem dependências.
-   [ ] Falhas transitórias são diagnosticáveis e recuperáveis.

**Entregável:** aplicação observável e preparada para operação.

------------------------------------------------------------------------

### Fase 13 --- Testes avançados

**Objetivo:** comprovar os requisitos com infraestrutura real em
containers, sem substituir PostgreSQL e SQS integralmente por mocks.

#### Testes unitários

-   [ ] Operações e validações de `Money`.
-   [ ] Escala, precisão e entradas inválidas.
-   [ ] Invariantes de `Wallet`.
-   [ ] Regras de `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`.
-   [ ] Conflitos de moeda.
-   [ ] Conflito de chave de idempotência com payload divergente.
-   [ ] Transições de estado e estados terminais.

#### Testes de integração

-   [ ] Migrations e constraints.
-   [ ] Atomicidade entre wallet, ledger, inbox e outbox.
-   [ ] Inbox e redelivery.
-   [ ] Publishers concorrentes.
-   [ ] Retry e DLQ.
-   [ ] Recuperação após reinicialização.

#### Testes de concorrência e falhas

  -----------------------------------------------------------------------
  Cenário                             Resultado esperado
  ----------------------------------- -----------------------------------
  Mesma aposta enviada 50 vezes em    Um único débito
  paralelo                            

  Duas apostas disputando saldo de    Uma processada e outra rejeitada
  R\$ 100                             

  Wallets distintas em paralelo       Processamento paralelo

  Três ou mais instâncias             Invariantes preservadas

  Worker morto após commit e antes do Recuperação sem duplicação
  ACK                                 

  Dois publishers sobre a mesma       Publicação recuperável e segura
  Outbox                              

  `REFUND` ou `ROLLBACK` antes da     Estado pendente e reprocessamento
  referência                          

  Reinício do serviço                 Consistência final preservada
  -----------------------------------------------------------------------

**Invariante final de todos os testes:**

``` text
wallet.balance == saldo reconstruído pelo ledger
```

**Critérios de conclusão:**

-   [ ] Testes unitários passam.
-   [ ] Testes de integração usam PostgreSQL e SQS em containers.
-   [ ] Testes de concorrência executam paralelismo real.
-   [ ] Cenários de falha e recuperação passam.
-   [ ] Invariante de saldo e ledger é verificada.
-   [ ] Resultados dos testes são reproduzíveis.

**Entregável:** suíte de testes que comprova correção, concorrência e
resiliência.

------------------------------------------------------------------------

### Fase 14 --- Documentação e entrega

**Objetivo:** consolidar a documentação e preparar o projeto para
avaliação técnica.

**Documentos finais:**

  Documento           Conteúdo
  ------------------- ------------------------------------------------
  `README.md`         Visão geral, requisitos, instalação e execução
  `ARCHITECTURE.md`   Arquitetura, decisões, trade-offs e limitações
  `DOMAIN.md`         Entidades, Value Objects, estados e regras
  `DATABASE.md`       Schema, constraints, índices e migrations
  `EVENTS.md`         Eventos, envelopes e versionamento
  `API.md`            Endpoints, contratos e respostas
  `TESTING.md`        Estratégia, comandos e cenários
  `ROADMAP.md`        Etapas e critérios de conclusão

**Conteúdo do README:**

-   Visão geral do projeto.
-   Arquitetura.
-   Tecnologias.
-   Pré-requisitos.
-   Instalação e configuração.
-   Execução local.
-   Endpoints.
-   Exemplos de requisição.
-   Execução dos testes.
-   Decisões técnicas relevantes.
-   Limitações conhecidas.

**Preparação da apresentação:**

-   Por que DDD foi escolhido?
-   Como o sistema evita lost updates?
-   Como funciona a idempotência persistente?
-   Por que utilizar Inbox e Outbox?
-   Como a atomicidade é garantida?
-   Como operações fora de ordem são tratadas?
-   Como o sistema se recupera após falhas?
-   Como a consistência financeira é comprovada?

**Critérios de conclusão:**

-   [ ] Documentação está atualizada e coerente com o código.
-   [ ] Setup funciona seguindo o README.
-   [ ] Comandos de execução e testes estão documentados.
-   [ ] Decisões e trade-offs estão justificados.
-   [ ] Limitações conhecidas estão declaradas.
-   [ ] Apresentação técnica está preparada.

**Entregável:** projeto documentado e pronto para avaliação.

------------------------------------------------------------------------

## 5. Arquitetura final recomendada

A recomendação é um **monólito modular com DDD e arquitetura
Hexagonal**, mantendo as responsabilidades bem isoladas sem introduzir
microserviços desnecessários.

Estrutura sugerida:

``` text
src/
├── modules/
│   ├── wallet/
│   │   ├── domain/
│   │   ├── application/
│   │   ├── infrastructure/
│   │   └── presentation/
│   ├── wagering/
│   │   ├── domain/
│   │   ├── application/
│   │   ├── infrastructure/
│   │   └── presentation/
│   ├── ledger/
│   │   ├── domain/
│   │   ├── application/
│   │   └── infrastructure/
│   ├── messaging/
│   │   ├── domain/
│   │   ├── application/
│   │   └── infrastructure/
│   ├── reconciliation/
│   │   ├── application/
│   │   └── infrastructure/
│   └── providers/
│       ├── domain/
│       ├── application/
│       └── infrastructure/
├── shared/
│   ├── domain/
│   ├── application/
│   └── infrastructure/
├── config/
├── migrations/
├── app.module.ts
└── main.ts
```

Inbox e Outbox podem compartilhar componentes de infraestrutura, mas
seus contratos e responsabilidades devem permanecer explícitos. O
domínio financeiro não deve depender de detalhes do SQS.

------------------------------------------------------------------------

## 6. Priorização

A ordem de prioridade deve respeitar as dependências entre as fases.

### Prioridade máxima --- Integridade financeira

-   Fase 2 --- Modelagem de domínio.
-   Fase 3 --- Persistência e banco de dados.
-   Fase 4 --- Wallet e Ledger.
-   Fase 5 --- Motor de transações.
-   Fase 6 --- Idempotência e concorrência.

### Prioridade alta --- Confiabilidade distribuída

-   Fase 8 --- Processamento assíncrono.
-   Fase 9 --- Transactional Outbox.
-   Fase 10 --- Operações fora de ordem.
-   Fase 13 --- Testes avançados.

### Prioridade complementar --- Produto e operação

-   Fase 0 --- Planejamento e arquitetura.
-   Fase 1 --- Infraestrutura.
-   Fase 7 --- API HTTP.
-   Fase 11 --- Reconciliação.
-   Fase 12 --- Observabilidade.
-   Fase 14 --- Documentação e entrega.

A classificação indica prioridade de investimento, não autorização para
ignorar requisitos. Todas as fases são necessárias para a conclusão do
desafio.

------------------------------------------------------------------------

## 7. Checklist geral de conclusão

-   [ ] Stack obrigatória funcionando: Bun, TypeScript, NestJS,
    PostgreSQL, SQS e Docker Compose.
-   [ ] Domínio implementado: Money, Wallet, WagerTransaction e Ledger.
-   [ ] Integridade financeira comprovada: nenhum saldo negativo ou
    lançamento duplicado.
-   [ ] Idempotência persistente: replay seguro e conflito de payload
    identificado.
-   [ ] Concorrência real: três ou mais instâncias processando operações
    simultaneamente.
-   [ ] API completa: endpoints obrigatórios implementados.
-   [ ] Inbox e Outbox: atomicidade, redelivery e recuperação após
    falhas.
-   [ ] Operações fora de ordem: referências pendentes e reprocessamento
    funcionando.
-   [ ] Reconciliação: saldo materializado comparado ao ledger.
-   [ ] Observabilidade: logs, métricas e health checks.
-   [ ] Testes reais: PostgreSQL e SQS em containers, sem substituir
    tudo por mocks.
-   [ ] Documentação final: README e ARCHITECTURE completos e decisões
    justificadas.

------------------------------------------------------------------------

## 8. Diretrizes de execução

1.  Não avançar para uma nova fase enquanto os critérios de aceitação da
    fase atual não estiverem comprovados.
2.  Cada fase deve possuir documentação técnica e testes
    correspondentes.
3.  Decisões arquiteturais devem ser registradas no `ARCHITECTURE.md`.
4.  O desenvolvimento deve ser incremental, com entregas verificáveis.
5.  Não adicionar tecnologias sem justificativa técnica.
6.  Não sacrificar consistência financeira para acelerar a
    implementação.
7.  Validar funcionalidades considerando múltiplas instâncias e falhas.
8.  Manter o README e os documentos técnicos sincronizados com o código.

## 9. Resultado esperado

Ao final, o sistema deverá:

-   Receber transações de múltiplos provedores.
-   Processar apostas, ganhos, perdas e reversões.
-   Manter carteiras e ledger consistentes.
-   Suportar requisições e mensagens duplicadas.
-   Funcionar com múltiplas instâncias.
-   Processar mensagens assincronamente.
-   Recuperar-se de falhas de infraestrutura e reinicializações.
-   Publicar eventos de maneira confiável.
-   Tratar operações fora de ordem.
-   Detectar divergências financeiras.
-   Possuir testes reais de concorrência e resiliência.
-   Estar documentado e pronto para avaliação técnica.

**Regra de encerramento:** o projeto só deve ser considerado concluído
quando os invariantes financeiros e os cenários obrigatórios do desafio
estiverem comprovados por testes reproduzíveis.
