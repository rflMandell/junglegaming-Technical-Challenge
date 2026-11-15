import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { PostgresHealthIndicator } from './indicators/postgres.health';
import { SqsHealthIndicator } from './indicators/sqs.health';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly postgresIndicator: PostgresHealthIndicator,
    private readonly sqsIndicator: SqsHealthIndicator,
  ) {}

  @Get('live')
  @ApiOperation({ summary: 'Liveness probe to check if the process is up' })
  @ApiResponse({ status: 200, description: 'Service is alive' })
  live() {
    return {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe to check if database and SQS dependencies are available' })
  @ApiResponse({ status: 200, description: 'All critical dependencies are healthy' })
  @ApiResponse({ status: 503, description: 'One or more dependencies are down' })
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
