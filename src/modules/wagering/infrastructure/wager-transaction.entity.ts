import { Entity, PrimaryKey, Property, Unique, Check, Index } from '@mikro-orm/core';
import { WagerTransaction } from '../domain/wager-transaction.entity';
import { WagerTransactionKind } from '../domain/wager-transaction-kind.enum';
import { WagerTransactionStatus } from '../domain/wager-transaction-status.enum';
import { FailureCode } from '../domain/failure-code.enum';
import { Money } from '../../../shared/domain/value-objects/money.value-object';

@Entity({ tableName: 'wager_transactions' })
@Unique({ properties: ['providerId', 'idempotencyKey'], name: 'uq_wager_transactions_provider_idempotency' })
@Unique({ properties: ['providerId', 'externalTransactionId'], name: 'uq_wager_transactions_provider_external_id' })
@Check({ expression: 'amount >= 0', name: 'chk_wager_transactions_amount_non_negative' })
@Index({ properties: ['walletId', 'createdAt'], name: 'idx_wager_tx_wallet_created' })
@Index({ properties: ['roundId'], name: 'idx_wager_tx_round_id' })
@Index({ properties: ['providerId', 'externalTransactionId'], name: 'idx_wager_tx_ref_lookup' })
export class WagerTransactionEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'string', length: 64 })
  providerId!: string;

  @Property({ type: 'string', length: 128 })
  externalTransactionId!: string;

  @Property({ type: 'string', length: 255 })
  idempotencyKey!: string;

  @Property({ type: 'string', length: 64 })
  payloadHash!: string;

  @Property({ type: 'uuid' })
  walletId!: string;

  @Property({ type: 'uuid' })
  playerId!: string;

  @Property({ type: 'string', length: 128 })
  roundId!: string;

  @Property({ type: 'string', length: 128 })
  gameId!: string;

  @Property({ type: 'string', length: 32 })
  kind!: string;

  @Property({ type: 'decimal', precision: 18, scale: 2 })
  amount!: string;

  @Property({ type: 'string', length: 3 })
  currency!: string;

  @Property({ type: 'string', length: 128, nullable: true })
  referenceExternalTransactionId?: string;

  @Property({ type: 'uuid', nullable: true })
  referenceTransactionId?: string;

  @Property({ type: 'string', length: 32, default: 'PENDING' })
  status: string = 'PENDING';

  @Property({ type: 'string', length: 64, nullable: true })
  failureCode?: string;

  @Property({ type: 'timestamptz', nullable: true })
  processedAt?: Date;

  @Property({ type: 'int', default: 0 })
  retryCount: number = 0;

  @Property({ type: 'timestamptz', nullable: true })
  nextRetryAt?: Date;

  @Property({ type: 'timestamptz', defaultRaw: 'NOW()' })
  createdAt: Date = new Date();

  static toDomain(entity: WagerTransactionEntity): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: entity.id,
      providerId: entity.providerId,
      externalTransactionId: entity.externalTransactionId,
      idempotencyKey: entity.idempotencyKey,
      payloadHash: entity.payloadHash,
      walletId: entity.walletId,
      playerId: entity.playerId,
      roundId: entity.roundId,
      gameId: entity.gameId,
      kind: entity.kind as WagerTransactionKind,
      money: Money.from({ amount: entity.amount, currency: entity.currency }),
      referenceExternalTransactionId: entity.referenceExternalTransactionId,
      status: entity.status as WagerTransactionStatus,
      referenceTransactionId: entity.referenceTransactionId,
      failureCode: entity.failureCode as FailureCode | undefined,
      processedAt: entity.processedAt,
      retryCount: entity.retryCount,
      nextRetryAt: entity.nextRetryAt,
      createdAt: entity.createdAt,
    });
  }

  static fromDomain(tx: WagerTransaction): WagerTransactionEntity {
    const entity = new WagerTransactionEntity();
    entity.id = tx.id;
    entity.providerId = tx.providerId;
    entity.externalTransactionId = tx.externalTransactionId;
    entity.idempotencyKey = tx.idempotencyKey;
    entity.payloadHash = tx.payloadHash;
    entity.walletId = tx.walletId;
    entity.playerId = tx.playerId;
    entity.roundId = tx.roundId;
    entity.gameId = tx.gameId;
    entity.kind = tx.kind;
    entity.amount = tx.money.toString();
    entity.currency = tx.money.currency;
    entity.referenceExternalTransactionId = tx.referenceExternalTransactionId;
    entity.referenceTransactionId = tx.referenceTransactionId;
    entity.status = tx.status;
    entity.failureCode = tx.failureCode;
    entity.processedAt = tx.processedAt;
    entity.retryCount = tx.retryCount;
    entity.nextRetryAt = tx.nextRetryAt;
    entity.createdAt = tx.createdAt;
    return entity;
  }
}
