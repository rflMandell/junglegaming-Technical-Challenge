import { Injectable, Inject, Logger } from '@nestjs/common';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { SQS_CLIENT_TOKEN } from './sqs.client';
import { ProcessWagerTransactionDto } from '../../modules/wagering/application/dtos/process-wager-transaction.dto';

export interface PublishWagerTransactionMessage {
  dto: ProcessWagerTransactionDto;
  idempotencyKey?: string;
  correlationId?: string;
}

@Injectable()
export class WagerTransactionProducer {
  private readonly logger = new Logger(WagerTransactionProducer.name);
  private queueUrl: string;

  constructor(
    @Inject(SQS_CLIENT_TOKEN)
    private readonly sqsClient: SQSClient,
  ) {
    this.queueUrl =
      process.env.SQS_WAGER_TRANSACTIONS_QUEUE_URL ||
      'http://localhost:4566/000000000000/wager-transactions.fifo';
  }

  public setQueueUrl(url: string): void {
    this.queueUrl = url;
  }

  public getQueueUrl(): string {
    return this.queueUrl;
  }

  async publish(message: PublishWagerTransactionMessage): Promise<string> {
    const correlationId = message.correlationId || uuidv7();
    const idempotencyKey =
      message.idempotencyKey ||
      `${message.dto.providerId}:${message.dto.externalTransactionId}`;

    const rawDedup = `${message.dto.providerId}:${idempotencyKey}`;
    const deduplicationId =
      rawDedup.length > 120
        ? createHash('sha256').update(rawDedup).digest('hex')
        : rawDedup;

    const payload = {
      dto: message.dto,
      idempotencyKey,
      correlationId,
    };

    const command = new SendMessageCommand({
      QueueUrl: this.queueUrl,
      MessageBody: JSON.stringify(payload),
      MessageGroupId: message.dto.walletId,
      MessageDeduplicationId: deduplicationId,
      MessageAttributes: {
        CorrelationId: {
          DataType: 'String',
          StringValue: correlationId,
        },
        ProviderId: {
          DataType: 'String',
          StringValue: message.dto.providerId,
        },
        IdempotencyKey: {
          DataType: 'String',
          StringValue: idempotencyKey,
        },
      },
    });

    const response = await this.sqsClient.send(command);
    this.logger.debug(
      `Published transaction to SQS [MessageId=${response.MessageId}, WalletId=${message.dto.walletId}]`,
    );

    return response.MessageId || '';
  }
}
