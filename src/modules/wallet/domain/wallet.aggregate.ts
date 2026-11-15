import { Money } from '../../../shared/domain/value-objects/money.value-object';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
} from '../../../shared/domain/errors/domain.error';
import {
  WalletLedgerEntry,
} from '../../ledger/domain/wallet-ledger-entry.entity';
import { LedgerDirection } from '../../ledger/domain/ledger-direction.enum';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  public static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    openingTransactionId?: string;
    openingEntryId?: string;
  }): { wallet: Wallet; entry?: WalletLedgerEntry } {
    const now = new Date();
    const wallet = new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      now,
      now,
    );

    let entry: WalletLedgerEntry | undefined;
    if (props.initialBalance.isPositive()) {
      entry = WalletLedgerEntry.create({
        id: props.openingEntryId || props.id,
        walletId: wallet.id,
        transactionId: props.openingTransactionId || props.id,
        direction: LedgerDirection.Credit,
        money: props.initialBalance,
        balanceBefore: Money.zero(wallet.currency),
        balanceAfter: props.initialBalance,
        createdAt: now,
      });
    }

    return { wallet, entry };
  }

  public static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  public debit(
    amount: Money,
    transactionId: string,
    entryId: string,
  ): { entry: WalletLedgerEntry } {
    this.assertSameCurrency(amount);

    if (this._balance.isLessThan(amount)) {
      throw new InsufficientFundsError(this.id, this._balance.toString(), amount.toString());
    }

    const balanceBefore = this._balance;
    const balanceAfter = this._balance.subtract(amount);

    const entry = WalletLedgerEntry.create({
      id: entryId,
      walletId: this.id,
      transactionId,
      direction: LedgerDirection.Debit,
      money: amount,
      balanceBefore,
      balanceAfter,
      createdAt: new Date(),
    });

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = new Date();

    return { entry };
  }

  public credit(
    amount: Money,
    transactionId: string,
    entryId: string,
  ): { entry: WalletLedgerEntry } {
    this.assertSameCurrency(amount);

    const balanceBefore = this._balance;
    const balanceAfter = this._balance.add(amount);

    const entry = WalletLedgerEntry.create({
      id: entryId,
      walletId: this.id,
      transactionId,
      direction: LedgerDirection.Credit,
      money: amount,
      balanceBefore,
      balanceAfter,
      createdAt: new Date(),
    });

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = new Date();

    return { entry };
  }

  private assertSameCurrency(money: Money): void {
    if (this.currency !== money.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
