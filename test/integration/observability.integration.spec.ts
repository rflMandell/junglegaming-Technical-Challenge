import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { v7 as uuidv7 } from 'uuid';
import { AppModule } from '../../src/app.module';
import { MetricsService } from '../../src/modules/metrics/metrics.service';
import { CreateWalletUseCase } from '../../src/modules/wallet/application/use-cases/create-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '../../src/modules/wagering/application/use-cases/process-wager-transaction.use-case';
import { ReconcileWalletUseCase } from '../../src/modules/reconciliation/application/use-cases/reconcile-wallet.use-case';
import { WagerTransactionKind } from '../../src/modules/wagering/domain/wager-transaction-kind.enum';
import { ENTITY_MANAGER_TOKEN } from '../../src/infrastructure/database/database.module';
import { CorrelationIdInterceptor } from '../../src/shared/presentation/interceptors/correlation-id.interceptor';
import { ProviderAuthGuard } from '../../src/shared/presentation/guards/provider-auth.guard';
import { GlobalHttpExceptionFilter } from '../../src/shared/presentation/filters/http-exception.filter';

describe('Observability & Resilience Module (Integration)', () => {
  let app: INestApplication;
  let metricsService: MetricsService;
  let createWalletUseCase: CreateWalletUseCase;
  let processWagerUseCase: ProcessWagerTransactionUseCase;
  let reconcileWalletUseCase: ReconcileWalletUseCase;
  let em: EntityManager;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    metricsService = app.get(MetricsService);

    app.useGlobalInterceptors(new CorrelationIdInterceptor(metricsService));
    app.useGlobalFilters(new GlobalHttpExceptionFilter());
    app.useGlobalGuards(new ProviderAuthGuard());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

    await app.init();
    await app.listen(0);

    const port = (app.getHttpServer().address() as any).port;
    baseUrl = `http://localhost:${port}`;

    createWalletUseCase = app.get(CreateWalletUseCase);
    processWagerUseCase = app.get(ProcessWagerTransactionUseCase);
    reconcileWalletUseCase = app.get(ReconcileWalletUseCase);
    em = app.get<EntityManager>(ENTITY_MANAGER_TOKEN);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  beforeEach(() => {
    metricsService.reset();
  });

  describe('Correlation ID Propagation', () => {
    it('should generate a new correlation ID when request does not provide one', async () => {
      const res = await fetch(`${baseUrl}/health/live`);
      expect(res.status).toBe(200);

      const correlationHeader = res.headers.get('x-correlation-id');
      expect(correlationHeader).toBeDefined();
      expect(typeof correlationHeader).toBe('string');
      expect(correlationHeader!.length).toBeGreaterThan(10);
    });

    it('should preserve and propagate client-provided correlation ID in responses', async () => {
      const customCorrelationId = `corr-${uuidv7()}`;
      const res = await fetch(`${baseUrl}/health/live`, {
        headers: {
          'x-correlation-id': customCorrelationId,
        },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('x-correlation-id')).toBe(customCorrelationId);
    });
  });

  describe('Prometheus Metrics Telemetry Endpoint (/metrics)', () => {
    it('should expose standard Prometheus text format with all required metric families', async () => {
      const res = await fetch(`${baseUrl}/metrics`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/plain');

      const body = await res.text();
      expect(body).toContain('# HELP wagering_transactions_total');
      expect(body).toContain('# TYPE wagering_transactions_total counter');
      expect(body).toContain('# HELP wagering_duplicate_requests_total');
      expect(body).toContain('# HELP wagering_retries_total');
      expect(body).toContain('# HELP wagering_dlq_messages_total');
      expect(body).toContain('# HELP wagering_lock_conflicts_total');
      expect(body).toContain('# HELP wagering_outbox_lag_count');
      expect(body).toContain('# HELP wagering_processing_duration_ms');
      expect(body).toContain('# HELP wagering_reconciliation_divergence_total');
    });

    it('should export JSON metrics when format=json query parameter is specified', async () => {
      const res = await fetch(`${baseUrl}/metrics?format=json`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');

      const data = await res.json();
      expect(data).toHaveProperty('wagering_transactions_total');
      expect(data).toHaveProperty('wagering_duplicate_requests_total');
      expect(data).toHaveProperty('wagering_retries_total');
      expect(data).toHaveProperty('wagering_dlq_messages_total');
      expect(data).toHaveProperty('wagering_lock_conflicts_total');
      expect(data).toHaveProperty('wagering_outbox_lag_count');
      expect(data).toHaveProperty('wagering_processing_duration_ms');
      expect(data).toHaveProperty('wagering_reconciliation_divergence_total');
    });

    it('should export JSON metrics when Accept header specifies application/json', async () => {
      const res = await fetch(`${baseUrl}/metrics`, {
        headers: {
          Accept: 'application/json',
        },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');

      const data = await res.json();
      expect(data).toHaveProperty('wagering_transactions_total');
    });
  });

  describe('End-to-End Metrics Instrumentation', () => {
    it('should record transaction status, duplicate request, and duration upon operation', async () => {
      const playerId = uuidv7();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '200.00', currency: 'BRL' },
      });

      const externalTxId = `ext-${uuidv7()}`;
      const idempotencyKey = `idemp-${uuidv7()}`;
      const providerId = 'provider-obs-1';

      // 1. Process BET transaction
      const res1 = await processWagerUseCase.execute(
        {
          providerId,
          externalTransactionId: externalTxId,
          playerId,
          walletId: wallet.id,
          roundId: 'round-obs-1',
          gameId: 'game-obs-1',
          kind: WagerTransactionKind.Bet,
          money: { amount: '50.00', currency: 'BRL' },
        },
        { idempotencyKey },
      );

      expect(res1.status).toBe('PROCESSED');
      expect(res1.idempotentReplay).toBe(false);

      // Verify transaction metric recorded
      const jsonMetricsAfterBet = metricsService.getJsonMetrics();
      expect(
        jsonMetricsAfterBet.wagering_transactions_total[`PROCESSED:BET:${providerId}`],
      ).toBe(1);

      // Verify latency metric recorded
      const latencyQuantiles = metricsService.getLatencyQuantiles('process_transaction');
      expect(latencyQuantiles.count).toBeGreaterThanOrEqual(1);
      expect(latencyQuantiles.avgMs).toBeGreaterThan(0);

      // 2. Replay identical BET transaction (duplicate request)
      const res2 = await processWagerUseCase.execute(
        {
          providerId,
          externalTransactionId: externalTxId,
          playerId,
          walletId: wallet.id,
          roundId: 'round-obs-1',
          gameId: 'game-obs-1',
          kind: WagerTransactionKind.Bet,
          money: { amount: '50.00', currency: 'BRL' },
        },
        { idempotencyKey },
      );

      expect(res2.idempotentReplay).toBe(true);

      // Verify duplicate request metric recorded
      const jsonMetricsAfterReplay = metricsService.getJsonMetrics();
      expect(
        jsonMetricsAfterReplay.wagering_duplicate_requests_total['http_engine'],
      ).toBe(1);

      // 3. Inject divergence and reconcile
      const fork = em.fork();
      await fork.execute(
        `UPDATE wallets SET balance = 999.00, updated_at = NOW() WHERE id = ?`,
        [wallet.id],
      );

      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(false);

      // Verify divergence metric recorded
      const jsonMetricsAfterRecon = metricsService.getJsonMetrics();
      expect(
        jsonMetricsAfterRecon.wagering_reconciliation_divergence_total,
      ).toBe(1);

      // Verify Prometheus exporter includes the recorded values
      const prometheus = metricsService.getPrometheusMetrics();
      expect(prometheus).toContain(`wagering_transactions_total{status="PROCESSED",kind="BET",provider="${providerId}"} 1`);
      expect(prometheus).toContain('wagering_duplicate_requests_total{source="http_engine"} 1');
      expect(prometheus).toContain('wagering_reconciliation_divergence_total 1');
    });
  });

  describe('Health Probes Separation', () => {
    it('GET /health/live should succeed as pure liveness check without external dependencies', async () => {
      const res = await fetch(`${baseUrl}/health/live`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.status).toBe('ok');
      expect(data.uptime).toBeGreaterThan(0);
      expect(data.timestamp).toBeDefined();
    });

    it('GET /health/ready should test database and SQS connectivity and report both UP', async () => {
      const res = await fetch(`${baseUrl}/health/ready`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.status).toBe('ok');
      expect(data.info.postgres.status).toBe('up');
      expect(data.info.sqs.status).toBe('up');
    });

    it('health checks should remain open and accessible without authorization headers', async () => {
      const liveRes = await fetch(`${baseUrl}/health/live`);
      expect(liveRes.status).toBe(200);

      const readyRes = await fetch(`${baseUrl}/health/ready`);
      expect(readyRes.status).toBe(200);

      const metricsRes = await fetch(`${baseUrl}/metrics`);
      expect(metricsRes.status).toBe(200);
    });
  });
});
