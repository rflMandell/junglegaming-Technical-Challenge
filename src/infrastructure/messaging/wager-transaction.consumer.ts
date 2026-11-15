import {
  Injectable,
  Inject,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  forwardRef,
} from '@nestjs/common';
import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
  SendMessageCommand,
  type Message,
} from '@aws-sdk/client-sqs';
import { SQS_CLIENT_TOKEN } from './sqs.client';
import { ProcessWagerTransactionUseCase } from '../../modules/wagering/application/use-cases/process-wager-transaction.use-case';
import { ProcessWagerTransactionResponseDto } from '../../modules/wagering/application/dtos/wager-transaction-response.dto';
import { ProcessWagerTransactionDto } from '../../modules/wagering/application/dtos/process-wager-transaction.dto';
import { classifyError, ErrorCategory } from './error-classification';

export interface WagerMessagePayload {
  dto: ProcessWagerTransactionDto;
  idempotencyKey?: string;
  correlationId?: string;
}

@Injectable()
export class WagerTransactionConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WagerTransactionConsumer.name);
  public readonly consumerName = 'wager-transactions-consumer';

  private queueUrl: string;
  private dlqUrl: string;
  private isRunning = false;
  private pollingPromise: Promise<void> | null = null;
  private activeProcessingCount = 0;
  private inFlightMessages = new Map<string, Message>();
  private abortController = new AbortController();

  private readonly maxReceiveCount: number = 5;
  private readonly baseBackoffSeconds: number = 2;

  constructor(
    @Inject(SQS_CLIENT_TOKEN)
    private readonly sqsClient: SQSClient,
    @Inject(forwardRef(() => ProcessWagerTransactionUseCase))
    private readonly processWagerUseCase: ProcessWagerTransactionUseCase,
  ) {
    this.queueUrl =
      process.env.SQS_WAGER_TRANSACTIONS_QUEUE_URL ||
      'http://localhost:4566/000000000000/wager-transactions.fifo';
    this.dlqUrl =
      process.env.SQS_WAGER_TRANSACTIONS_DLQ_URL ||
      'http://localhost:4566/000000000000/wager-transactions-dlq.fifo';
  }

  public setQueueUrl(url: string): void {
    this.queueUrl = url;
  }

  public setDlqUrl(url: string): void {
    this.dlqUrl = url;
  }

  async onModuleInit() {
    // Only auto-start background loop if explicitly enabled or in production
    // Tests can run pollOnce() deterministically
    const autoStart = process.env.SQS_CONSUMER_AUTO_START === 'true';
    if (autoStart) {
      this.start();
    }
  }

  async onModuleDestroy() {
    await this.stop();
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.abortController = new AbortController();
    this.logger.log(`Starting SQS consumer [Queue=${this.queueUrl}]`);
    this.pollingPromise = this.runPollingLoop();
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.logger.log('Gracefully stopping SQS consumer...');
    this.isRunning = false;
    this.abortController.abort();

    // Wait for polling loop to finish
    if (this.pollingPromise) {
      await Promise.race([
        this.pollingPromise,
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    }

    // Release visibility for any received messages that were not processed/committed
    if (this.inFlightMessages.size > 0) {
      this.logger.warn(
        `Returning visibility for ${this.inFlightMessages.size} uncompleted in-flight messages`,
      );
      for (const [receiptHandle] of this.inFlightMessages) {
        if (receiptHandle.startsWith('mock-')) continue;
        try {
          await this.sqsClient.send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: this.queueUrl,
              ReceiptHandle: receiptHandle,
              VisibilityTimeout: 0,
            }),
          );
        } catch (releaseErr: any) {
          if (releaseErr?.name !== 'ReceiptHandleIsInvalid') {
            this.logger.error('Failed to release message visibility during shutdown', releaseErr);
          }
        }
      }
      this.inFlightMessages.clear();
    }

    this.logger.log('SQS consumer stopped cleanly.');
  }

  private async runPollingLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        await this.pollOnce(2);
      } catch (err: any) {
        if (!this.isRunning || err?.name === 'AbortError') {
          break;
        }
        this.logger.error('Error during SQS polling loop iteration', err);
        // Wait briefly before retrying to avoid hot-looping on failures
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }

  public async pollOnce(waitTimeSeconds = 5): Promise<number> {
    if (!this.isRunning && this.abortController.signal.aborted) {
      return 0;
    }

    const command = new ReceiveMessageCommand({
      QueueUrl: this.queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: waitTimeSeconds,
      AttributeNames: ['All'],
      MessageAttributeNames: ['All'],
    });

    let response;
    try {
      response = await this.sqsClient.send(command, {
        abortSignal: this.abortController.signal,
      });
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        return 0;
      }
      throw err;
    }

    const messages = response.Messages || [];

    if (messages.length === 0) {
      return 0;
    }

    this.logger.debug(`Received ${messages.length} message(s) from SQS`);

    for (const msg of messages) {
      if (msg.ReceiptHandle) {
        this.inFlightMessages.set(msg.ReceiptHandle, msg);
      }

      this.activeProcessingCount++;
      try {
        await this.processSingleMessage(msg);
      } finally {
        this.activeProcessingCount--;
        if (msg.ReceiptHandle) {
          this.inFlightMessages.delete(msg.ReceiptHandle);
        }
      }
    }

    return messages.length;
  }

  public async processSingleMessage(
    message: Message,
  ): Promise<ProcessWagerTransactionResponseDto | null> {
    const receiptHandle = message.ReceiptHandle;
    const messageId = message.MessageId;

    if (!receiptHandle || !messageId) {
      this.logger.error('Message received without MessageId or ReceiptHandle');
      return null;
    }

    let payload: WagerMessagePayload;
    try {
      payload = JSON.parse(message.Body || '{}');
      if (!payload.dto || !payload.dto.walletId || !payload.dto.kind) {
        throw new Error('Message body missing mandatory ProcessWagerTransactionDto fields');
      }
    } catch (parseError) {
      this.logger.error(
        `Permanent error: Invalid message payload for MessageId=${messageId}`,
        parseError,
      );
      await this.forwardToDlq(message, 'MALFORMED_PAYLOAD');
      await this.deleteMessage(receiptHandle);
      return null;
    }

    try {
      // Execute transaction with persistent Inbox deduplication
      // Commit happens inside executeTransactionalWager
      const result = await this.processWagerUseCase.execute(payload.dto, {
        idempotencyKey: payload.idempotencyKey,
        correlationId: payload.correlationId,
        inbox: {
          consumerName: this.consumerName,
          messageId,
        },
      });

      // ACK: Delete message ONLY AFTER successful database commit
      await this.deleteMessage(receiptHandle);

      this.logger.debug(
        `Message ${messageId} processed and ACKed successfully [TxId=${result.transactionId}, Replay=${result.idempotentReplay}]`,
      );

      return result;
    } catch (error) {
      const category = classifyError(error);
      this.logger.warn(
        `Message ${messageId} processing failed with category=${category}: ${(error as Error).message}`,
      );

      if (category === ErrorCategory.Business) {
        // Business rejection was handled by domain/use-case, or unrecoverable domain conflict
        // ACK to avoid toxic endless retry loops
        await this.deleteMessage(receiptHandle);
        return null;
      }

      if (category === ErrorCategory.Permanent) {
        // Route permanent invalid payload directly to DLQ
        await this.forwardToDlq(message, (error as Error).message);
        await this.deleteMessage(receiptHandle);
        return null;
      }

      // Category TRANSIENT: Retry with exponential backoff
      const receiveCount = Number(message.Attributes?.ApproximateReceiveCount || 1);
      if (receiveCount >= this.maxReceiveCount) {
        this.logger.error(
          `Message ${messageId} reached maxReceiveCount (${receiveCount}/${this.maxReceiveCount}). Moving to DLQ.`,
        );
        await this.forwardToDlq(message, `EXCEEDED_MAX_RECEIVE_COUNT: ${(error as Error).message}`);
        await this.deleteMessage(receiptHandle);
        return null;
      }

      const backoffSeconds = Math.min(300, Math.pow(2, receiveCount) * this.baseBackoffSeconds);
      this.logger.log(
        `Scheduling backoff retry for message ${messageId} (attempt ${receiveCount}) with visibility ${backoffSeconds}s`,
      );

      try {
        if (!receiptHandle.startsWith('mock-')) {
          await this.sqsClient.send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: this.queueUrl,
              ReceiptHandle: receiptHandle,
              VisibilityTimeout: backoffSeconds,
            }),
          );
        }
      } catch (visErr: any) {
        if (visErr?.name !== 'ReceiptHandleIsInvalid') {
          this.logger.error(`Failed to change message visibility for ${messageId}`, visErr);
        }
      }

      throw error;
    }
  }

  private async deleteMessage(receiptHandle: string): Promise<void> {
    if (receiptHandle.startsWith('mock-')) {
      return;
    }

    try {
      await this.sqsClient.send(
        new DeleteMessageCommand({
          QueueUrl: this.queueUrl,
          ReceiptHandle: receiptHandle,
        }),
      );
    } catch (err: any) {
      if (err?.name === 'ReceiptHandleIsInvalid') {
        this.logger.warn(`Receipt handle was already invalid or deleted: ${receiptHandle}`);
        return;
      }
      this.logger.error('Failed to delete message from SQS (ACK failed)', err);
      throw err;
    }
  }

  private async forwardToDlq(message: Message, reason: string): Promise<void> {
    try {
      const dlqMessageGroupId =
        message.Attributes?.MessageGroupId || 'unassigned-group';
      const dlqDeduplicationId =
        message.Attributes?.MessageDeduplicationId || message.MessageId;

      await this.sqsClient.send(
        new SendMessageCommand({
          QueueUrl: this.dlqUrl,
          MessageBody: message.Body,
          MessageGroupId: dlqMessageGroupId,
          MessageDeduplicationId: dlqDeduplicationId,
          MessageAttributes: {
            ...message.MessageAttributes,
            DlqReason: {
              DataType: 'String',
              StringValue: reason.slice(0, 255),
            },
            OriginalMessageId: {
              DataType: 'String',
              StringValue: message.MessageId || '',
            },
          },
        }),
      );
      this.logger.warn(`Forwarded message ${message.MessageId} to DLQ. Reason: ${reason}`);
    } catch (dlqErr) {
      this.logger.error(`Failed to forward message ${message.MessageId} to DLQ`, dlqErr);
    }
  }
}
