import { describe, it, expect, beforeEach } from 'bun:test';
import { MetricsService } from '../../src/modules/metrics/metrics.service';

describe('MetricsService (Unit)', () => {
  let metricsService: MetricsService;

  beforeEach(() => {
    metricsService = new MetricsService();
  });

  describe('Transactions Metric', () => {
    it('should record transactions by status, kind, and provider', () => {
      metricsService.recordTransaction('PROCESSED', 'BET', 'provider-1');
      metricsService.recordTransaction('PROCESSED', 'BET', 'provider-1');
      metricsService.recordTransaction('REJECTED', 'BET', 'provider-1');
      metricsService.recordTransaction('PROCESSED', 'WIN', 'provider-2');

      const json = metricsService.getJsonMetrics();
      expect(json.wagering_transactions_total['PROCESSED:BET:provider-1']).toBe(2);
      expect(json.wagering_transactions_total['REJECTED:BET:provider-1']).toBe(1);
      expect(json.wagering_transactions_total['PROCESSED:WIN:provider-2']).toBe(1);

      const prometheus = metricsService.getPrometheusMetrics();
      expect(prometheus).toContain('wagering_transactions_total{status="PROCESSED",kind="BET",provider="provider-1"} 2');
      expect(prometheus).toContain('wagering_transactions_total{status="REJECTED",kind="BET",provider="provider-1"} 1');
      expect(prometheus).toContain('wagering_transactions_total{status="PROCESSED",kind="WIN",provider="provider-2"} 1');
    });
  });

  describe('Duplicate Requests Metric', () => {
    it('should record duplicate requests detected by idempotency', () => {
      metricsService.recordDuplicateRequest('http_engine');
      metricsService.recordDuplicateRequest('http_engine');
      metricsService.recordDuplicateRequest('sqs_inbox');

      const json = metricsService.getJsonMetrics();
      expect(json.wagering_duplicate_requests_total['http_engine']).toBe(2);
      expect(json.wagering_duplicate_requests_total['sqs_inbox']).toBe(1);

      const prometheus = metricsService.getPrometheusMetrics();
      expect(prometheus).toContain('wagering_duplicate_requests_total{source="http_engine"} 2');
      expect(prometheus).toContain('wagering_duplicate_requests_total{source="sqs_inbox"} 1');
    });
  });

  describe('Retries Metric', () => {
    it('should record retries across components', () => {
      metricsService.recordRetry('pending_reference');
      metricsService.recordRetry('pending_reference');
      metricsService.recordRetry('sqs_consumer');
      metricsService.recordRetry('outbox_publisher');

      const json = metricsService.getJsonMetrics();
      expect(json.wagering_retries_total['pending_reference']).toBe(2);
      expect(json.wagering_retries_total['sqs_consumer']).toBe(1);
      expect(json.wagering_retries_total['outbox_publisher']).toBe(1);

      const prometheus = metricsService.getPrometheusMetrics();
      expect(prometheus).toContain('wagering_retries_total{component="pending_reference"} 2');
      expect(prometheus).toContain('wagering_retries_total{component="sqs_consumer"} 1');
      expect(prometheus).toContain('wagering_retries_total{component="outbox_publisher"} 1');
    });
  });

  describe('DLQ Messages Metric', () => {
    it('should record DLQ messages by queue name', () => {
      metricsService.recordDlqMessage('http://localhost:4566/000000000000/wager-transactions-dlq.fifo');

      const json = metricsService.getJsonMetrics();
      expect(json.wagering_dlq_messages_total['wager-transactions-dlq.fifo']).toBe(1);

      const prometheus = metricsService.getPrometheusMetrics();
      expect(prometheus).toContain('wagering_dlq_messages_total{queue="wager-transactions-dlq.fifo"} 1');
    });
  });

  describe('Lock Conflicts Metric', () => {
    it('should record lock conflicts', () => {
      metricsService.recordLockConflict('wallet_lock');
      metricsService.recordLockConflict('wallet_lock');

      const json = metricsService.getJsonMetrics();
      expect(json.wagering_lock_conflicts_total['wallet_lock']).toBe(2);

      const prometheus = metricsService.getPrometheusMetrics();
      expect(prometheus).toContain('wagering_lock_conflicts_total{resource="wallet_lock"} 2');
    });
  });

  describe('Outbox Lag Metric', () => {
    it('should set and export outbox lag count gauge', () => {
      metricsService.setOutboxLag(42);

      const json = metricsService.getJsonMetrics();
      expect(json.wagering_outbox_lag_count).toBe(42);

      const prometheus = metricsService.getPrometheusMetrics();
      expect(prometheus).toContain('wagering_outbox_lag_count 42');
    });
  });

  describe('Reconciliation Divergence Metric', () => {
    it('should record financial reconciliation discrepancies', () => {
      metricsService.recordReconciliationDivergence();
      metricsService.recordReconciliationDivergence();

      const json = metricsService.getJsonMetrics();
      expect(json.wagering_reconciliation_divergence_total).toBe(2);

      const prometheus = metricsService.getPrometheusMetrics();
      expect(prometheus).toContain('wagering_reconciliation_divergence_total 2');
    });
  });

  describe('Processing Duration and Quantiles', () => {
    it('should accurately compute count, sum, p50, p90, and p99 quantiles', () => {
      for (let i = 1; i <= 100; i++) {
        metricsService.recordProcessingDuration('process_transaction', i);
      }

      const q = metricsService.getLatencyQuantiles('process_transaction');
      expect(q.count).toBe(100);
      expect(q.sumMs).toBe(5050);
      expect(q.avgMs).toBe(50.5);
      expect(q.p50Ms).toBe(51);
      expect(q.p90Ms).toBe(91);
      expect(q.p99Ms).toBe(100);

      const prometheus = metricsService.getPrometheusMetrics();
      expect(prometheus).toContain('wagering_processing_duration_ms{operation="process_transaction",quantile="0.5"} 51');
      expect(prometheus).toContain('wagering_processing_duration_ms{operation="process_transaction",quantile="0.9"} 91');
      expect(prometheus).toContain('wagering_processing_duration_ms{operation="process_transaction",quantile="0.99"} 100');
      expect(prometheus).toContain('wagering_processing_duration_ms_count{operation="process_transaction"} 100');
      expect(prometheus).toContain('wagering_processing_duration_ms_sum{operation="process_transaction"} 5050');
    });
  });

  describe('Reset', () => {
    it('should clear all recorded metrics on reset', () => {
      metricsService.recordTransaction('PROCESSED', 'BET', 'p1');
      metricsService.recordDuplicateRequest();
      metricsService.setOutboxLag(10);
      metricsService.recordReconciliationDivergence();

      metricsService.reset();

      const json = metricsService.getJsonMetrics();
      expect(Object.keys(json.wagering_transactions_total).length).toBe(0);
      expect(json.wagering_outbox_lag_count).toBe(0);
      expect(json.wagering_reconciliation_divergence_total).toBe(0);
    });
  });
});
