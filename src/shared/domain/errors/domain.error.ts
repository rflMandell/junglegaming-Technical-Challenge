export abstract class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(currencyA: string, currencyB: string) {
    super(`Currency mismatch: Cannot perform operation between '${currencyA}' and '${currencyB}'`);
  }
}

export class InvalidMoneyError extends DomainError {
  constructor(reason: string) {
    super(`Invalid money: ${reason}`);
  }
}

export class InsufficientFundsError extends DomainError {
  constructor(walletId: string, currentBalance: string, requiredAmount: string) {
    super(
      `Insufficient funds in wallet '${walletId}': current balance is ${currentBalance}, required ${requiredAmount}`,
    );
  }
}

export class InvalidTransactionStateError extends DomainError {
  constructor(transactionId: string, currentStatus: string, attemptedAction: string) {
    super(
      `Invalid transaction state for '${transactionId}': cannot perform '${attemptedAction}' when status is '${currentStatus}'`,
    );
  }
}

export class UnbalancedLedgerEntryError extends DomainError {
  constructor(reason: string) {
    super(`Unbalanced ledger entry: ${reason}`);
  }
}
