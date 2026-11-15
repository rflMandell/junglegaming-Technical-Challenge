import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { MikroORM } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { v7 as uuidv7 } from 'uuid';
import mikroOrmConfig from '../../mikro-orm.config';
import { ProviderEntity } from '../../src/modules/providers/infrastructure/provider.entity';
import { WalletEntity } from '../../src/modules/wallet/infrastructure/wallet.entity';
import { WagerTransactionEntity } from '../../src/modules/wagering/infrastructure/wager-transaction.entity';
import { WalletLedgerEntryEntity } from '../../src/modules/ledger/infrastructure/wallet-ledger-entry.entity';
import { InboxMessageEntity } from '../../src/modules/messaging/infrastructure/inbox-message.entity';
import { OutboxMessageEntity } from '../../src/modules/messaging/infrastructure/outbox-message.entity';
import { Wallet } from '../../src/modules/wallet/domain/wallet.aggregate';
import { Money } from '../../src/shared/domain/value-objects/money.value-object';
import { WagerTransaction } from '../../src/modules/wagering/domain/wager-transaction.entity';
import { WagerTransactionKind } from '../../src/modules/wagering/domain/wager-transaction-kind.enum';
import { LedgerDirection } from '../../src/modules/ledger/domain/ledger-direction.enum';
import { WalletLedgerEntry } from '../../src/modules/ledger/domain/wallet-ledger-entry.entity';
import { InboxMessage } from '../../src/modules/messaging/domain/inbox-message.entity';
import { OutboxMessage } from '../../src/modules/messaging/domain/outbox-message.entity';

describe('Database Constraints & Migrations (Integration)', () => {
  let orm: MikroORM<PostgreSqlDriver>;

  beforeAll(async () => {
    orm = await MikroORM.init<PostgreSqlDriver>(mikroOrmConfig);
    const migrator = orm.getMigrator();
    await migrator.up();
  });

  afterAll(async () => {
    if (orm) {
      await orm.close();
    }
  });

  it('should seed test provider if not exists', async () => {
    const em = orm.em.fork();
    const existing = await em.findOne(ProviderEntity, { id: 'provider-test' });
    if (!existing) {
      const provider = new ProviderEntity();
      provider.id = 'provider-test';
      provider.name = 'Test Provider';
      await em.persistAndFlush(provider);
    }
    const found = await em.findOne(ProviderEntity, { id: 'provider-test' });
    expect(found).toBeDefined();
    expect(found?.name).toBe('Test Provider');
  });

  describe('Wallet Constraints', () => {
    it('should reject negative balance via database CHECK constraint', async () => {
      const em = orm.em.fork();
      const invalidWallet = new WalletEntity();
      invalidWallet.id = uuidv7();
      invalidWallet.playerId = uuidv7();
      invalidWallet.currency = 'BRL';
      invalidWallet.balance = '-10.00'; // Violates chk_wallets_balance_non_negative

      expect(em.persistAndFlush(invalidWallet)).rejects.toThrow();
    });

    it('should reject duplicate (playerId, currency) via database UNIQUE constraint', async () => {
      const em = orm.em.fork();
      const playerId = uuidv7();

      const wallet1 = new WalletEntity();
      wallet1.id = uuidv7();
      wallet1.playerId = playerId;
      wallet1.currency = 'BRL';
      wallet1.balance = '100.00';
      await em.persistAndFlush(wallet1);

      const wallet2 = new WalletEntity();
      wallet2.id = uuidv7();
      wallet2.playerId = playerId;
      wallet2.currency = 'BRL'; // Duplicate pair!
      wallet2.balance = '50.00';

      expect(em.persistAndFlush(wallet2)).rejects.toThrow();
    });
  });

  describe('WagerTransaction Constraints', () => {
    it('should reject duplicate idempotency key per provider via UNIQUE constraint', async () => {
      const em = orm.em.fork();
      const walletId = uuidv7();
      const playerId = uuidv7();

      const wallet = new WalletEntity();
      wallet.id = walletId;
      wallet.playerId = playerId;
      wallet.currency = 'BRL';
      wallet.balance = '500.00';
      await em.persistAndFlush(wallet);

      const tx1 = new WagerTransactionEntity();
      tx1.id = uuidv7();
      tx1.providerId = 'provider-test';
      tx1.externalTransactionId = 'tx-ext-unique-1';
      tx1.idempotencyKey = 'provider-test:dup-key';
      tx1.payloadHash = 'hash-1';
      tx1.walletId = walletId;
      tx1.playerId = playerId;
      tx1.roundId = 'round-1';
      tx1.gameId = 'game-1';
      tx1.kind = 'BET';
      tx1.amount = '25.00';
      tx1.currency = 'BRL';
      await em.persistAndFlush(tx1);

      const tx2 = new WagerTransactionEntity();
      tx2.id = uuidv7();
      tx2.providerId = 'provider-test';
      tx2.externalTransactionId = 'tx-ext-unique-2';
      tx2.idempotencyKey = 'provider-test:dup-key'; // Duplicate idempotency key!
      tx2.payloadHash = 'hash-2';
      tx2.walletId = walletId;
      tx2.playerId = playerId;
      tx2.roundId = 'round-1';
      tx2.gameId = 'game-1';
      tx2.kind = 'BET';
      tx2.amount = '25.00';
      tx2.currency = 'BRL';

      expect(em.persistAndFlush(tx2)).rejects.toThrow();
    });
  });

  describe('Ledger Arithmetic & Constraints', () => {
    it('should reject unbalanced ledger entry via database CHECK constraint', async () => {
      const em = orm.em.fork();
      const walletId = uuidv7();
      const playerId = uuidv7();

      const wallet = new WalletEntity();
      wallet.id = walletId;
      wallet.playerId = playerId;
      wallet.currency = 'BRL';
      wallet.balance = '100.00';
      await em.persistAndFlush(wallet);

      const tx = new WagerTransactionEntity();
      tx.id = uuidv7();
      tx.providerId = 'provider-test';
      tx.externalTransactionId = uuidv7();
      tx.idempotencyKey = `provider-test:${tx.externalTransactionId}`;
      tx.payloadHash = 'hash-chk';
      tx.walletId = walletId;
      tx.playerId = playerId;
      tx.roundId = 'round-chk';
      tx.gameId = 'game-chk';
      tx.kind = 'BET';
      tx.amount = '20.00';
      tx.currency = 'BRL';
      await em.persistAndFlush(tx);

      // Unbalanced ledger entry: 100 - 20 !== 70
      const unbalancedEntry = new WalletLedgerEntryEntity();
      unbalancedEntry.id = uuidv7();
      unbalancedEntry.walletId = walletId;
      unbalancedEntry.transactionId = tx.id;
      unbalancedEntry.direction = 'DEBIT';
      unbalancedEntry.amount = '20.00';
      unbalancedEntry.currency = 'BRL';
      unbalancedEntry.balanceBefore = '100.00';
      unbalancedEntry.balanceAfter = '70.00'; // Arithmetic wrong! Should be 80.00

      expect(em.persistAndFlush(unbalancedEntry)).rejects.toThrow();
    });

    it('should reject more than one ledger entry for the same (transactionId, walletId)', async () => {
      const em = orm.em.fork();
      const walletId = uuidv7();
      const playerId = uuidv7();

      const wallet = new WalletEntity();
      wallet.id = walletId;
      wallet.playerId = playerId;
      wallet.currency = 'BRL';
      wallet.balance = '200.00';
      await em.persistAndFlush(wallet);

      const tx = new WagerTransactionEntity();
      tx.id = uuidv7();
      tx.providerId = 'provider-test';
      tx.externalTransactionId = uuidv7();
      tx.idempotencyKey = `provider-test:${tx.externalTransactionId}`;
      tx.payloadHash = 'hash-single';
      tx.walletId = walletId;
      tx.playerId = playerId;
      tx.roundId = 'round-s';
      tx.gameId = 'game-s';
      tx.kind = 'BET';
      tx.amount = '50.00';
      tx.currency = 'BRL';
      await em.persistAndFlush(tx);

      const entry1 = new WalletLedgerEntryEntity();
      entry1.id = uuidv7();
      entry1.walletId = walletId;
      entry1.transactionId = tx.id;
      entry1.direction = 'DEBIT';
      entry1.amount = '50.00';
      entry1.currency = 'BRL';
      entry1.balanceBefore = '200.00';
      entry1.balanceAfter = '150.00';
      await em.persistAndFlush(entry1);

      const entry2 = new WalletLedgerEntryEntity();
      entry2.id = uuidv7();
      entry2.walletId = walletId;
      entry2.transactionId = tx.id; // Same transaction for same wallet!
      entry2.direction = 'DEBIT';
      entry2.amount = '50.00';
      entry2.currency = 'BRL';
      entry2.balanceBefore = '150.00';
      entry2.balanceAfter = '100.00';

      expect(em.persistAndFlush(entry2)).rejects.toThrow();
    });
  });

  describe('Domain Persistence & Rehydration Roundtrip', () => {
    it('should persist and rehydrate Wallet domain model preserving exact values', async () => {
      const em = orm.em.fork();
      const walletId = uuidv7();
      const playerId = uuidv7();

      const { wallet } = Wallet.open({
        id: walletId,
        playerId,
        initialBalance: Money.from({ amount: '350.50', currency: 'BRL' }),
      });

      const entity = WalletEntity.fromDomain(wallet);
      await em.persistAndFlush(entity);

      const foundEntity = await em.findOneOrFail(WalletEntity, { id: walletId });
      const rehydrated = WalletEntity.toDomain(foundEntity);

      expect(rehydrated.id).toBe(wallet.id);
      expect(rehydrated.playerId).toBe(wallet.playerId);
      expect(rehydrated.currency).toBe('BRL');
      expect(rehydrated.balance.toString()).toBe('350.50');
      expect(rehydrated.version).toBe(1);
    });

    it('should persist and rehydrate WagerTransaction domain model', async () => {
      const em = orm.em.fork();
      const walletId = uuidv7();
      const playerId = uuidv7();

      const wallet = new WalletEntity();
      wallet.id = walletId;
      wallet.playerId = playerId;
      wallet.currency = 'BRL';
      wallet.balance = '500.00';
      await em.persistAndFlush(wallet);

      const tx = WagerTransaction.create({
        id: uuidv7(),
        providerId: 'provider-test',
        externalTransactionId: uuidv7(),
        idempotencyKey: `provider-test:${uuidv7()}`,
        payloadHash: 'hash-roundtrip',
        walletId,
        playerId,
        roundId: 'round-rt',
        gameId: 'game-rt',
        kind: WagerTransactionKind.Bet,
        money: Money.from({ amount: '75.25', currency: 'BRL' }),
      });

      const entity = WagerTransactionEntity.fromDomain(tx);
      await em.persistAndFlush(entity);

      const found = await em.findOneOrFail(WagerTransactionEntity, { id: tx.id });
      const rehydrated = WagerTransactionEntity.toDomain(found);

      expect(rehydrated.id).toBe(tx.id);
      expect(rehydrated.money.toString()).toBe('75.25');
      expect(rehydrated.kind).toBe(WagerTransactionKind.Bet);
      expect(rehydrated.status).toBe(tx.status);
    });
  });

  describe('Migration Reversibility', () => {
    it('should revert (down) and re-apply (up) migrations cleanly', async () => {
      const migrator = orm.getMigrator();

      // Test down
      await migrator.down();

      // Verify table does not exist
      const conn = orm.em.getConnection();
      const result = await conn.execute(
        `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'wallets');`,
      );
      expect(result[0].exists).toBe(false);

      // Test up again
      await migrator.up();
      const resultAfterUp = await conn.execute(
        `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'wallets');`,
      );
      expect(resultAfterUp[0].exists).toBe(true);
    });
  });
});
