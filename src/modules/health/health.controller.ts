import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { PostgresHealthIndicator } from './indicators/postgres.health';
import { SqsHealthIndicator } from './indicators/sqs.health';

@Controller('health')
export class HealthController {
  constructor(
    private readonly postgresIndicator: PostgresHealthIndicator,
    private readonly sqsIndicator: SqsHealthIndicator,
  ) {}

  @Get('live')
  live() {
    return {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  async ready() {
    const [postgres, sqs] = await Promise.all([
      this.postgresIndicator.isHealthy('postgres'),
      this.sqsIndicator.isHealthy('sqs'),
    ]);

    const isPostgresUp = postgres.postgres.status === 'up';
    const isSqsUp = sqs.sqs.status === 'up';
    const isReady = isPostgresUp && isSqsUp;

    const result = {
      status: isReady ? 'ok' : 'error',
      info: {
        ...(isPostgresUp ? postgres : {}),
        ...(isSqsUp ? sqs : {}),
      },
      error: {
        ...(!isPostgresUp ? postgres : {}),
        ...(!isSqsUp ? sqs : {}),
      },
      details: {
        ...postgres,
        ...sqs,
      },
    };

    if (!isReady) {
      throw new ServiceUnavailableException(result);
    }

    return result;
  }
}
