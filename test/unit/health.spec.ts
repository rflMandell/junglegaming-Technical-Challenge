import { describe, it, expect } from 'bun:test';
import { HealthController } from '../../src/modules/health/health.controller';
import { PostgresHealthIndicator } from '../../src/modules/health/indicators/postgres.health';
import { SqsHealthIndicator } from '../../src/modules/health/indicators/sqs.health';

describe('HealthController (Unit)', () => {
  it('should return live status ok with uptime', () => {
    const mockPostgres = {} as PostgresHealthIndicator;
    const mockSqs = {} as SqsHealthIndicator;
    const controller = new HealthController(mockPostgres, mockSqs);

    const result = controller.live();
    expect(result.status).toBe('ok');
    expect(result.uptime).toBeGreaterThanOrEqual(0);
    expect(result.timestamp).toBeDefined();
  });

  it('should return ready status ok when postgres and sqs are healthy', async () => {
    const mockPostgres = {
      isHealthy: async () => ({ postgres: { status: 'up' } }),
    } as unknown as PostgresHealthIndicator;

    const mockSqs = {
      isHealthy: async () => ({ sqs: { status: 'up', queuesFound: 2 } }),
    } as unknown as SqsHealthIndicator;

    const controller = new HealthController(mockPostgres, mockSqs);
    const result = await controller.ready();

    expect(result.status).toBe('ok');
    expect(result.details.postgres.status).toBe('up');
    expect(result.details.sqs.status).toBe('up');
  });

  it('should throw ServiceUnavailableException when a dependency is down', async () => {
    const mockPostgres = {
      isHealthy: async () => ({ postgres: { status: 'down', message: 'Connection refused' } }),
    } as unknown as PostgresHealthIndicator;

    const mockSqs = {
      isHealthy: async () => ({ sqs: { status: 'up', queuesFound: 2 } }),
    } as unknown as SqsHealthIndicator;

    const controller = new HealthController(mockPostgres, mockSqs);

    expect(controller.ready()).rejects.toThrow();
  });
});
