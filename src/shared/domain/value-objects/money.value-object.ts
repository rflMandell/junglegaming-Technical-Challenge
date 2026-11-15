import Decimal from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from '../errors/domain.error';

export interface MoneyProps {
  amount: string; // decimal string, ex.: "25.00"
  currency: string; // ISO-4217, ex.: "BRL"
}

// Configure Decimal.js for strict monetary precision
Decimal.set({
  precision: 28,
  rounding: Decimal.ROUND_HALF_EVEN, // Banker's rounding
  toExpNeg: -7,
  toExpPos: 21,
});

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  public static from(props: MoneyProps, options?: { allowNegative?: boolean }): Money {
    if (!props) {
      throw new InvalidMoneyError('Money properties must be provided');
    }

    const { amount, currency } = props;

    if (typeof amount !== 'string' || amount.trim() === '') {
      throw new InvalidMoneyError('Amount must be a non-empty string');
    }

    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
      throw new InvalidMoneyError(
        `Invalid currency code: '${currency}'. Must be a 3-letter uppercase ISO-4217 code.`,
      );
    }

    // Reject scientific notation, special constants, or non-numeric characters
    if (/e/i.test(amount) || amount === 'NaN' || amount === 'Infinity' || amount === '-Infinity') {
      throw new InvalidMoneyError(`Amount contains invalid format or characters: '${amount}'`);
    }

    // Must match a strict decimal number format with up to 2 decimal places
    const decimalRegex = /^-?\d+(\.\d+)?$/;
    if (!decimalRegex.test(amount)) {
      throw new InvalidMoneyError(`Amount has invalid numeric format: '${amount}'`);
    }

    // Reject more than 2 decimal places
    const decimalParts = amount.split('.');
    if (decimalParts.length === 2 && decimalParts[1].length > 2) {
      throw new InvalidMoneyError(
        `Amount '${amount}' exceeds maximum allowed precision of 2 decimal places`,
      );
    }

    let parsed: Decimal;
    try {
      parsed = new Decimal(amount);
    } catch {
      throw new InvalidMoneyError(`Cannot parse amount to decimal: '${amount}'`);
    }

    if (!parsed.isFinite()) {
      throw new InvalidMoneyError(`Amount is not finite: '${amount}'`);
    }

    // Enforce non-negative rule by default unless explicitly allowed
    if (!options?.allowNegative && parsed.isNegative()) {
      throw new InvalidMoneyError(`Negative amounts are not allowed in this context: '${amount}'`);
    }

    // Standardize to exactly 2 decimal places
    const fixedValue = new Decimal(parsed.toFixed(2));
    return new Money(fixedValue, currency);
  }

  public static zero(currency: string): Money {
    if (!currency || !/^[A-Z]{3}$/.test(currency)) {
      throw new InvalidMoneyError(`Invalid currency code: '${currency}'`);
    }
    return new Money(new Decimal('0.00'), currency);
  }

  /**
   * Internal reconstruction factory without validation of entry constraints (e.g. from DB).
   */
  public static rehydrate(props: MoneyProps): Money {
    return Money.from(props, { allowNegative: true });
  }

  public add(other: Money): Money {
    this.assertSameCurrency(other);
    const result = this.value.plus(other.value);
    return new Money(new Decimal(result.toFixed(2)), this.currency);
  }

  public subtract(other: Money): Money {
    this.assertSameCurrency(other);
    const result = this.value.minus(other.value);
    return new Money(new Decimal(result.toFixed(2)), this.currency);
  }

  public negate(): Money {
    const result = this.value.negated();
    return new Money(new Decimal(result.toFixed(2)), this.currency);
  }

  public isZero(): boolean {
    return this.value.isZero();
  }

  public isPositive(): boolean {
    return this.value.isPositive() && !this.value.isZero();
  }

  public isNegative(): boolean {
    return this.value.isNegative();
  }

  public isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  public equals(other: Money): boolean {
    if (this.currency !== other.currency) {
      return false;
    }
    return this.value.equals(other.value);
  }

  public toJSON(): MoneyProps {
    return {
      amount: this.toString(),
      currency: this.currency,
    };
  }

  public toString(): string {
    return this.value.toFixed(2);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
