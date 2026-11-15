import { Entity, PrimaryKey, Property, Unique, Check, Index } from '@mikro-orm/core';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry.entity';
import { LedgerDirection } from '../domain/ledger-direction.enum';
import { Money } from '../../../shared/domain/value-objects/money.value-object';

@Entity({ tableName: 'wallet_ledger_entries' })
@Unique({ properties: ['transactionId', 'walletId'], name: 'uq_ledger_transaction_wallet' })
@Check({ expression: 'balance_before >= 0', name: 'chk_ledger_balance_before_non_negative' })
@Check({ expression: 'balance_after >= 0', name: 'chk_ledger_balance_after_non_negative' })
@Check({ expression: 'amount > 0', name: 'chk_ledger_amount_positive' })
@Check({
  expression:
    "(direction = 'CREDIT' AND balance_after = balance_before + amount) OR (direction = 'DEBIT' AND balance_after = balance_before - amount)",
  name: 'chk_ledger_arithmetic_balance',
})
@Index({ properties: ['walletId', 'createdAt', 'id'], name: 'idx_ledger_wallet_cursor' })
export class WalletLedgerEntryEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'uuid' })
  walletId!: string;

  @Property({ type: 'uuid' })
  transactionId!: string;

  @Property({ type: 'string', length: 16 })
  direction!: string;

  @Property({ type: 'decimal', precision: 18, scale: 2 })
  amount!: string;

  @Property({ type: 'string', length: 3 })
  currency!: string;

  @Property({ type: 'decimal', precision: 18, scale: 2 })
  balanceBefore!: string;

  @Property({ type: 'decimal', precision: 18, scale: 2 })
  balanceAfter!: string;

  @Property({ type: 'timestamptz', defaultRaw: 'NOW()' })
  createdAt: Date = new Date();

  static toDomain(entity: WalletLedgerEntryEntity): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      id: entity.id,
      walletId: entity.walletId,
      transactionId: entity.transactionId,
      direction: entity.direction as LedgerDirection,
      money: Money.from({ amount: entity.amount, currency: entity.currency }),
      balanceBefore: Money.from({ amount: entity.balanceBefore, currency: entity.currency }),
      balanceAfter: Money.from({ amount: entity.balanceAfter, currency: entity.currency }),
      createdAt: entity.createdAt,
    });
  }

  static fromDomain(entry: WalletLedgerEntry): WalletLedgerEntryEntity {
    const entity = new WalletLedgerEntryEntity();
    entity.id = entry.id;
    entity.walletId = entry.walletId;
    entity.transactionId = entry.transactionId;
    entity.direction = entry.direction;
    entity.amount = entry.money.toString();
    entity.currency = entry.money.currency;
    entity.balanceBefore = entry.balanceBefore.toString();
    entity.balanceAfter = entry.balanceAfter.toString();
    entity.createdAt = entry.createdAt;
    return entity;
  }
}
