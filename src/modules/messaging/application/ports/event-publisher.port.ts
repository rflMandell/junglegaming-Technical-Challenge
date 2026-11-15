export const EVENT_PUBLISHER_PORT = 'EVENT_PUBLISHER_PORT';

export interface IntegrationEventEnvelope<T = Record<string, unknown>> {
  eventId: string;
  eventType: string;
  version: number;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  data: T;
}

export interface EventPublisherPort {
  publish(event: IntegrationEventEnvelope): Promise<void>;
}
