import { describe, it, expect } from 'bun:test';
import { Money } from '../../src/shared/domain/value-objects/money.value-object';
import {
  CurrencyMismatchError,
  InvalidMoneyError,
} from '../../src/shared/domain/errors/domain.error';

describe('Money Value Object (Unit)', () => {
  describe('Creation and Validation', () => {
    it('should create valid Money instance with 2 decimal places', () => {
      const money = Money.from({ amount: '25.00', currency: 'BRL' });
      expect(money.toString()).toBe('25.00');
      expect(money.currency).toBe('BRL');
      expect(money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    });

    it('should format numbers with 1 decimal place to 2 decimal places', () => {
      const money = Money.from({ amount: '25.5', currency: 'BRL' });
      expect(money.toString()).toBe('25.50');
    });

    it('should create Money with integer string format', () => {
      const money = Money.from({ amount: '100', currency: 'BRL' });
      expect(money.toString()).toBe('100.00');
    });

    it('should create zero Money', () => {
      const zero = Money.zero('BRL');
      expect(zero.toString()).toBe('0.00');
      expect(zero.isZero()).toBe(true);
      expect(zero.isPositive()).toBe(false);
      expect(zero.isNegative()).toBe(false);
    });

    it('should reject amounts with more than 2 decimal places', () => {
      expect(() => Money.from({ amount: '25.001', currency: 'BRL' })).toThrow(InvalidMoneyError);
      expect(() => Money.from({ amount: '10.999', currency: 'BRL' })).toThrow(InvalidMoneyError);
    });

    it('should reject negative amounts in default input context', () => {
      expect(() => Money.from({ amount: '-25.00', currency: 'BRL' })).toThrow(InvalidMoneyError);
    });

    it('should allow negative amounts when explicitly enabled for internal domain operations', () => {
      const negative = Money.from({ amount: '-25.00', currency: 'BRL' }, { allowNegative: true });
      expect(negative.toString()).toBe('-25.00');
      expect(negative.isNegative()).toBe(true);
    });

    it('should reject invalid currency codes', () => {
      expect(() => Money.from({ amount: '25.00', currency: 'brl' })).toThrow(InvalidMoneyError);
      expect(() => Money.from({ amount: '25.00', currency: 'BR' })).toThrow(InvalidMoneyError);
      expect(() => Money.from({ amount: '25.00', currency: 'BRLA' })).toThrow(InvalidMoneyError);
    });

    it('should reject scientific notation, empty strings, and special constants', () => {
      expect(() => Money.from({ amount: '1e5', currency: 'BRL' })).toThrow(InvalidMoneyError);
      expect(() => Money.from({ amount: 'NaN', currency: 'BRL' })).toThrow(InvalidMoneyError);
      expect(() => Money.from({ amount: 'Infinity', currency: 'BRL' })).toThrow(InvalidMoneyError);
      expect(() => Money.from({ amount: '', currency: 'BRL' })).toThrow(InvalidMoneyError);
      expect(() => Money.from({ amount: '   ', currency: 'BRL' })).toThrow(InvalidMoneyError);
      expect(() => Money.from({ amount: 'abc', currency: 'BRL' })).toThrow(InvalidMoneyError);
      expect(() => Money.from({ amount: '25,00', currency: 'BRL' })).toThrow(InvalidMoneyError);
    });
  });

  describe('Arithmetic and Comparisons', () => {
    it('should add two Money instances of the same currency', () => {
      const a = Money.from({ amount: '25.50', currency: 'BRL' });
      const b = Money.from({ amount: '10.25', currency: 'BRL' });
      const sum = a.add(b);

      expect(sum.toString()).toBe('35.75');
      expect(sum.currency).toBe('BRL');
    });

    it('should subtract two Money instances of the same currency', () => {
      const a = Money.from({ amount: '25.50', currency: 'BRL' });
      const b = Money.from({ amount: '10.25', currency: 'BRL' });
      const diff = a.subtract(b);

      expect(diff.toString()).toBe('15.25');
    });

    it('should negate Money value', () => {
      const a = Money.from({ amount: '25.50', currency: 'BRL' });
      const negated = a.negate();

      expect(negated.toString()).toBe('-25.50');
      expect(negated.isNegative()).toBe(true);
    });

    it('should compare Money values correctly', () => {
      const a = Money.from({ amount: '25.00', currency: 'BRL' });
      const b = Money.from({ amount: '50.00', currency: 'BRL' });
      const c = Money.from({ amount: '25.00', currency: 'BRL' });

      expect(a.isLessThan(b)).toBe(true);
      expect(b.isLessThan(a)).toBe(false);
      expect(a.equals(c)).toBe(true);
      expect(a.equals(b)).toBe(false);
    });

    it('should throw CurrencyMismatchError on operations between different currencies', () => {
      const brl = Money.from({ amount: '25.00', currency: 'BRL' });
      const usd = Money.from({ amount: '25.00', currency: 'USD' });

      expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
      expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
      expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
      expect(brl.equals(usd)).toBe(false);
    });
  });
});
