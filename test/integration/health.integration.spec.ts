import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { HealthController } from '../../src/modules/health/health.controller';

describe('Health Checks (Integration with Real PostgreSQL & SQS)', () => {
  let app: INestApplication;
  let healthController: HealthController;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    healthController = app.get<HealthController>(HealthController);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('GET /health/live should return status ok', () => {
    const response = healthController.live();
    expect(response.status).toBe('ok');
    expect(response.uptime).toBeGreaterThanOrEqual(0);
  });

  it('GET /health/ready should verify real PostgreSQL and LocalStack SQS are reachable', async () => {
    const response = await healthController.ready();
    expect(response.status).toBe('ok');
    expect(response.details.postgres.status).toBe('up');
    expect(response.details.sqs.status).toBe('up');
  });
});
