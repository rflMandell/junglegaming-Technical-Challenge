# Testing Strategy, Scenarios & Quality Assurance

## 1. Filosofia de Testes e Pirâmide de Testes

Para garantir correção financeira absoluta e conformidade com as restrições invioláveis do desafio da Jungle Gaming, a estratégia de testes não substitui a infraestrutura real por mocks artificiais em cenários de integração e concorrência:

1. **Testes Unitários:** Rápidos, determinísticos, sem I/O, isolados no domínio e na camada de aplicação.
2. **Testes de Integração:** Executados contra instâncias reais de **PostgreSQL** e **AWS SQS (LocalStack)** em contêineres Docker.
3. **Testes de Concorrência e Falha:** Concorrência real baseada em threads/processos paralelos disputando saldo e publicações concorrentes.

---

## 2. Invariante Universal de Verificação

Ao final de **todo e qualquer teste de integração ou concorrência**, a asserção obrigatória do sistema é:

$$\text{wallet.balance} = \sum (\text{ledger.credits}) - \sum (\text{ledger.debits})$$

Nenhum teste é considerado bem-sucedido sem comprovação matemática de que o saldo materializado na tabela `wallets` é idêntico ao saldo reconstruído a partir da tabela imutável `wallet_ledger_entries`.

---

## 3. Matriz de Cenários de Teste

### 3.1 Testes Unitários (`test/unit/`)
- **`Money` Value Object:**
  - Rejeição de valores com mais de 2 casas decimais (ex: `"10.555"`).
  - Rejeição de valores negativos em contratos que exigem magnitude positiva (`"-10.00"`).
  - Rejeição de entradas inválidas: `NaN`, `Infinity`, strings vazias, notação científica (`"1e3"`), tipos numéricos de ponto flutuante.
  - Validação de operações aritméticas: `add`, `subtract`, `negate`, `equals`, `isLessThan`, `isZero`, `isPositive`.
  - Lançamento de erro de domínio em operações entre moedas diferentes (`BRL` vs `USD`).
- **`Wallet` Aggregate Root:**
  - Abertura de carteira com saldo zero ou inicial positivo (com geração de transação interna `OPENING`).
  - Débito com saldo suficiente deduz saldo e incrementa `version`.
  - Débito com saldo insuficiente lança `InsufficientFundsError` e preserva saldo e versão intactos.
  - Crédito adiciona saldo e incrementa `version`.
  - Operações com moeda divergente da carteira disparam erro.
- **`WagerTransaction`:**
  - Transições válidas de ciclo de vida (`PENDING` -> `PROCESSED`, `PENDING` -> `PENDING_REFERENCE` -> `PROCESSED`).
  - Tentativa de transição sobre estado terminal (`PROCESSED`, `REJECTED`, `FAILED`) dispara `InvalidTransactionStateError`.
  - Regra de negócio: `REFUND` e `ROLLBACK` exigem `referenceExternalTransactionId`.
  - Regra de negócio: `LOSS` não altera saldo (`affectsBalance() === false`) e não gera lançamento no ledger.
- **`WalletLedgerEntry`:**
  - Imutabilidade estrutural das instâncias.
  - Validação da equação contábil na factory (`balanceBefore ± amount === balanceAfter`).
- **Idempotência:**
  - Cálculo determinístico de hash canônico JSON com ordenação de chaves.
  - Detecção de conflito quando o payload diverge para a mesma `Idempotency-Key`.

---

### 3.2 Testes de Integração (`test/integration/`)
- **Migrations & Schema Constraints:**
  - Validação de execução de migrações `up` e `down`.
  - Tentativa direta de persistir saldo negativo dispara violação da constraint `chk_wallets_balance_non_negative`.
  - Tentativa de duplicar `(playerId, currency)` dispara violação da constraint `uq_wallets_player_currency`.
  - Tentativa de duplicar idempotência dispara `uq_wager_transactions_provider_idempotency`.
  - Tentativa de inserir ledger desbalanceado dispara `chk_ledger_arithmetic_balance`.
- **Atomicidade SQL Transacional:**
  - Simulação de erro no meio da transação: confirma que rollback reverte simultaneamente carteira, ledger, inbox e outbox.
- **Inbox & Redelivery:**
  - Reenvio da mesma mensagem SQS com o mesmo `messageId` é ignorado pelo consumidor após o commit inicial.
- **Transactional Outbox Worker:**
  - Eventos pendentes são identificados, publicados no SQS e marcados com `publishedAt`.
  - Múltiplos workers em paralelo com `SKIP LOCKED` dividem os registros sem duplicidade de processamento ativo.
- **Resiliência a Falhas:**
  - Simulação de queda de processo antes do ACK do SQS: redelivery processado com segurança via Inbox.

---

### 3.3 Testes Obrigatórios de Concorrência (`test/concurrency/`)

| # | Cenário de Concorrência | Metodologia | Resultado Obrigatório Esperado |
|---|---|---|---|
| **C1** | Mesma aposta submetida **50 vezes em paralelo** | Disparo simultâneo (`Promise.all`) com mesma `Idempotency-Key` e mesmo payload | Exatamente **1 débito** aplicado; 49 respostas idempotentes; ledger contém exatamente 1 entrada. |
| **C2** | Saldo inicial `100.00 BRL`. Duas apostas de `80.00 BRL` simultâneas | Duas requisições paralelas competindo pelo saldo da mesma carteira | Exatamente **uma aposta `PROCESSED`**, a outra **`REJECTED`** por `INSUFFICIENT_FUNDS`. Saldo final `20.00 BRL`. Exatamente 1 lançamento de débito no ledger. |
| **C3** | Carteiras distintas processadas em paralelo | Múltiplas apostas em carteiras diferentes simultâneas | Execução paralela sem bloqueio mútuo (throughput linear sem lock global). |
| **C4** | **≥ 3 instâncias** da aplicação concorrentes | Execução de múltiplos contêineres/processos NestJS consumindo filas e recebendo tráfego HTTP | Nenhuma inconsistência financeira; sem *lost updates*; invariantes preservadas. |
| **C5** | Worker morto **após commit e antes do ACK** | Finalização forçada do processo após commit no PostgreSQL | Redelivery da mensagem é absorvida pelo Inbox; nenhum efeito é duplicado. |
| **C6** | Múltiplos publishers na mesma Outbox | Duas ou mais instâncias executando polling de outbox concorrentemente | Todos os eventos são publicados sem duplicação indefinida nem starvation. |
| **C7** | Operação fora de ordem: `REFUND` antes da `BET` | Envio de `REFUND` com referência inexistente, seguido de `BET`, e execução do worker | `REFUND` fica `PENDING_REFERENCE`; após `BET`, worker processa `REFUND` com sucesso e credita saldo. |
| **C8** | Reinício do serviço e conferência final | Reinicialização completa de contêineres e execução da reconciliação | `storedBalance === calculatedBalance`, zero diferença. |

---

## 4. Comandos de Execução dos Testes

Configurados via `package.json`:

```bash
# Executar todos os testes unitários
bun run test:unit

# Executar testes de integração (sobe dependências Docker se necessário)
bun run test:integration

# Executar testes de concorrência e race condition
bun run test:concurrency

# Executar teste de carga (diferencial opcional)
bun run test:load

# Executar suíte completa de verificação
bun run test
```
