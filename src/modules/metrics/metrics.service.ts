import { Injectable } from '@nestjs/common';

export interface LatencyQuantiles {
  count: number;
  sumMs: number;
  avgMs: number;
  p50Ms: number;
  p90Ms: number;
  p99Ms: number;
}

@Injectable()
export class MetricsService {
  // Counters
  private readonly transactions = new Map<string, number>();
  private readonly duplicateRequests = new Map<string, number>();
  private readonly retries = new Map<string, number>();
  private readonly dlqMessages = new Map<string, number>();
  private readonly lockConflicts = new Map<string, number>();
  private reconciliationDivergences = 0;

  // Gauges
  private outboxLag = 0;

  // Latencies (stored observations per operation, sliding window capped at 1000)
  private readonly latencies = new Map<string, number[]>();

  // --- Recording Methods ---

  public recordTransaction(status: string, kind: string, providerId: string): void {
    const key = `${status}:${kind}:${providerId}`;
    this.transactions.set(key, (this.transactions.get(key) || 0) + 1);
  }

  public recordDuplicateRequest(source: string = 'default'): void {
    this.duplicateRequests.set(source, (this.duplicateRequests.get(source) || 0) + 1);
  }

  public recordRetry(component: string): void {
    this.retries.set(component, (this.retries.get(component) || 0) + 1);
  }

  public recordDlqMessage(queue: string): void {
    const queueName = queue.split('/').pop() || queue;
    this.dlqMessages.set(queueName, (this.dlqMessages.get(queueName) || 0) + 1);
  }

  public recordLockConflict(resource: string = 'wallet_lock'): void {
    this.lockConflicts.set(resource, (this.lockConflicts.get(resource) || 0) + 1);
  }

  public setOutboxLag(count: number): void {
    this.outboxLag = Math.max(0, count);
  }

  public recordProcessingDuration(operation: string, durationMs: number): void {
    let list = this.latencies.get(operation);
    if (!list) {
      list = [];
      this.latencies.set(operation, list);
    }
    list.push(durationMs);
    // Keep bounded sliding window of 1000 items
    if (list.length > 1000) {
      list.shift();
    }
  }

  public recordReconciliationDivergence(): void {
    this.reconciliationDivergences++;
  }

  // --- Calculation Helpers ---

  public getLatencyQuantiles(operation: string): LatencyQuantiles {
    const list = this.latencies.get(operation) || [];
    if (list.length === 0) {
      return { count: 0, sumMs: 0, avgMs: 0, p50Ms: 0, p90Ms: 0, p99Ms: 0 };
    }

    const sorted = [...list].sort((a, b) => a - b);
    const count = sorted.length;
    const sumMs = sorted.reduce((acc, val) => acc + val, 0);
    const avgMs = Number((sumMs / count).toFixed(2));

    const p50Index = Math.min(Math.floor(count * 0.5), count - 1);
    const p90Index = Math.min(Math.floor(count * 0.9), count - 1);
    const p99Index = Math.min(Math.floor(count * 0.99), count - 1);

    return {
      count,
      sumMs: Number(sumMs.toFixed(2)),
      avgMs,
      p50Ms: Number(sorted[p50Index].toFixed(2)),
      p90Ms: Number(sorted[p90Index].toFixed(2)),
      p99Ms: Number(sorted[p99Index].toFixed(2)),
    };
  }

  // --- Export Methods ---

  public getJsonMetrics(): Record<string, any> {
    const txObj: Record<string, number> = {};
    for (const [key, count] of this.transactions.entries()) {
      txObj[key] = count;
    }

    const dupObj: Record<string, number> = {};
    for (const [key, count] of this.duplicateRequests.entries()) {
      dupObj[key] = count;
    }

    const retriesObj: Record<string, number> = {};
    for (const [key, count] of this.retries.entries()) {
      retriesObj[key] = count;
    }

    const dlqObj: Record<string, number> = {};
    for (const [key, count] of this.dlqMessages.entries()) {
      dlqObj[key] = count;
    }

    const lockObj: Record<string, number> = {};
    for (const [key, count] of this.lockConflicts.entries()) {
      lockObj[key] = count;
    }

    const latenciesObj: Record<string, LatencyQuantiles> = {};
    for (const op of this.latencies.keys()) {
      latenciesObj[op] = this.getLatencyQuantiles(op);
    }

    return {
      wagering_transactions_total: txObj,
      wagering_duplicate_requests_total: dupObj,
      wagering_retries_total: retriesObj,
      wagering_dlq_messages_total: dlqObj,
      wagering_lock_conflicts_total: lockObj,
      wagering_outbox_lag_count: this.outboxLag,
      wagering_reconciliation_divergence_total: this.reconciliationDivergences,
      wagering_processing_duration_ms: latenciesObj,
    };
  }

  public getPrometheusMetrics(): string {
    const lines: string[] = [];

    // 1. Transactions by status, kind, provider
    lines.push('# HELP wagering_transactions_total Total number of wagering transactions by status, kind, and provider');
    lines.push('# TYPE wagering_transactions_total counter');
    if (this.transactions.size === 0) {
      lines.push('wagering_transactions_total 0');
    } else {
      for (const [key, count] of this.transactions.entries()) {
        const [status, kind, provider] = key.split(':');
        lines.push(`wagering_transactions_total{status="${status}",kind="${kind}",provider="${provider}"} ${count}`);
      }
    }

    // 2. Duplicate requests
    lines.push('# HELP wagering_duplicate_requests_total Total number of duplicate requests detected by idempotency');
    lines.push('# TYPE wagering_duplicate_requests_total counter');
    if (this.duplicateRequests.size === 0) {
      lines.push('wagering_duplicate_requests_total 0');
    } else {
      for (const [source, count] of this.duplicateRequests.entries()) {
        lines.push(`wagering_duplicate_requests_total{source="${source}"} ${count}`);
      }
    }

    // 3. Retries
    lines.push('# HELP wagering_retries_total Total retry attempts across workers and messaging components');
    lines.push('# TYPE wagering_retries_total counter');
    if (this.retries.size === 0) {
      lines.push('wagering_retries_total 0');
    } else {
      for (const [component, count] of this.retries.entries()) {
        lines.push(`wagering_retries_total{component="${component}"} ${count}`);
      }
    }

    // 4. DLQ messages
    lines.push('# HELP wagering_dlq_messages_total Total messages routed to Dead Letter Queue');
    lines.push('# TYPE wagering_dlq_messages_total counter');
    if (this.dlqMessages.size === 0) {
      lines.push('wagering_dlq_messages_total 0');
    } else {
      for (const [queue, count] of this.dlqMessages.entries()) {
        lines.push(`wagering_dlq_messages_total{queue="${queue}"} ${count}`);
      }
    }

    // 5. Lock conflicts
    lines.push('# HELP wagering_lock_conflicts_total Total database concurrency lock conflicts detected');
    lines.push('# TYPE wagering_lock_conflicts_total counter');
    if (this.lockConflicts.size === 0) {
      lines.push('wagering_lock_conflicts_total 0');
    } else {
      for (const [resource, count] of this.lockConflicts.entries()) {
        lines.push(`wagering_lock_conflicts_total{resource="${resource}"} ${count}`);
      }
    }

    // 6. Outbox lag
    lines.push('# HELP wagering_outbox_lag_count Pending outbox messages waiting to be published');
    lines.push('# TYPE wagering_outbox_lag_count gauge');
    lines.push(`wagering_outbox_lag_count ${this.outboxLag}`);

    // 7. Reconciliation divergences
    lines.push('# HELP wagering_reconciliation_divergence_total Total reconciliation discrepancies detected');
    lines.push('# TYPE wagering_reconciliation_divergence_total counter');
    lines.push(`wagering_reconciliation_divergence_total ${this.reconciliationDivergences}`);

    // 8. Processing Latencies
    lines.push('# HELP wagering_processing_duration_ms Processing latency summary in milliseconds');
    lines.push('# TYPE wagering_processing_duration_ms summary');
    if (this.latencies.size === 0) {
      lines.push('wagering_processing_duration_ms_count 0');
      lines.push('wagering_processing_duration_ms_sum 0');
    } else {
      for (const op of this.latencies.keys()) {
        const q = this.getLatencyQuantiles(op);
        lines.push(`wagering_processing_duration_ms{operation="${op}",quantile="0.5"} ${q.p50Ms}`);
        lines.push(`wagering_processing_duration_ms{operation="${op}",quantile="0.9"} ${q.p90Ms}`);
        lines.push(`wagering_processing_duration_ms{operation="${op}",quantile="0.99"} ${q.p99Ms}`);
        lines.push(`wagering_processing_duration_ms_sum{operation="${op}"} ${q.sumMs}`);
        lines.push(`wagering_processing_duration_ms_count{operation="${op}"} ${q.count}`);
      }
    }

    return lines.join('\n') + '\n';
  }

  public reset(): void {
    this.transactions.clear();
    this.duplicateRequests.clear();
    this.retries.clear();
    this.dlqMessages.clear();
    this.lockConflicts.clear();
    this.latencies.clear();
    this.outboxLag = 0;
    this.reconciliationDivergences = 0;
  }
}
