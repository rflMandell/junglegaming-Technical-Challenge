import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { AppModule } from '../../src/app.module';
import { CreateWalletUseCase } from '../../src/modules/wallet/application/use-cases/create-wallet.use-case';
import { GetWalletUseCase } from '../../src/modules/wallet/application/use-cases/get-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '../../src/modules/wagering/application/use-cases/process-wager-transaction.use-case';
import { GetWalletLedgerUseCase } from '../../src/modules/ledger/application/use-cases/get-wallet-ledger.use-case';
import { WagerTransactionKind } from '../../src/modules/wagering/domain/wager-transaction-kind.enum';
import { WagerTransactionStatus } from '../../src/modules/wagering/domain/wager-transaction-status.enum';
import { FailureCode } from '../../src/modules/wagering/domain/failure-code.enum';
import { IdempotencyPayloadMismatchError } from '../../src/modules/wagering/domain/wagering.errors';
import { Money } from '../../src/shared/domain/value-objects/money.value-object';
import { LedgerDirection } from '../../src/modules/ledger/domain/ledger-direction.enum';

describe('Idempotency & Concurrency (Integration)', () => {
  let app: INestApplication;
  let createWalletUseCase: CreateWalletUseCase;
  let getWalletUseCase: GetWalletUseCase;
  let processWagerUseCase: ProcessWagerTransactionUseCase;
  let getLedgerUseCase: GetWalletLedgerUseCase;

  const providerId = 'provider-concurrency-test';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    createWalletUseCase = app.get(CreateWalletUseCase);
    getWalletUseCase = app.get(GetWalletUseCase);
    processWagerUseCase = app.get(ProcessWagerTransactionUseCase);
    getLedgerUseCase = app.get(GetWalletLedgerUseCase);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  describe('Cenário Obrigatório: Duas apostas de R$ 80 disputando R$ 100 em paralelo', () => {
    it('deve processar exatamente UMA aposta e rejeitar a OUTRA por saldo insuficiente, resultando em saldo R$ 20', async () => {
      const playerId = uuidv7();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const bet1Id = `bet-race-1-${uuidv7()}`;
      const bet2Id = `bet-race-2-${uuidv7()}`;

      // Dispara simultaneamente duas apostas de 80.00 BRL
      const [result1, result2] = await Promise.all([
        processWagerUseCase.execute({
          providerId,
          externalTransactionId: bet1Id,
          playerId,
          walletId: wallet.id,
          roundId: 'round-race',
          gameId: 'chimp-game',
          kind: WagerTransactionKind.Bet,
          money: { amount: '80.00', currency: 'BRL' },
        }),
        processWagerUseCase.execute({
          providerId,
          externalTransactionId: bet2Id,
          playerId,
          walletId: wallet.id,
          roundId: 'round-race',
          gameId: 'chimp-game',
          kind: WagerTransactionKind.Bet,
          money: { amount: '80.00', currency: 'BRL' },
        }),
      ]);

      const results = [result1, result2];
      const processed = results.filter((r) => r.status === WagerTransactionStatus.Processed);
      const rejected = results.filter((r) => r.status === WagerTransactionStatus.Rejected);

      // Invariantes estritas do desafio
      expect(processed.length).toBe(1);
      expect(rejected.length).toBe(1);
      expect(rejected[0].failureCode).toBe(FailureCode.InsufficientFunds);

      // Saldo final deve ser exatamente 20.00 BRL
      const finalWallet = await getWalletUseCase.execute(wallet.id);
      expect(finalWallet.balance.amount).toBe('20.00');

      // Exatamente um lançamento de débito no ledger
      const ledger = await getLedgerUseCase.execute({ walletId: wallet.id });
      const debits = ledger.items.filter((i) => i.direction === LedgerDirection.Debit);
      expect(debits.length).toBe(1);
      expect(debits[0].money.amount).toBe('80.00');
      expect(debits[0].balanceAfter.amount).toBe('20.00');

      // Invariante contábil: Saldo da wallet == Saldo reconstruído pelo ledger
      let calculated = Money.zero('BRL');
      const chronological = [...ledger.items].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );
      for (const item of chronological) {
        const itemMoney = Money.from(item.money);
        if (item.direction === LedgerDirection.Credit) {
          calculated = calculated.add(itemMoney);
        } else {
          calculated = calculated.subtract(itemMoney);
        }
      }
      expect(calculated.toString()).toBe('20.00');
      expect(calculated.toString()).toBe(finalWallet.balance.amount);
    });
  });

  describe('Cenário de Idempotência sob Concorrência: 50 envios simultâneos da mesma aposta', () => {
    it('deve debitar exatamente UMA vez com 49 replays idempotentes', async () => {
      const playerId = uuidv7();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const fixedExternalId = `bet-50x-${uuidv7()}`;
      const idempotencyKey = `${providerId}:${fixedExternalId}`;
      const payload = {
        providerId,
        externalTransactionId: fixedExternalId,
        playerId,
        walletId: wallet.id,
        roundId: 'round-50x',
        gameId: 'chimp-game',
        kind: WagerTransactionKind.Bet,
        money: { amount: '35.00', currency: 'BRL' },
      };

      // Dispara 50 requisições simultâneas em paralelo com a mesma Idempotency-Key
      const parallelRequests = Array.from({ length: 50 }, () =>
        processWagerUseCase.execute(payload, { idempotencyKey }),
      );

      const results = await Promise.all(parallelRequests);

      // Todas devem ter sucesso
      expect(results.length).toBe(50);
      for (const res of results) {
        expect(res.status).toBe(WagerTransactionStatus.Processed);
        expect(res.balance.amount).toBe('65.00');
      }

      // Pelo menos 49 devem ser idênticos replays com flag idempotentReplay true
      const replays = results.filter((r) => r.idempotentReplay === true);
      expect(replays.length).toBeGreaterThanOrEqual(49);

      // Saldo final na carteira deve ser 100 - 35 = 65.00 BRL
      const finalWallet = await getWalletUseCase.execute(wallet.id);
      expect(finalWallet.balance.amount).toBe('65.00');

      // No ledger deve constar exatamente 1 lançamento de débito
      const ledger = await getLedgerUseCase.execute({ walletId: wallet.id });
      const debits = ledger.items.filter((i) => i.direction === LedgerDirection.Debit);
      expect(debits.length).toBe(1);
      expect(debits[0].money.amount).toBe('35.00');
    });
  });

  describe('Idempotência Sequencial e Conflito de Payload', () => {
    it('deve retornar resultado original em replay idêntico sequencial', async () => {
      const playerId = uuidv7();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const extId = `bet-seq-${uuidv7()}`;
      const idempotencyKey = `${providerId}:${extId}`;
      const payload = {
        providerId,
        externalTransactionId: extId,
        playerId,
        walletId: wallet.id,
        roundId: 'round-seq',
        gameId: 'slot-game',
        kind: WagerTransactionKind.Bet,
        money: { amount: '20.00', currency: 'BRL' },
      };

      const firstCall = await processWagerUseCase.execute(payload, { idempotencyKey });
      expect(firstCall.status).toBe(WagerTransactionStatus.Processed);
      expect(firstCall.balance.amount).toBe('80.00');
      expect(firstCall.idempotentReplay).toBe(false);

      // Replay idêntico
      const secondCall = await processWagerUseCase.execute(payload, { idempotencyKey });
      expect(secondCall.status).toBe(WagerTransactionStatus.Processed);
      expect(secondCall.transactionId).toBe(firstCall.transactionId);
      expect(secondCall.idempotentReplay).toBe(true);
    });

    it('deve rejeitar com IdempotencyPayloadMismatchError se a mesma chave vier com payload divergente', async () => {
      const playerId = uuidv7();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const extId = `bet-conflict-${uuidv7()}`;
      const idempotencyKey = `${providerId}:${extId}`;

      // Primeira submissão com valor 25.00
      await processWagerUseCase.execute(
        {
          providerId,
          externalTransactionId: extId,
          playerId,
          walletId: wallet.id,
          roundId: 'round-c',
          gameId: 'slot-game',
          kind: WagerTransactionKind.Bet,
          money: { amount: '25.00', currency: 'BRL' },
        },
        { idempotencyKey },
      );

      // Segunda submissão com a MESMA chave, mas com valor 50.00 (divergente!)
      expect(
        processWagerUseCase.execute(
          {
            providerId,
            externalTransactionId: extId,
            playerId,
            walletId: wallet.id,
            roundId: 'round-c',
            gameId: 'slot-game',
            kind: WagerTransactionKind.Bet,
            money: { amount: '50.00', currency: 'BRL' }, // payload diferente!
          },
          { idempotencyKey },
        ),
      ).rejects.toThrow(IdempotencyPayloadMismatchError);
    });
  });

  describe('Concorrência entre Carteiras Distintas (Paralelismo)', () => {
    it('deve processar 10 carteiras diferentes em paralelo sem deadlocks ou bloqueios cruzados', async () => {
      // Cria 10 carteiras
      const wallets = await Promise.all(
        Array.from({ length: 10 }, () =>
          createWalletUseCase.execute({
            playerId: uuidv7(),
            initialBalance: { amount: '100.00', currency: 'BRL' },
          }),
        ),
      );

      // Executa uma aposta em cada carteira simultaneamente em paralelo
      const betPromises = wallets.map((w, index) =>
        processWagerUseCase.execute({
          providerId,
          externalTransactionId: `bet-wallet-${index}-${uuidv7()}`,
          playerId: w.playerId,
          walletId: w.id,
          roundId: `round-par-${index}`,
          gameId: 'slot-game',
          kind: WagerTransactionKind.Bet,
          money: { amount: '10.00', currency: 'BRL' },
        }),
      );

      const results = await Promise.all(betPromises);

      expect(results.length).toBe(10);
      for (const res of results) {
        expect(res.status).toBe(WagerTransactionStatus.Processed);
        expect(res.balance.amount).toBe('90.00');
      }
    });
  });
});
