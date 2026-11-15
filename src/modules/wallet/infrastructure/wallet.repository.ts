import { Injectable, Inject } from '@nestjs/common';
import { EntityManager, LockMode } from '@mikro-orm/postgresql';
import { v7 as uuidv7 } from 'uuid';
import { type WalletRepositoryPort } from '../application/ports/wallet.repository.port';
import { Wallet } from '../domain/wallet.aggregate';
import { WalletLedgerEntry } from '../../ledger/domain/wallet-ledger-entry.entity';
import { IntegrationEvent } from '../../../shared/domain/events/integration-event';
import { WagerTransaction } from '../../wagering/domain/wager-transaction.entity';
import { WalletEntity } from './wallet.entity';
import { WalletLedgerEntryEntity } from '../../ledger/infrastructure/wallet-ledger-entry.entity';
import { WagerTransactionEntity } from '../../wagering/infrastructure/wager-transaction.entity';
import { OutboxMessageEntity } from '../../messaging/infrastructure/outbox-message.entity';
import { ProviderEntity } from '../../providers/infrastructure/provider.entity';
import { LedgerDirection } from '../../ledger/domain/ledger-direction.enum';
import { ENTITY_MANAGER_TOKEN } from '../../../infrastructure/database/database.module';
import { Money } from '../../../shared/domain/value-objects/money.value-object';
import { WalletBalanceChanged } from '../domain/events/wallet-balance-changed.event';
import { WalletNotFoundError } from '../domain/wallet.errors';

@Injectable()
export class WalletRepository implements WalletRepositoryPort {
  constructor(
    @Inject(ENTITY_MANAGER_TOKEN)
    private readonly em: EntityManager,
  ) {}

  async findById(id: string): Promise<Wallet | null> {
    const fork = this.em.fork();
    const entity = await fork.findOne(WalletEntity, { id });
    return entity ? WalletEntity.toDomain(entity) : null;
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null> {
    const fork = this.em.fork();
    const entity = await fork.findOne(WalletEntity, { playerId, currency });
    return entity ? WalletEntity.toDomain(entity) : null;
  }

  async save(
    wallet: Wallet,
    ledgerEntry?: WalletLedgerEntry,
    outboxEvent?: IntegrationEvent<unknown>,
    openingTx?: WagerTransaction,
  ): Promise<void> {
    await this.em.transactional(async (em) => {
      const ensureSystemProvider = async (providerId = 'system') => {
        const provider = new ProviderEntity();
        provider.id = providerId;
        provider.name = providerId === 'system' ? 'System Internal Provider' : `Provider ${providerId}`;
        await em.upsert(ProviderEntity, provider);
      };

      // 1. Persist / update wallet entity FIRST
      const walletEntity = WalletEntity.fromDomain(wallet);
      await em.upsert(WalletEntity, walletEntity);
      await em.flush();

      // 2. Persist opening wager transaction if provided
      if (openingTx) {
        await ensureSystemProvider(openingTx.providerId);
        const txEntity = WagerTransactionEntity.fromDomain(openingTx);
        await em.upsert(WagerTransactionEntity, txEntity);
        await em.flush();
      }

      // 3. If ledger entry is present, ensure referenced transaction exists in wager_transactions
      if (ledgerEntry) {
        const txExists = await em.findOne(WagerTransactionEntity, { id: ledgerEntry.transactionId });
        if (!txExists && !openingTx) {
          await ensureSystemProvider('system');
          const stubTx = new WagerTransactionEntity();
          stubTx.id = ledgerEntry.transactionId;
          stubTx.providerId = 'system';
          stubTx.externalTransactionId = `ext-${ledgerEntry.transactionId}`;
          stubTx.idempotencyKey = `system:${ledgerEntry.transactionId}`;
          stubTx.payloadHash = `hash-${ledgerEntry.transactionId}`;
          stubTx.walletId = ledgerEntry.walletId;
          stubTx.playerId = wallet.playerId;
          stubTx.roundId = 'round-internal';
          stubTx.gameId = 'game-internal';
          stubTx.kind = ledgerEntry.direction === LedgerDirection.Debit ? 'BET' : 'WIN';
          stubTx.amount = ledgerEntry.money.toString();
          stubTx.currency = ledgerEntry.money.currency;
          stubTx.status = 'PROCESSED';
          stubTx.processedAt = new Date();
          await em.upsert(WagerTransactionEntity, stubTx);
          await em.flush();
        }

        const ledgerEntity = WalletLedgerEntryEntity.fromDomain(ledgerEntry);
        em.persist(ledgerEntity);
      }

      // 4. Persist outbox message if event occurred
      if (outboxEvent) {
        const outboxEntity = new OutboxMessageEntity();
        outboxEntity.id = outboxEvent.eventId;
        outboxEntity.aggregateId = outboxEvent.aggregateId;
        outboxEntity.eventType = outboxEvent.eventType;
        outboxEntity.payload = outboxEvent.toJSON();
        outboxEntity.occurredAt = outboxEvent.occurredAt;
        outboxEntity.attempts = 0;
        em.persist(outboxEntity);
      }

      await em.flush();
    });
  }

  async debitWithLock(
    walletId: string,
    amount: Money,
    transactionId: string,
    correlationId?: string,
  ): Promise<{ wallet: Wallet; entry: WalletLedgerEntry; event: WalletBalanceChanged }> {
    return await this.em.transactional(async (em) => {
      const entity = await em.findOne(
        WalletEntity,
        { id: walletId },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      if (!entity) {
        throw new WalletNotFoundError(walletId);
      }

      const wallet = WalletEntity.toDomain(entity);
      const entryId = uuidv7();
      const { entry } = wallet.debit(amount, transactionId, entryId);
      const event = WalletBalanceChanged.from(wallet, entry, {
        correlationId,
        causationId: transactionId,
      });

      // Update wallet
      const updatedEntity = WalletEntity.fromDomain(wallet);
      await em.upsert(WalletEntity, updatedEntity);
      await em.flush();

      // Ensure transaction exists or create stub
      const txExists = await em.findOne(WagerTransactionEntity, { id: transactionId });
      if (!txExists) {
        let provider = await em.findOne(ProviderEntity, { id: 'system' });
        if (!provider) {
          provider = new ProviderEntity();
          provider.id = 'system';
          provider.name = 'System Internal Provider';
          await em.persistAndFlush(provider);
        }
        const stubTx = new WagerTransactionEntity();
        stubTx.id = transactionId;
        stubTx.providerId = 'system';
        stubTx.externalTransactionId = `ext-${transactionId}`;
        stubTx.idempotencyKey = `system:${transactionId}`;
        stubTx.payloadHash = `hash-${transactionId}`;
        stubTx.walletId = walletId;
        stubTx.playerId = wallet.playerId;
        stubTx.roundId = 'round-internal';
        stubTx.gameId = 'game-internal';
        stubTx.kind = 'BET';
        stubTx.amount = amount.toString();
        stubTx.currency = amount.currency;
        stubTx.status = 'PROCESSED';
        stubTx.processedAt = new Date();
        await em.upsert(WagerTransactionEntity, stubTx);
        await em.flush();
      }

      const ledgerEntity = WalletLedgerEntryEntity.fromDomain(entry);
      em.persist(ledgerEntity);

      const outboxEntity = new OutboxMessageEntity();
      outboxEntity.id = event.eventId;
      outboxEntity.aggregateId = event.aggregateId;
      outboxEntity.eventType = event.eventType;
      outboxEntity.payload = event.toJSON();
      outboxEntity.occurredAt = event.occurredAt;
      outboxEntity.attempts = 0;
      em.persist(outboxEntity);

      await em.flush();

      return { wallet, entry, event };
    });
  }

  async creditWithLock(
    walletId: string,
    amount: Money,
    transactionId: string,
    correlationId?: string,
  ): Promise<{ wallet: Wallet; entry: WalletLedgerEntry; event: WalletBalanceChanged }> {
    return await this.em.transactional(async (em) => {
      const entity = await em.findOne(
        WalletEntity,
        { id: walletId },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      if (!entity) {
        throw new WalletNotFoundError(walletId);
      }

      const wallet = WalletEntity.toDomain(entity);
      const entryId = uuidv7();
      const { entry } = wallet.credit(amount, transactionId, entryId);
      const event = WalletBalanceChanged.from(wallet, entry, {
        correlationId,
        causationId: transactionId,
      });

      // Update wallet
      const updatedEntity = WalletEntity.fromDomain(wallet);
      await em.upsert(WalletEntity, updatedEntity);
      await em.flush();

      // Ensure transaction exists or create stub
      const txExists = await em.findOne(WagerTransactionEntity, { id: transactionId });
      if (!txExists) {
        let provider = await em.findOne(ProviderEntity, { id: 'system' });
        if (!provider) {
          provider = new ProviderEntity();
          provider.id = 'system';
          provider.name = 'System Internal Provider';
          await em.persistAndFlush(provider);
        }
        const stubTx = new WagerTransactionEntity();
        stubTx.id = transactionId;
        stubTx.providerId = 'system';
        stubTx.externalTransactionId = `ext-${transactionId}`;
        stubTx.idempotencyKey = `system:${transactionId}`;
        stubTx.payloadHash = `hash-${transactionId}`;
        stubTx.walletId = walletId;
        stubTx.playerId = wallet.playerId;
        stubTx.roundId = 'round-internal';
        stubTx.gameId = 'game-internal';
        stubTx.kind = 'WIN';
        stubTx.amount = amount.toString();
        stubTx.currency = amount.currency;
        stubTx.status = 'PROCESSED';
        stubTx.processedAt = new Date();
        await em.upsert(WagerTransactionEntity, stubTx);
        await em.flush();
      }

      const ledgerEntity = WalletLedgerEntryEntity.fromDomain(entry);
      em.persist(ledgerEntity);

      const outboxEntity = new OutboxMessageEntity();
      outboxEntity.id = event.eventId;
      outboxEntity.aggregateId = event.aggregateId;
      outboxEntity.eventType = event.eventType;
      outboxEntity.payload = event.toJSON();
      outboxEntity.occurredAt = event.occurredAt;
      outboxEntity.attempts = 0;
      em.persist(outboxEntity);

      await em.flush();

      return { wallet, entry, event };
    });
  }
}
