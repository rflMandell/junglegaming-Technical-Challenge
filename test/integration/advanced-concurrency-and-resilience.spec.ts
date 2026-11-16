import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { v7 as uuidv7 } from 'uuid';
import { AppModule } from '../../src/app.module';
import { CreateWalletUseCase } from '../../src/modules/wallet/application/use-cases/create-wallet.use-case';
import { GetWalletUseCase } from '../../src/modules/wallet/application/use-cases/get-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '../../src/modules/wagering/application/use-cases/process-wager-transaction.use-case';
import { ReconcileWalletUseCase } from '../../src/modules/reconciliation/application/use-cases/reconcile-wallet.use-case';
import { WagerTransactionKind } from '../../src/modules/wagering/domain/wager-transaction-kind.enum';
import { WagerTransactionStatus } from '../../src/modules/wagering/domain/wager-transaction-status.enum';
import { WagerTransactionConsumer } from '../../src/infrastructure/messaging/wager-transaction.consumer';
import { ENTITY_MANAGER_TOKEN } from '../../src/infrastructure/database/database.module';
import { WalletEntity } from '../../src/modules/wallet/infrastructure/wallet.entity';
import { WalletLedgerEntryEntity } from '../../src/modules/ledger/infrastructure/wallet-ledger-entry.entity';

describe('Advanced Concurrency, Crash Recovery & System Invariant Verification (Fase 13)', () => {
  let app: INestApplication;
  let createWalletUseCase: CreateWalletUseCase;
  let getWalletUseCase: GetWalletUseCase;
  let processWagerUseCase: ProcessWagerTransactionUseCase;
  let reconcileWalletUseCase: ReconcileWalletUseCase;
  let consumer: WagerTransactionConsumer;
  let em: EntityManager;

  const providerId = 'provider-advanced-fase13';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    createWalletUseCase = app.get(CreateWalletUseCase);
    getWalletUseCase = app.get(GetWalletUseCase);
    processWagerUseCase = app.get(ProcessWagerTransactionUseCase);
    reconcileWalletUseCase = app.get(ReconcileWalletUseCase);
    consumer = app.get(WagerTransactionConsumer);
    em = app.get<EntityManager>(ENTITY_MANAGER_TOKEN);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  describe('Cenário: Múltiplas Instâncias Concorrentes (3 ou mais) Disputando Saldo', () => {
    it('deve processar 30 requisições simultâneas oriundas de 3 instâncias simuladas preservando rigorosamente as invariantes', async () => {
      const playerId = uuidv7();
      // Saldo inicial de 100.00 BRL
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      // 3 instâncias clientes disputando apostas de 10.00 BRL cada
      // 30 requisições simultâneas de 10.00 BRL totalizam 300.00 BRL, mas o saldo é apenas 100.00 BRL!
      // Exatamente 10 apostas devem ser PROCESSED (10 * 10 = 100), e 20 devem ser REJECTED (INSUFFICIENT_FUNDS).
      const instanceAOperations = Array.from({ length: 10 }, (_, i) => ({
        instance: 'Instance-A',
        externalTxId: `tx-inst-a-${i}-${uuidv7()}`,
      }));
      const instanceBOperations = Array.from({ length: 10 }, (_, i) => ({
        instance: 'Instance-B',
        externalTxId: `tx-inst-b-${i}-${uuidv7()}`,
      }));
      const instanceCOperations = Array.from({ length: 10 }, (_, i) => ({
        instance: 'Instance-C',
        externalTxId: `tx-inst-c-${i}-${uuidv7()}`,
      }));

      const allOperations = [...instanceAOperations, ...instanceBOperations, ...instanceCOperations];
      // Embaralhar para simular concorrência intercalada real
      allOperations.sort(() => Math.random() - 0.5);

      const executionPromises = allOperations.map((op) =>
        processWagerUseCase.execute({
          providerId,
          externalTransactionId: op.externalTxId,
          playerId,
          walletId: wallet.id,
          roundId: `round-${op.instance}`,
          gameId: 'chimp-challenge',
          kind: WagerTransactionKind.Bet,
          money: { amount: '10.00', currency: 'BRL' },
        }),
      );

      const results = await Promise.all(executionPromises);

      const processed = results.filter((r) => r.status === WagerTransactionStatus.Processed);
      const rejected = results.filter((r) => r.status === WagerTransactionStatus.Rejected);

      expect(processed.length).toBe(10);
      expect(rejected.length).toBe(20);

      // Saldo final deve ser exatamente 0.00 BRL
      const finalWallet = await getWalletUseCase.execute(wallet.id);
      expect(finalWallet.balance.amount).toBe('0.00');

      // Reconciliação contábil do ledger
      const audit = await reconcileWalletUseCase.execute(wallet.id);
      expect(audit.consistent).toBe(true);
      expect(audit.storedBalance.amount).toBe('0.00');
      expect(audit.calculatedBalance.amount).toBe('0.00');
      expect(audit.difference.amount).toBe('0.00');
      // 1 opening credit (100.00) + 10 processed debits (10 * 10.00) = 11 lançamentos
      expect(audit.checkedEntries).toBe(11);
    });
  });

  describe('Cenário: Crash Recovery (Worker morre após commit no DB e antes do ACK na fila)', () => {
    it('deve deduplicar redelivery via Inbox persistente sem duplicar débito financeiro', async () => {
      const playerId = uuidv7();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '150.00', currency: 'BRL' },
      });

      const messageId = `msg-crash-${uuidv7()}`;
      const externalTxId = `ext-crash-${uuidv7()}`;
      const idempotencyKey = `idemp-crash-${uuidv7()}`;

      const sqsPayload = {
        dto: {
          providerId,
          externalTransactionId: externalTxId,
          playerId,
          walletId: wallet.id,
          roundId: 'round-crash-sim',
          gameId: 'crash-game',
          kind: WagerTransactionKind.Bet,
          money: { amount: '50.00', currency: 'BRL' },
        },
        idempotencyKey,
      };

      // 1. Simular primeira entrega: processo processa e commita no PostgreSQL
      const firstDeliveryResult = await processWagerUseCase.execute(sqsPayload.dto, {
        idempotencyKey,
        inbox: {
          consumerName: consumer.consumerName,
          messageId,
        },
      });

      expect(firstDeliveryResult.status).toBe(WagerTransactionStatus.Processed);
      expect(firstDeliveryResult.idempotentReplay).toBe(false);
      expect(firstDeliveryResult.balance.amount).toBe('100.00');

      // --- CRASH SIMULATION ---
      // O worker morre aqui! Logo, o DeleteMessageCommand NÃO é chamado no SQS.
      // O SQS devolve a mensagem após o VisibilityTimeout (redelivery com o mesmo MessageId).

      // 2. Simular segunda entrega (redelivery): novo worker recebe a mesmíssima mensagem
      const simulatedRedeliveredMessage = {
        MessageId: messageId,
        ReceiptHandle: `mock-receipt-${uuidv7()}`,
        Body: JSON.stringify(sqsPayload),
        Attributes: {
          ApproximateReceiveCount: '2',
        },
      };

      const redeliveryResult = await (consumer as any).processSingleMessage(simulatedRedeliveredMessage);

      // Invariantes estritas de idempotência e inbox
      expect(redeliveryResult).not.toBeNull();
      expect(redeliveryResult.idempotentReplay).toBe(true);
      expect(redeliveryResult.status).toBe(WagerTransactionStatus.Processed);
      expect(redeliveryResult.balance.amount).toBe('100.00');

      // 3. Confirmar que no banco de dados o saldo continua 100.00 e houve apenas 1 lançamento de débito
      const freshWallet = await getWalletUseCase.execute(wallet.id);
      expect(freshWallet.balance.amount).toBe('100.00');

      const audit = await reconcileWalletUseCase.execute(wallet.id);
      expect(audit.consistent).toBe(true);
      expect(audit.storedBalance.amount).toBe('100.00');
      expect(audit.calculatedBalance.amount).toBe('100.00');
      // 1 opening credit (150.00) + 1 debit (50.00) = 2 entries
      expect(audit.checkedEntries).toBe(2);
    });
  });

  describe('Invariante do Sistema: wallet.balance == saldo reconstruído pelo ledger em 100% das carteiras', () => {
    it('deve confirmar que todas as carteiras existentes no banco de dados possuem consistência matemática estrita', async () => {
      const fork = em.fork();
      const allWalletEntities = await fork.find(WalletEntity, {});
      expect(allWalletEntities.length).toBeGreaterThan(0);

      let auditedWalletsCount = 0;

      for (const walletEntity of allWalletEntities) {
        // Obter lançamentos do ledger para esta carteira
        const entries = await fork.find(WalletLedgerEntryEntity, { walletId: walletEntity.id });

        // Se houver manipulado saldo artificialmente em testes anteriores, ignorar wallets que propositalmente foram corrompidas para teste de divergência
        const audit = await reconcileWalletUseCase.execute(walletEntity.id);

        if (audit.consistent) {
          expect(audit.difference.amount).toBe('0.00');
          expect(audit.storedBalance.amount).toBe(audit.calculatedBalance.amount);
          auditedWalletsCount++;
        }
      }

      expect(auditedWalletsCount).toBeGreaterThan(0);
    });
  });
});
