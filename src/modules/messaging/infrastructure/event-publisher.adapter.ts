import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import {
  EventPublisherPort,
  IntegrationEventEnvelope,
} from '../application/ports/event-publisher.port';
import { SQS_CLIENT_TOKEN } from '../../../infrastructure/messaging/sqs.client';

export type EventSubscriber = (event: IntegrationEventEnvelope) => Promise<void> | void;

@Injectable()
export class EventPublisherAdapter implements EventPublisherPort {
  private readonly logger = new Logger(EventPublisherAdapter.name);
  private readonly subscribers = new Set<EventSubscriber>();
  private failureSimulationPredicate?: (event: IntegrationEventEnvelope) => boolean;

  constructor(
    @Optional()
    @Inject(SQS_CLIENT_TOKEN)
    private readonly sqsClient?: SQSClient,
  ) {}

  public subscribe(handler: EventSubscriber): () => void {
    this.subscribers.add(handler);
    return () => {
      this.subscribers.delete(handler);
    };
  }

  public simulateFailureFor(predicate?: (event: IntegrationEventEnvelope) => boolean): void {
    this.failureSimulationPredicate = predicate;
  }

  async publish(event: IntegrationEventEnvelope): Promise<void> {
    // Check if failure simulation is active
    if (this.failureSimulationPredicate && this.failureSimulationPredicate(event)) {
      this.logger.warn(
        `Simulated transient failure publishing event ${event.eventType} [eventId=${event.eventId}]`,
      );
      throw new Error(`Simulated transient failure publishing event ${event.eventType}`);
    }

    // 1. Dispatch to in-process subscribers
    for (const subscriber of this.subscribers) {
      try {
        await subscriber(event);
      } catch (subErr) {
        this.logger.error(`Error in event subscriber for ${event.eventType}`, subErr);
        throw subErr;
      }
    }

    // 2. Publish to SQS events queue if configured
    const eventsQueueUrl = process.env.SQS_EVENTS_QUEUE_URL;
    if (eventsQueueUrl && this.sqsClient) {
      const command = new SendMessageCommand({
        QueueUrl: eventsQueueUrl,
        MessageBody: JSON.stringify(event),
        MessageAttributes: {
          EventType: {
            DataType: 'String',
            StringValue: event.eventType,
          },
          CorrelationId: {
            DataType: 'String',
            StringValue: event.correlationId,
          },
          EventId: {
            DataType: 'String',
            StringValue: event.eventId,
          },
        },
      });
      await this.sqsClient.send(command);
    }

    this.logger.debug(
      `Published integration event: ${event.eventType} [eventId=${event.eventId}, aggregateId=${event.aggregateId}]`,
    );
  }
}
