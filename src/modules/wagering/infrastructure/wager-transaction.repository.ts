import { Injectable, Inject } from '@nestjs/common';
import { EntityManager, LockMode, UniqueConstraintViolationException } from '@mikro-orm/postgresql';
import { v7 as uuidv7 } from 'uuid';
import {
  type WagerTransactionRepositoryPort,
  type AtomicWagerParams,
  type TransactionalWagerParams,
} from '../application/ports/wager-transaction.repository.port';
import { WagerTransaction } from '../domain/wager-transaction.entity';
import { WagerTransactionEntity } from './wager-transaction.entity';
import { WalletEntity } from '../../wallet/infrastructure/wallet.entity';
import { WalletLedgerEntryEntity } from '../../ledger/infrastructure/wallet-ledger-entry.entity';
import { OutboxMessageEntity } from '../../messaging/infrastructure/outbox-message.entity';
import { ProviderEntity } from '../../providers/infrastructure/provider.entity';
import { IntegrationEvent } from '../../../shared/domain/events/integration-event';
import { ProcessWagerTransactionResponseDto } from '../application/dtos/wager-transaction-response.dto';
import { WagerTransactionKind } from '../domain/wager-transaction-kind.enum';
import { WagerTransactionStatus } from '../domain/wager-transaction-status.enum';
import { FailureCode } from '../domain/failure-code.enum';
import { Money } from '../../../shared/domain/value-objects/money.value-object';
import { IdempotencyPayloadMismatchError } from '../domain/wagering.errors';
import { WalletNotFoundError } from '../../wallet/domain/wallet.errors';
import { WagerTransactionValidatorService } from '../domain/services/wager-transaction-validator.service';
import { WagerTransactionProcessed } from '../domain/events/wager-transaction-processed.event';
import { WagerTransactionRejected } from '../domain/events/wager-transaction-rejected.event';
import { WagerTransactionPendingReference } from '../domain/events/wager-transaction-pending-reference.event';
import { WalletBalanceChanged } from '../../wallet/domain/events/wallet-balance-changed.event';
import { LedgerDirection } from '../../ledger/domain/ledger-direction.enum';
import { ENTITY_MANAGER_TOKEN } from '../../../infrastructure/database/database.module';

@Injectable()
export class WagerTransactionRepository implements WagerTransactionRepositoryPort {
  constructor(
    @Inject(ENTITY_MANAGER_TOKEN)
    private readonly em: EntityManager,
  ) {}

  async findById(id: string): Promise<WagerTransaction | null> {
    const fork = this.em.fork();
    const entity = await fork.findOne(WagerTransactionEntity, { id });
    return entity ? WagerTransactionEntity.toDomain(entity) : null;
  }

  async findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    const fork = this.em.fork();
    const entity = await fork.findOne(WagerTransactionEntity, {
      providerId,
      externalTransactionId,
    });
    return entity ? WagerTransactionEntity.toDomain(entity) : null;
  }

  async findByIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransaction | null> {
    const fork = this.em.fork();
    const entity = await fork.findOne(WagerTransactionEntity, {
      providerId,
      idempotencyKey,
    });
    return entity ? WagerTransactionEntity.toDomain(entity) : null;
  }

  async findReversalsFor(
    providerId: string,
    referenceExternalTransactionId: string,
  ): Promise<WagerTransaction[]> {
    const fork = this.em.fork();
    const entities = await fork.find(WagerTransactionEntity, {
      providerId,
      referenceExternalTransactionId,
    });
    return entities.map((e) => WagerTransactionEntity.toDomain(e));
  }

  async save(
    transaction: WagerTransaction,
    events: IntegrationEvent<unknown>[] = [],
  ): Promise<void> {
    await this.em.transactional(async (em) => {
      const provider = new ProviderEntity();
      provider.id = transaction.providerId;
      provider.name = `Provider ${transaction.providerId}`;
      await em.upsert(ProviderEntity, provider);

      const txEntity = WagerTransactionEntity.fromDomain(transaction);
      await em.upsert(WagerTransactionEntity, txEntity);

      for (const event of events) {
        const outboxEntity = new OutboxMessageEntity();
        outboxEntity.id = event.eventId;
        outboxEntity.aggregateId = event.aggregateId;
        outboxEntity.eventType = event.eventType;
        outboxEntity.payload = event.toJSON();
        outboxEntity.occurredAt = event.occurredAt;
        outboxEntity.attempts = 0;
        em.persist(outboxEntity);
      }

      await em.flush();
    });
  }

  async executeAtomicWager(params: AtomicWagerParams): Promise<void> {
    await this.em.transactional(async (em) => {
      const provider = new ProviderEntity();
      provider.id = params.transaction.providerId;
      provider.name = `Provider ${params.transaction.providerId}`;
      await em.upsert(ProviderEntity, provider);

      const walletEntity = WalletEntity.fromDomain(params.wallet);
      await em.upsert(WalletEntity, walletEntity);
      await em.flush();

      const txEntity = WagerTransactionEntity.fromDomain(params.transaction);
      await em.upsert(WagerTransactionEntity, txEntity);
      await em.flush();

      if (params.ledgerEntry) {
        const ledgerEntity = WalletLedgerEntryEntity.fromDomain(params.ledgerEntry);
        em.persist(ledgerEntity);
      }

      for (const event of params.events) {
        const outboxEntity = new OutboxMessageEntity();
        outboxEntity.id = event.eventId;
        outboxEntity.aggregateId = event.aggregateId;
        outboxEntity.eventType = event.eventType;
        outboxEntity.payload = event.toJSON();
        outboxEntity.occurredAt = event.occurredAt;
        outboxEntity.attempts = 0;
        em.persist(outboxEntity);
      }

      await em.flush();
    });
  }

  async executeTransactionalWager(
    params: TransactionalWagerParams,
  ): Promise<ProcessWagerTransactionResponseDto> {
    const { dto, idempotencyKey, payloadHash, correlationId } = params;

    try {
      return await this.em.transactional(async (em) => {
        // 1. Ensure provider exists atomically via upsert
        const provider = new ProviderEntity();
        provider.id = dto.providerId;
        provider.name = `Provider ${dto.providerId}`;
        await em.upsert(ProviderEntity, provider);

        // 2. Persistent Idempotency Check inside transaction
        const existingTxEntity = await em.findOne(WagerTransactionEntity, {
          providerId: dto.providerId,
          idempotencyKey,
        });

        if (existingTxEntity) {
          const existingTx = WagerTransactionEntity.toDomain(existingTxEntity);
          if (!existingTx.matchesPayload(payloadHash)) {
            throw new IdempotencyPayloadMismatchError(idempotencyKey);
          }

          const walletEntity = await em.findOne(WalletEntity, { id: existingTx.walletId });
          const wallet = walletEntity ? WalletEntity.toDomain(walletEntity) : null;
          return {
            transactionId: existingTx.id,
            status: existingTx.status,
            balance: wallet ? wallet.balance.toJSON() : existingTx.money.toJSON(),
            failureCode: existingTx.failureCode,
            idempotentReplay: true,
          };
        }

        // 3. PESSIMISTIC WRITE LOCK on the wallet: SELECT ... FOR UPDATE
        const walletEntity = await em.findOne(
          WalletEntity,
          { id: dto.walletId },
          { lockMode: LockMode.PESSIMISTIC_WRITE },
        );

        if (!walletEntity) {
          throw new WalletNotFoundError(dto.walletId);
        }

        const wallet = WalletEntity.toDomain(walletEntity);
        const money = Money.from(dto.money);

        // 4. Validate Currency
        if (wallet.currency !== money.currency) {
          const rejectedTx = WagerTransaction.create({
            id: uuidv7(),
            providerId: dto.providerId,
            externalTransactionId: dto.externalTransactionId,
            idempotencyKey,
            payloadHash,
            walletId: dto.walletId,
            playerId: dto.playerId,
            roundId: dto.roundId,
            gameId: dto.gameId,
            kind: dto.kind,
            money,
            referenceExternalTransactionId: dto.referenceExternalTransactionId,
          });
          rejectedTx.reject(FailureCode.CurrencyMismatch);

          const txEntity = WagerTransactionEntity.fromDomain(rejectedTx);
          await em.upsert(WagerTransactionEntity, txEntity);

          const event = WagerTransactionRejected.from(
            rejectedTx,
            'Operation currency does not match wallet currency',
            { correlationId },
          );
          this.persistOutboxEvent(em, event);
          await em.flush();

          return {
            transactionId: rejectedTx.id,
            status: WagerTransactionStatus.Rejected,
            balance: wallet.balance.toJSON(),
            failureCode: FailureCode.CurrencyMismatch,
            idempotentReplay: false,
          };
        }

        const txId = uuidv7();
        const entryId = uuidv7();

        // 5. Execute by kind under lock
        switch (dto.kind) {
          case WagerTransactionKind.Bet: {
            const tx = WagerTransaction.create({
              id: txId,
              providerId: dto.providerId,
              externalTransactionId: dto.externalTransactionId,
              idempotencyKey,
              payloadHash,
              walletId: dto.walletId,
              playerId: dto.playerId,
              roundId: dto.roundId,
              gameId: dto.gameId,
              kind: dto.kind,
              money,
            });

            if (wallet.balance.isLessThan(money)) {
              tx.reject(FailureCode.InsufficientFunds);
              const txEntity = WagerTransactionEntity.fromDomain(tx);
              await em.upsert(WagerTransactionEntity, txEntity);

              const event = WagerTransactionRejected.from(tx, 'Insufficient funds for BET operation', {
                correlationId,
              });
              this.persistOutboxEvent(em, event);
              await em.flush();

              return {
                transactionId: tx.id,
                status: WagerTransactionStatus.Rejected,
                balance: wallet.balance.toJSON(),
                failureCode: FailureCode.InsufficientFunds,
                idempotentReplay: false,
              };
            }

            // Debit under lock
            const { entry } = wallet.debit(money, tx.id, entryId);
            tx.markProcessed(undefined, new Date());

            // Save updated wallet
            const updatedWalletEntity = WalletEntity.fromDomain(wallet);
            await em.upsert(WalletEntity, updatedWalletEntity);
            await em.flush();

            // Save transaction
            const txEntity = WagerTransactionEntity.fromDomain(tx);
            await em.upsert(WagerTransactionEntity, txEntity);
            await em.flush();

            // Save ledger
            const ledgerEntity = WalletLedgerEntryEntity.fromDomain(entry);
            em.persist(ledgerEntity);

            // Save events
            this.persistOutboxEvent(em, WagerTransactionProcessed.from(tx, { correlationId }));
            this.persistOutboxEvent(em, WalletBalanceChanged.from(wallet, entry, { correlationId }));
            await em.flush();

            return {
              transactionId: tx.id,
              status: WagerTransactionStatus.Processed,
              balance: wallet.balance.toJSON(),
              idempotentReplay: false,
            };
          }

          case WagerTransactionKind.Win: {
            const tx = WagerTransaction.create({
              id: txId,
              providerId: dto.providerId,
              externalTransactionId: dto.externalTransactionId,
              idempotencyKey,
              payloadHash,
              walletId: dto.walletId,
              playerId: dto.playerId,
              roundId: dto.roundId,
              gameId: dto.gameId,
              kind: dto.kind,
              money,
              referenceExternalTransactionId: dto.referenceExternalTransactionId,
            });

            const { entry } = wallet.credit(money, tx.id, entryId);
            tx.markProcessed(undefined, new Date());

            const updatedWalletEntity = WalletEntity.fromDomain(wallet);
            await em.upsert(WalletEntity, updatedWalletEntity);
            await em.flush();

            const txEntity = WagerTransactionEntity.fromDomain(tx);
            await em.upsert(WagerTransactionEntity, txEntity);
            await em.flush();

            const ledgerEntity = WalletLedgerEntryEntity.fromDomain(entry);
            em.persist(ledgerEntity);

            this.persistOutboxEvent(em, WagerTransactionProcessed.from(tx, { correlationId }));
            this.persistOutboxEvent(em, WalletBalanceChanged.from(wallet, entry, { correlationId }));
            await em.flush();

            return {
              transactionId: tx.id,
              status: WagerTransactionStatus.Processed,
              balance: wallet.balance.toJSON(),
              idempotentReplay: false,
            };
          }

          case WagerTransactionKind.Loss: {
            const tx = WagerTransaction.create({
              id: txId,
              providerId: dto.providerId,
              externalTransactionId: dto.externalTransactionId,
              idempotencyKey,
              payloadHash,
              walletId: dto.walletId,
              playerId: dto.playerId,
              roundId: dto.roundId,
              gameId: dto.gameId,
              kind: dto.kind,
              money,
              referenceExternalTransactionId: dto.referenceExternalTransactionId,
            });

            tx.markProcessed(undefined, new Date());
            const txEntity = WagerTransactionEntity.fromDomain(tx);
            await em.upsert(WagerTransactionEntity, txEntity);

            this.persistOutboxEvent(em, WagerTransactionProcessed.from(tx, { correlationId }));
            await em.flush();

            return {
              transactionId: tx.id,
              status: WagerTransactionStatus.Processed,
              balance: wallet.balance.toJSON(),
              idempotentReplay: false,
            };
          }

          case WagerTransactionKind.Refund:
          case WagerTransactionKind.Rollback: {
            const tx = WagerTransaction.create({
              id: txId,
              providerId: dto.providerId,
              externalTransactionId: dto.externalTransactionId,
              idempotencyKey,
              payloadHash,
              walletId: dto.walletId,
              playerId: dto.playerId,
              roundId: dto.roundId,
              gameId: dto.gameId,
              kind: dto.kind,
              money,
              referenceExternalTransactionId: dto.referenceExternalTransactionId,
            });

            const refEntity = await em.findOne(WagerTransactionEntity, {
              providerId: dto.providerId,
              externalTransactionId: dto.referenceExternalTransactionId!,
            });

            if (!refEntity) {
              tx.markPendingReference(new Date(Date.now() + 5000));
              const txEntity = WagerTransactionEntity.fromDomain(tx);
              await em.upsert(WagerTransactionEntity, txEntity);

              this.persistOutboxEvent(em, WagerTransactionPendingReference.from(tx, { correlationId }));
              await em.flush();

              return {
                transactionId: tx.id,
                status: WagerTransactionStatus.PendingReference,
                balance: wallet.balance.toJSON(),
                idempotentReplay: false,
              };
            }

            const reference = WagerTransactionEntity.toDomain(refEntity);
            const existingReversalsEntities = await em.find(WagerTransactionEntity, {
              providerId: dto.providerId,
              referenceExternalTransactionId: dto.referenceExternalTransactionId!,
            });
            const existingReversals = existingReversalsEntities.map((e) => WagerTransactionEntity.toDomain(e));

            const validation = WagerTransactionValidatorService.validateReference(
              tx,
              reference,
              wallet,
              existingReversals,
            );

            if (!validation.valid) {
              tx.reject(validation.failureCode);
              const txEntity = WagerTransactionEntity.fromDomain(tx);
              await em.upsert(WagerTransactionEntity, txEntity);

              this.persistOutboxEvent(em, WagerTransactionRejected.from(tx, validation.reason, { correlationId }));
              await em.flush();

              return {
                transactionId: tx.id,
                status: WagerTransactionStatus.Rejected,
                balance: wallet.balance.toJSON(),
                failureCode: validation.failureCode,
                idempotentReplay: false,
              };
            }

            let entry: any;
            if (dto.kind === WagerTransactionKind.Refund) {
              const res = wallet.credit(money, tx.id, entryId);
              entry = res.entry;
            } else {
              const direction = tx.ledgerDirectionFor(reference);
              if (direction === LedgerDirection.Credit) {
                const res = wallet.credit(money, tx.id, entryId);
                entry = res.entry;
              } else {
                const res = wallet.debit(money, tx.id, entryId);
                entry = res.entry;
              }
            }

            tx.markProcessed(reference.id, new Date());

            const updatedWalletEntity = WalletEntity.fromDomain(wallet);
            await em.upsert(WalletEntity, updatedWalletEntity);
            await em.flush();

            const txEntity = WagerTransactionEntity.fromDomain(tx);
            await em.upsert(WagerTransactionEntity, txEntity);
            await em.flush();

            const ledgerEntity = WalletLedgerEntryEntity.fromDomain(entry);
            em.persist(ledgerEntity);

            this.persistOutboxEvent(em, WagerTransactionProcessed.from(tx, { correlationId }));
            this.persistOutboxEvent(em, WalletBalanceChanged.from(wallet, entry, { correlationId }));
            await em.flush();

            return {
              transactionId: tx.id,
              status: WagerTransactionStatus.Processed,
              balance: wallet.balance.toJSON(),
              idempotentReplay: false,
            };
          }

          default:
            throw new Error(`Unsupported transaction kind: ${dto.kind}`);
        }
      });
    } catch (error) {
      // 6. Handle concurrency race condition on unique constraint for idempotency key
      if (
        error instanceof UniqueConstraintViolationException ||
        (error as any)?.code === '23505'
      ) {
        const committedTx = await this.findByIdempotencyKey(dto.providerId, idempotencyKey);
        if (committedTx) {
          if (!committedTx.matchesPayload(payloadHash)) {
            throw new IdempotencyPayloadMismatchError(idempotencyKey);
          }
          const fork = this.em.fork();
          const walletEntity = await fork.findOne(WalletEntity, { id: committedTx.walletId });
          const wallet = walletEntity ? WalletEntity.toDomain(walletEntity) : null;

          return {
            transactionId: committedTx.id,
            status: committedTx.status,
            balance: wallet ? wallet.balance.toJSON() : committedTx.money.toJSON(),
            failureCode: committedTx.failureCode,
            idempotentReplay: true,
          };
        }
      }

      throw error;
    }
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
