import { Injectable, Inject } from '@nestjs/common';
import { EntityManager, LockMode } from '@mikro-orm/postgresql';
import { v7 as uuidv7 } from 'uuid';
import { ENTITY_MANAGER_TOKEN } from '../../../../infrastructure/database/database.module';
import { WagerTransactionEntity } from '../../infrastructure/wager-transaction.entity';
import { WalletEntity } from '../../../wallet/infrastructure/wallet.entity';
import { WalletLedgerEntryEntity } from '../../../ledger/infrastructure/wallet-ledger-entry.entity';
import { OutboxMessageEntity } from '../../../messaging/infrastructure/outbox-message.entity';
import { WagerTransactionStatus } from '../../domain/wager-transaction-status.enum';
import { FailureCode } from '../../domain/failure-code.enum';
import { LedgerDirection } from '../../../ledger/domain/ledger-direction.enum';
import { WagerTransactionValidatorService } from '../../domain/services/wager-transaction-validator.service';
import { WagerTransactionProcessed } from '../../domain/events/wager-transaction-processed.event';
import { WagerTransactionRejected } from '../../domain/events/wager-transaction-rejected.event';
import { WalletBalanceChanged } from '../../../wallet/domain/events/wallet-balance-changed.event';
import { IntegrationEvent } from '../../../../shared/domain/events/integration-event';

export interface ReprocessPendingReferenceOptions {
  transactionId: string;
  maxRetries?: number;
  ttlSeconds?: number;
  baseBackoffSeconds?: number;
  now?: Date;
}

export interface ReprocessResult {
  transactionId: string;
  status: WagerTransactionStatus;
  failureCode?: FailureCode;
  nextRetryAt?: Date;
  processed: boolean;
}

@Injectable()
export class ReprocessPendingReferenceUseCase {
  constructor(
    @Inject(ENTITY_MANAGER_TOKEN)
    private readonly em: EntityManager,
  ) {}

  async execute(options: ReprocessPendingReferenceOptions): Promise<ReprocessResult> {
    const maxRetries = options.maxRetries ?? 5;
    const ttlSeconds = options.ttlSeconds ?? 300;
    const baseBackoffSeconds = options.baseBackoffSeconds ?? 2;
    const now = options.now ?? new Date();

    return await this.em.transactional(async (em) => {
      // 1. Lock the target transaction row
      const txEntity = await em.findOne(
        WagerTransactionEntity,
        { id: options.transactionId },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );

      if (!txEntity) {
        return {
          transactionId: options.transactionId,
          status: WagerTransactionStatus.Failed,
          processed: false,
        };
      }

      // If already terminal or no longer PENDING_REFERENCE, skip
      if (txEntity.status !== WagerTransactionStatus.PendingReference) {
        return {
          transactionId: txEntity.id,
          status: txEntity.status as WagerTransactionStatus,
          failureCode: txEntity.failureCode as FailureCode | undefined,
          processed: false,
        };
      }

      const tx = WagerTransactionEntity.toDomain(txEntity);

      // 2. Check TTL and Max Retries exhaustion
      const ageSeconds = (now.getTime() - tx.createdAt.getTime()) / 1000;
      const isExhausted = tx.retryCount >= maxRetries || ageSeconds >= ttlSeconds;

      if (isExhausted) {
        tx.reject(FailureCode.ReferenceNotFound);
        const updatedEntity = WagerTransactionEntity.fromDomain(tx);
        await em.upsert(WagerTransactionEntity, updatedEntity);

        const event = WagerTransactionRejected.from(
          tx,
          `Pending reference resolution exhausted after ${tx.retryCount} retries (TTL: ${ttlSeconds}s)`,
        );
        this.persistOutboxEvent(em, event);
        await em.flush();

        return {
          transactionId: tx.id,
          status: WagerTransactionStatus.Rejected,
          failureCode: FailureCode.ReferenceNotFound,
          processed: true,
        };
      }

      // 3. Check if the referenced external transaction has arrived
      if (!tx.referenceExternalTransactionId) {
        tx.reject(FailureCode.InvalidPayload);
        const updatedEntity = WagerTransactionEntity.fromDomain(tx);
        await em.upsert(WagerTransactionEntity, updatedEntity);
        await em.flush();
        return {
          transactionId: tx.id,
          status: WagerTransactionStatus.Rejected,
          failureCode: FailureCode.InvalidPayload,
          processed: true,
        };
      }

      const refEntity = await em.findOne(WagerTransactionEntity, {
        providerId: tx.providerId,
        externalTransactionId: tx.referenceExternalTransactionId,
      });

      // 4. Reference transaction still not available -> schedule backoff retry
      if (!refEntity) {
        const delaySeconds = Math.min(300, Math.pow(2, tx.retryCount) * baseBackoffSeconds);
        const nextRetryAt = new Date(now.getTime() + delaySeconds * 1000);
        tx.markPendingReference(nextRetryAt);

        const updatedEntity = WagerTransactionEntity.fromDomain(tx);
        await em.upsert(WagerTransactionEntity, updatedEntity);
        await em.flush();

        return {
          transactionId: tx.id,
          status: WagerTransactionStatus.PendingReference,
          nextRetryAt,
          processed: false,
        };
      }

      // 5. Reference transaction found -> Lock wallet and validate reference rules
      const walletEntity = await em.findOne(
        WalletEntity,
        { id: tx.walletId },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );

      if (!walletEntity) {
        tx.reject(FailureCode.ReferenceMismatch);
        const updatedEntity = WagerTransactionEntity.fromDomain(tx);
        await em.upsert(WagerTransactionEntity, updatedEntity);
        await em.flush();
        return {
          transactionId: tx.id,
          status: WagerTransactionStatus.Rejected,
          failureCode: FailureCode.ReferenceMismatch,
          processed: true,
        };
      }

      const wallet = WalletEntity.toDomain(walletEntity);
      const reference = WagerTransactionEntity.toDomain(refEntity);

      const existingReversalEntities = await em.find(WagerTransactionEntity, {
        providerId: tx.providerId,
        referenceExternalTransactionId: tx.referenceExternalTransactionId,
      });
      const existingReversals = existingReversalEntities.map((e) =>
        WagerTransactionEntity.toDomain(e),
      );

      const validation = WagerTransactionValidatorService.validateReference(
        tx,
        reference,
        wallet,
        existingReversals,
      );

      if (!validation.valid) {
        tx.reject(validation.failureCode);
        const updatedEntity = WagerTransactionEntity.fromDomain(tx);
        await em.upsert(WagerTransactionEntity, updatedEntity);

        const event = WagerTransactionRejected.from(tx, validation.reason);
        this.persistOutboxEvent(em, event);
        await em.flush();

        return {
          transactionId: tx.id,
          status: WagerTransactionStatus.Rejected,
          failureCode: validation.failureCode,
          processed: true,
        };
      }

      // 6. Validation passed -> Mutate wallet and record ledger entry
      const entryId = uuidv7();
      const direction = tx.ledgerDirectionFor(reference);

      let ledgerEntry;
      if (direction === LedgerDirection.Debit) {
        const debitResult = wallet.debit(tx.money, tx.id, entryId);
        ledgerEntry = debitResult.entry;
      } else {
        const creditResult = wallet.credit(tx.money, tx.id, entryId);
        ledgerEntry = creditResult.entry;
      }

      tx.markProcessed(reference.id, now);

      // Save mutated wallet
      const updatedWalletEntity = WalletEntity.fromDomain(wallet);
      await em.upsert(WalletEntity, updatedWalletEntity);
      await em.flush();

      // Save processed transaction
      const updatedTxEntity = WagerTransactionEntity.fromDomain(tx);
      await em.upsert(WagerTransactionEntity, updatedTxEntity);
      await em.flush();

      // Save ledger entry
      const ledgerEntity = WalletLedgerEntryEntity.fromDomain(ledgerEntry);
      em.persist(ledgerEntity);

      // Save integration outbox events
      this.persistOutboxEvent(em, WagerTransactionProcessed.from(tx));
      this.persistOutboxEvent(em, WalletBalanceChanged.from(wallet, ledgerEntry));
      await em.flush();

      return {
        transactionId: tx.id,
        status: WagerTransactionStatus.Processed,
        processed: true,
      };
    });
  }

  private persistOutboxEvent(em: EntityManager, event: IntegrationEvent<unknown>): void {
    const outboxEntity = new OutboxMessageEntity();
    outboxEntity.id = event.eventId;
    outboxEntity.aggregateId = event.aggregateId;
    outboxEntity.eventType = event.eventType;
    outboxEntity.payload = event.toJSON();
    outboxEntity.occurredAt = event.occurredAt;
    outboxEntity.attempts = 0;
    em.persist(outboxEntity);
  }
}
