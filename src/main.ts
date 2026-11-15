import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { CorrelationIdInterceptor } from './shared/presentation/interceptors/correlation-id.interceptor';
import { GlobalHttpExceptionFilter } from './shared/presentation/filters/http-exception.filter';
import { ProviderAuthGuard } from './shared/presentation/guards/provider-auth.guard';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });

  const logger = app.get(Logger);
  app.useLogger(logger);

  // Global Interceptors, Filters, and Pipes
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

  app.enableShutdownHooks();

  // Swagger / OpenAPI documentation
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Distributed Wagering Processor API')
    .setDescription(
      'High-throughput distributed financial wagering service with persistent idempotency, transactional outbox, and ledger consistency.',
    )
    .setVersion('1.0.0')
    .addTag('Wallets', 'Wallet creation and balance querying')
    .addTag('Wagering', 'Real-time wagering transaction processing')
    .addTag('Ledger', 'Audit ledger and stable cursor pagination')
    .addTag('Reconciliation', 'Financial consistency verification')
    .addTag('Health', 'Liveness and readiness probes')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  const port = Number(process.env.PORT) || 3000;
  await app.listen(port);

  logger.log(`🚀 Distributed Wagering Processor running on port ${port}`);
  logger.log(`📖 Swagger API documentation available at: http://localhost:${port}/api/docs`);
}

bootstrap().catch((err) => {
  console.error('Fatal error during application bootstrap:', err);
  process.exit(1);
});
