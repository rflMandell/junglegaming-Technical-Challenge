import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { v7 as uuidv7 } from 'uuid';
import { DatabaseModule } from './infrastructure/database/database.module';
import { MessagingModule } from './infrastructure/messaging/messaging.module';
import { HealthModule } from './modules/health/health.module';
import { MetricsModule } from './modules/metrics/metrics.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { LedgerModule } from './modules/ledger/ledger.module';
import { WageringModule } from './modules/wagering/wagering.module';
import { ReconciliationModule } from './modules/reconciliation/reconciliation.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '.env.example'],
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL || 'info',
        transport:
          process.env.NODE_ENV !== 'production'
            ? {
                target: 'pino-pretty',
                options: {
                  colorize: true,
                  singleLine: true,
                },
              }
            : undefined,
        redact: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.body.creditCard',
          'req.body.password',
          'req.body.secret',
          'req.body.token',
        ],
        genReqId: (req: any) =>
          (req.headers['x-correlation-id'] as string) || (req.correlationId as string) || uuidv7(),
        customProps: (req: any) => ({
          correlationId: req.headers?.['x-correlation-id'] || req.correlationId,
          providerId: req.headers?.['x-provider-id'] || req.providerId,
        }),
      },
    }),
    DatabaseModule,
    MessagingModule,
    HealthModule,
    MetricsModule,
    WalletModule,
    LedgerModule,
    WageringModule,
    ReconciliationModule,
  ],
})
export class AppModule {}
