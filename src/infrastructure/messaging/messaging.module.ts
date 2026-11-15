import { Module, Global } from '@nestjs/common';
import { SQS_CLIENT_TOKEN, createSqsClient } from './sqs.client';

@Global()
@Module({
  providers: [
    {
      provide: SQS_CLIENT_TOKEN,
      useFactory: () => createSqsClient(),
    },
  ],
  exports: [SQS_CLIENT_TOKEN],
})
export class MessagingModule {}
