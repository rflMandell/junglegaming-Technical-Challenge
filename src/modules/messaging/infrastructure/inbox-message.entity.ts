import { Entity, PrimaryKey, Property, Index } from '@mikro-orm/core';
import { InboxMessage } from '../domain/inbox-message.entity';

@Entity({ tableName: 'inbox_messages' })
@Index({ properties: ['consumerName', 'processedAt'], name: 'idx_inbox_messages_processed' })
export class InboxMessageEntity {
  @PrimaryKey({ type: 'string', length: 128 })
  consumerName!: string;

  @PrimaryKey({ type: 'string', length: 255 })
  messageId!: string;

  @Property({ type: 'string', length: 64 })
  payloadHash!: string;

  @Property({ type: 'timestamptz', defaultRaw: 'NOW()' })
  receivedAt: Date = new Date();

  @Property({ type: 'timestamptz', nullable: true })
  processedAt?: Date;

  static toDomain(entity: InboxMessageEntity): InboxMessage {
    return InboxMessage.rehydrate({
      consumerName: entity.consumerName,
      messageId: entity.messageId,
      payloadHash: entity.payloadHash,
      receivedAt: entity.receivedAt,
      processedAt: entity.processedAt,
    });
  }

  static fromDomain(inbox: InboxMessage): InboxMessageEntity {
    const entity = new InboxMessageEntity();
    entity.consumerName = inbox.consumerName;
    entity.messageId = inbox.messageId;
    entity.payloadHash = inbox.payloadHash;
    entity.receivedAt = inbox.receivedAt;
    entity.processedAt = inbox.processedAt;
    return entity;
  }
}
