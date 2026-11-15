import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { PostgresHealthIndicator } from './indicators/postgres.health';
import { SqsHealthIndicator } from './indicators/sqs.health';

@Module({
  controllers: [HealthController],
  providers: [PostgresHealthIndicator, SqsHealthIndicator],
})
export class HealthModule {}
