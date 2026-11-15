import { Module, Global, forwardRef } from '@nestjs/common';
import { SQS_CLIENT_TOKEN, createSqsClient } from './sqs.client';
import { WagerTransactionProducer } from './wager-transaction.producer';
import { WagerTransactionConsumer } from './wager-transaction.consumer';
import { WageringModule } from '../../modules/wagering/wagering.module';

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
  ],
  exports: [
    SQS_CLIENT_TOKEN,
    WagerTransactionProducer,
    WagerTransactionConsumer,
  ],
})
export class MessagingModule {}
