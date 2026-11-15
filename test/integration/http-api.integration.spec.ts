import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { AppModule } from '../../src/app.module';
import { CorrelationIdInterceptor } from '../../src/shared/presentation/interceptors/correlation-id.interceptor';
import { GlobalHttpExceptionFilter } from '../../src/shared/presentation/filters/http-exception.filter';
import { ProviderAuthGuard } from '../../src/shared/presentation/guards/provider-auth.guard';
import { WagerTransactionKind } from '../../src/modules/wagering/domain/wager-transaction-kind.enum';
import { WagerTransactionStatus } from '../../src/modules/wagering/domain/wager-transaction-status.enum';

describe('HTTP API Endpoints & Contract Verification (Integration)', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalInterceptors(new CorrelationIdInterceptor());
    app.useGlobalFilters(new GlobalHttpExceptionFilter());
    app.useGlobalGuards(new ProviderAuthGuard());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );

    await app.init();
    await app.listen(0);
    const server = app.getHttpServer();
    const address = server.address();
    const port = typeof address === 'string' ? address : address.port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  describe('Health Probes', () => {
    it('GET /health/live returns 200 and liveness payload without auth', async () => {
      const res = await fetch(`${baseUrl}/health/live`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe('ok');
      expect(data.uptime).toBeGreaterThanOrEqual(0);
    });

    it('GET /health/ready returns 200 with postgres and sqs status', async () => {
      const res = await fetch(`${baseUrl}/health/ready`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe('ok');
      expect(data.details.postgres.status).toBe('up');
      expect(data.details.sqs.status).toBe('up');
    });
  });

  describe('Wallets & Ledger Endpoints', () => {
    let createdWalletId: string;
    const playerId = uuidv7();

    it('POST /wallets should create a wallet and opening ledger entry (201)', async () => {
      const res = await fetch(`${baseUrl}/wallets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playerId,
          initialBalance: { amount: '150.00', currency: 'BRL' },
        }),
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.id).toBeDefined();
      expect(data.playerId).toBe(playerId);
      expect(data.balance.amount).toBe('150.00');
      expect(data.balance.currency).toBe('BRL');
      expect(data.version).toBe(1);
      createdWalletId = data.id;
    });

    it('POST /wallets should return 409 Conflict when creating duplicate wallet for player', async () => {
      const res = await fetch(`${baseUrl}/wallets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playerId,
          initialBalance: { amount: '50.00', currency: 'BRL' },
        }),
      });

      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.statusCode).toBe(409);
      expect(data.error).toBe('Conflict');
      expect(data.message).toContain(playerId);
    });

    it('POST /wallets should return 400 Bad Request on invalid payload', async () => {
      const res = await fetch(`${baseUrl}/wallets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playerId: 'not-a-valid-uuid',
          initialBalance: { amount: 'invalid-number', currency: 'BRL' },
        }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.statusCode).toBe(400);
    });

    it('GET /wallets/:walletId should return wallet details (200)', async () => {
      const res = await fetch(`${baseUrl}/wallets/${createdWalletId}`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.id).toBe(createdWalletId);
      expect(data.balance.amount).toBe('150.00');
    });

    it('GET /wallets/:walletId should return 404 for non-existent wallet', async () => {
      const randomId = uuidv7();
      const res = await fetch(`${baseUrl}/wallets/${randomId}`);
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.statusCode).toBe(404);
      expect(data.error).toBe('Not Found');
    });

    it('GET /wallets/:walletId/ledger should return paginated ledger entries (200)', async () => {
      const res = await fetch(`${baseUrl}/wallets/${createdWalletId}/ledger?limit=10`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data.items)).toBe(true);
      expect(data.items.length).toBe(1); // Opening balance entry
      expect(data.items[0].direction).toBe('CREDIT');
      expect(data.items[0].money.amount).toBe('150.00');
      expect(data.items[0].balanceAfter.amount).toBe('150.00');
    });

    it('POST /wallets/:walletId/reconciliation should reconcile stored balance against ledger (200)', async () => {
      const res = await fetch(`${baseUrl}/wallets/${createdWalletId}/reconciliation`, {
        method: 'POST',
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.walletId).toBe(createdWalletId);
      expect(data.consistent).toBe(true);
      expect(data.storedBalance.amount).toBe('150.00');
      expect(data.calculatedBalance.amount).toBe('150.00');
      expect(data.difference.amount).toBe('0.00');
      expect(data.checkedEntries).toBe(1);
    });
  });

  describe('Wagering Transactions Endpoints', () => {
    let walletId: string;
    const runId = uuidv7();
    const playerId = uuidv7();
    const providerId = `http-prov-${runId}`;
    const bet1ExtTxId = `ext-bet-${runId}-001`;

    beforeAll(async () => {
      const res = await fetch(`${baseUrl}/wallets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playerId,
          initialBalance: { amount: '100.00', currency: 'BRL' },
        }),
      });
      const data = await res.json();
      walletId = data.id;
    });

    it('POST /wagering/transactions without Idempotency-Key header returns 400 Bad Request', async () => {
      const res = await fetch(`${baseUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId,
          externalTransactionId: `no-idemp-${runId}-001`,
          playerId,
          walletId,
          roundId: 'round-1',
          gameId: 'game-1',
          kind: WagerTransactionKind.Bet,
          money: { amount: '10.00', currency: 'BRL' },
        }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.message).toContain('Idempotency-Key');
    });

    it('POST /wagering/transactions processes valid BET (201) and returns correlation header', async () => {
      const correlationId = uuidv7();
      const idempotencyKey = `idemp-bet-${runId}-001`;

      const res = await fetch(`${baseUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
          'X-Correlation-Id': correlationId,
        },
        body: JSON.stringify({
          providerId,
          externalTransactionId: bet1ExtTxId,
          playerId,
          walletId,
          roundId: 'round-10',
          gameId: 'game-roulette',
          kind: WagerTransactionKind.Bet,
          money: { amount: '30.00', currency: 'BRL' },
        }),
      });

      expect(res.status).toBe(201);
      expect(res.headers.get('x-correlation-id')).toBe(correlationId);
      const data = await res.json();
      expect(data.transactionId).toBeDefined();
      expect(data.status).toBe(WagerTransactionStatus.Processed);
      expect(data.balance.amount).toBe('70.00');
      expect(data.idempotentReplay).toBe(false);

      // Verify GET /wagering/transactions/:transactionId
      const getTxRes = await fetch(`${baseUrl}/wagering/transactions/${data.transactionId}`);
      expect(getTxRes.status).toBe(200);
      const txData = await getTxRes.json();
      expect(txData.id).toBe(data.transactionId);
      expect(txData.externalTransactionId).toBe(bet1ExtTxId);
      expect(txData.money.amount).toBe('30.00');

      // Verify GET /providers/:providerId/wagering/transactions/:externalTransactionId
      const getExtTxRes = await fetch(
        `${baseUrl}/providers/${providerId}/wagering/transactions/${bet1ExtTxId}`,
      );
      expect(getExtTxRes.status).toBe(200);
      const extTxData = await getExtTxRes.json();
      expect(extTxData.id).toBe(data.transactionId);
      expect(extTxData.providerId).toBe(providerId);
    });

    it('POST /wagering/transactions returns 200 on identical idempotent replay', async () => {
      const idempotencyKey = `idemp-bet-replay-${runId}`;
      const externalTxId = `ext-bet-replay-${runId}`;
      const payload = {
        providerId,
        externalTransactionId: externalTxId,
        playerId,
        walletId,
        roundId: 'round-11',
        gameId: 'game-roulette',
        kind: WagerTransactionKind.Bet,
        money: { amount: '20.00', currency: 'BRL' },
      };

      const firstRes = await fetch(`${baseUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(payload),
      });
      expect(firstRes.status).toBe(201);
      const firstData = await firstRes.json();
      expect(firstData.balance.amount).toBe('50.00'); // 70 - 20 = 50

      const replayRes = await fetch(`${baseUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(payload),
      });
      expect(replayRes.status).toBe(200);
      const replayData = await replayRes.json();
      expect(replayData.transactionId).toBe(firstData.transactionId);
      expect(replayData.idempotentReplay).toBe(true);
      expect(replayData.balance.amount).toBe('50.00');
    });

    it('POST /wagering/transactions returns 409 Conflict when idempotency key payload differs', async () => {
      const idempotencyKey = `idemp-conflict-${runId}`;
      const payloadA = {
        providerId,
        externalTransactionId: `ext-orig-${runId}`,
        playerId,
        walletId,
        roundId: 'round-orig',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet,
        money: { amount: '5.00', currency: 'BRL' },
      };

      const firstRes = await fetch(`${baseUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(payloadA),
      });
      expect(firstRes.status).toBe(201);

      // Attempt with different amount but same idempotency key
      const payloadB = {
        ...payloadA,
        money: { amount: '10.00', currency: 'BRL' },
      };
      const conflictRes = await fetch(`${baseUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(payloadB),
      });
      expect(conflictRes.status).toBe(409);
      const conflictData = await conflictRes.json();
      expect(conflictData.statusCode).toBe(409);
      expect(conflictData.failureCode).toBe('IDEMPOTENCY_PAYLOAD_MISMATCH');
    });

    it('POST /wagering/transactions returns 422 Unprocessable Entity when balance is insufficient', async () => {
      // Current balance is 45.00 BRL (100 - 30 - 20 - 5 = 45)
      const idempotencyKey = `idemp-insufficient-${runId}`;
      const externalTxId = `ext-insufficient-${runId}`;

      const res = await fetch(`${baseUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          providerId,
          externalTransactionId: externalTxId,
          playerId,
          walletId,
          roundId: 'round-fail',
          gameId: 'game-roulette',
          kind: WagerTransactionKind.Bet,
          money: { amount: '500.00', currency: 'BRL' }, // Exceeds balance
        }),
      });

      expect(res.status).toBe(422);
      const data = await res.json();
      expect(data.statusCode).toBe(422);
      expect(data.failureCode).toBe('INSUFFICIENT_FUNDS');
      expect(data.balance.amount).toBe('45.00'); // Unchanged
    });

    it('POST /wagering/transactions processes WIN (201) referencing previous BET', async () => {
      const idempotencyKey = `idemp-win-${runId}`;
      const externalTxId = `ext-win-${runId}`;

      const res = await fetch(`${baseUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          providerId,
          externalTransactionId: externalTxId,
          playerId,
          walletId,
          roundId: 'round-10',
          gameId: 'game-roulette',
          kind: WagerTransactionKind.Win,
          money: { amount: '100.00', currency: 'BRL' },
          referenceExternalTransactionId: bet1ExtTxId,
        }),
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.status).toBe(WagerTransactionStatus.Processed);
      expect(data.balance.amount).toBe('145.00'); // 45 + 100 = 145

      // Final reconciliation check
      const reconRes = await fetch(`${baseUrl}/wallets/${walletId}/reconciliation`, {
        method: 'POST',
      });
      expect(reconRes.status).toBe(200);
      const reconData = await reconRes.json();
      expect(reconData.consistent).toBe(true);
      expect(reconData.storedBalance.amount).toBe('145.00');
      expect(reconData.calculatedBalance.amount).toBe('145.00');
      expect(reconData.difference.amount).toBe('0.00');
    });
  });
});
