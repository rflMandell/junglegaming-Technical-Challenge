import { describe, it, expect } from 'bun:test';
import { InboxMessage } from '../../src/modules/messaging/domain/inbox-message.entity';
import { OutboxMessage } from '../../src/modules/messaging/domain/outbox-message.entity';
import { IntegrationEvent } from '../../src/shared/domain/events/integration-event';

class TestIntegrationEvent extends IntegrationEvent<{ testProp: string }> {
  readonly eventType = 'TestIntegrationEvent';
  readonly version = 1;

  constructor(aggregateId: string, testProp: string) {
    super({
      eventId: 'evt-100',
      aggregateId,
      correlationId: 'corr-100',
      occurredAt: new Date(),
      data: { testProp },
    });
  }
}

describe('Inbox & Outbox Domain Entities (Unit)', () => {
  describe('InboxMessage', () => {
    it('should receive an inbox message in unprocessed state', () => {
      const inbox = InboxMessage.receive({
        messageId: 'msg-1',
        consumerName: 'wager-consumer',
        payloadHash: 'hash-123',
      });

      expect(inbox.messageId).toBe('msg-1');
      expect(inbox.consumerName).toBe('wager-consumer');
      expect(inbox.isProcessed()).toBe(false);
      expect(inbox.processedAt).toBeUndefined();
    });

    it('should mark message as processed', () => {
      const inbox = InboxMessage.receive({
        messageId: 'msg-1',
        consumerName: 'wager-consumer',
        payloadHash: 'hash-123',
      });

      const processedAt = new Date();
      inbox.markProcessed(processedAt);

      expect(inbox.isProcessed()).toBe(true);
      expect(inbox.processedAt).toBe(processedAt);
    });

    it('should rehydrate from state', () => {
      const processedAt = new Date();
      const rehydrated = InboxMessage.rehydrate({
        messageId: 'msg-1',
        consumerName: 'wager-consumer',
        payloadHash: 'hash-123',
        receivedAt: new Date('2026-01-01'),
        processedAt,
      });

      expect(rehydrated.isProcessed()).toBe(true);
      expect(rehydrated.processedAt).toBe(processedAt);
    });
  });

  describe('OutboxMessage', () => {
    it('should enqueue integration event as pending outbox message', () => {
      const event = new TestIntegrationEvent('agg-1', 'hello');
      const outbox = OutboxMessage.enqueue(event);

      expect(outbox.id).toBe('evt-100');
      expect(outbox.aggregateId).toBe('agg-1');
      expect(outbox.eventType).toBe('TestIntegrationEvent');
      expect(outbox.isPending()).toBe(true);
      expect(outbox.isDue()).toBe(true);
      expect(outbox.attempts).toBe(0);
    });

    it('should mark outbox message as published', () => {
      const event = new TestIntegrationEvent('agg-1', 'hello');
      const outbox = OutboxMessage.enqueue(event);

      const publishedAt = new Date();
      outbox.markPublished(publishedAt);

      expect(outbox.isPending()).toBe(false);
      expect(outbox.isDue()).toBe(false);
      expect(outbox.publishedAt).toBe(publishedAt);
    });

    it('should schedule retry with backoff delay', () => {
      const event = new TestIntegrationEvent('agg-1', 'hello');
      const outbox = OutboxMessage.enqueue(event);

      const now = new Date();
      outbox.scheduleRetry(now, 10); // 10 seconds delay

      expect(outbox.attempts).toBe(1);
      expect(outbox.nextAttemptAt).toBeDefined();
      expect(outbox.nextAttemptAt?.getTime()).toBe(now.getTime() + 10000);
      expect(outbox.isDue(now)).toBe(false);
      expect(outbox.isDue(new Date(now.getTime() + 15000))).toBe(true);
    });
  });
});
