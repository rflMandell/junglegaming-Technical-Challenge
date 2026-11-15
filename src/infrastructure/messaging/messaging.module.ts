import { Module, Global, forwardRef } from '@nestjs/common';
import { SQS_CLIENT_TOKEN, createSqsClient } from './sqs.client';
import { WagerTransactionProducer } from './wager-transaction.producer';
import { WagerTransactionConsumer } from './wager-transaction.consumer';
import { WageringModule } from '../../modules/wagering/wagering.module';
import { EVENT_PUBLISHER_PORT } from '../../modules/messaging/application/ports/event-publisher.port';
import { EventPublisherAdapter } from '../../modules/messaging/infrastructure/event-publisher.adapter';
import { OUTBOX_REPOSITORY_PORT } from '../../modules/messaging/application/ports/outbox.repository.port';
import { OutboxRepository } from '../../modules/messaging/infrastructure/outbox.repository';
import { OutboxPublisherWorker } from '../../modules/messaging/infrastructure/outbox-publisher.worker';

@Global()
@Module({
  imports: [forwardRef(() => WageringModule)],
  providers: [
    {
      provide: SQS_CLIENT_TOKEN,
      useFactory: () => createSqsClient(),
    },
    WagerTransactionProducer,
    WagerTransactionConsumer,
    EventPublisherAdapter,
    {
      provide: EVENT_PUBLISHER_PORT,
      useExisting: EventPublisherAdapter,
    },
    OutboxRepository,
    {
      provide: OUTBOX_REPOSITORY_PORT,
      useClass: OutboxRepository,
    },
    OutboxPublisherWorker,
  ],
  exports: [
    SQS_CLIENT_TOKEN,
    WagerTransactionProducer,
    WagerTransactionConsumer,
    EVENT_PUBLISHER_PORT,
    OUTBOX_REPOSITORY_PORT,
    EventPublisherAdapter,
    OutboxRepository,
    OutboxPublisherWorker,
  ],
})
export class MessagingModule {}
