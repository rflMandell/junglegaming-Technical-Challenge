import { Injectable, Inject } from '@nestjs/common';
import { HealthIndicatorResult } from '@nestjs/terminus';
import { SQSClient, ListQueuesCommand } from '@aws-sdk/client-sqs';
import { SQS_CLIENT_TOKEN } from '../../../infrastructure/messaging/sqs.client';

@Injectable()
export class SqsHealthIndicator {
  constructor(
    @Inject(SQS_CLIENT_TOKEN)
    private readonly sqsClient: SQSClient,
  ) {}

  async isHealthy(key = 'sqs'): Promise<HealthIndicatorResult> {
    try {
      const response = await this.sqsClient.send(new ListQueuesCommand({ MaxResults: 1 }));
      return {
        [key]: {
          status: 'up',
          queuesFound: response.QueueUrls ? response.QueueUrls.length : 0,
        },
      };
    } catch (error) {
      return {
        [key]: {
          status: 'down',
          message: error instanceof Error ? error.message : 'Unknown SQS error',
        },
      };
    }
  }
}
