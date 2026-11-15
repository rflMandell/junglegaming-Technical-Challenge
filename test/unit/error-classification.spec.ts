import { describe, it, expect } from 'bun:test';
import { BadRequestException } from '@nestjs/common';
import { classifyError, ErrorCategory } from '../../src/infrastructure/messaging/error-classification';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidMoneyError,
} from '../../src/shared/domain/errors/domain.error';
import { WalletNotFoundError } from '../../src/modules/wallet/domain/wallet.errors';
import { IdempotencyPayloadMismatchError } from '../../src/modules/wagering/domain/wagering.errors';

describe('Error Classification for SQS Processing (Unit)', () => {
  describe('Business Errors (Safe to ACK, domain recorded)', () => {
    it('should classify InsufficientFundsError as BUSINESS', () => {
      const err = new InsufficientFundsError('w-1', '10.00', '50.00');
      expect(classifyError(err)).toBe(ErrorCategory.Business);
    });

    it('should classify CurrencyMismatchError as BUSINESS', () => {
      const err = new CurrencyMismatchError('BRL', 'USD');
      expect(classifyError(err)).toBe(ErrorCategory.Business);
    });

    it('should classify InvalidMoneyError as BUSINESS', () => {
      const err = new InvalidMoneyError('negative amount');
      expect(classifyError(err)).toBe(ErrorCategory.Business);
    });

    it('should classify WalletNotFoundError as BUSINESS', () => {
      const err = new WalletNotFoundError('w-non-existent');
      expect(classifyError(err)).toBe(ErrorCategory.Business);
    });

    it('should classify IdempotencyPayloadMismatchError as BUSINESS', () => {
      const err = new IdempotencyPayloadMismatchError('idemp-key-1');
      expect(classifyError(err)).toBe(ErrorCategory.Business);
    });

    it('should classify BadRequestException as BUSINESS', () => {
      const err = new BadRequestException('Validation failed');
      expect(classifyError(err)).toBe(ErrorCategory.Business);
    });
  });

  describe('Permanent Errors (Unrecoverable, forward to DLQ and ACK)', () => {
    it('should classify SyntaxError (JSON parse failure) as PERMANENT', () => {
      const err = new SyntaxError('Unexpected token in JSON');
      expect(classifyError(err)).toBe(ErrorCategory.Permanent);
    });

    it('should classify class-validator ValidationError as PERMANENT', () => {
      const err = { name: 'ValidationError', message: 'walletId must be a UUID' };
      expect(classifyError(err)).toBe(ErrorCategory.Permanent);
    });
  });

  describe('Transient Errors (Retry with backoff, do not ACK immediately)', () => {
    it('should classify ECONNREFUSED as TRANSIENT', () => {
      const err = { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:5432' };
      expect(classifyError(err)).toBe(ErrorCategory.Transient);
    });

    it('should classify PostgreSQL deadlock 40P01 as TRANSIENT', () => {
      const err = { code: '40P01', message: 'deadlock detected' };
      expect(classifyError(err)).toBe(ErrorCategory.Transient);
    });

    it('should classify PostgreSQL serialization failure 40001 as TRANSIENT', () => {
      const err = { code: '40001', message: 'could not serialize access due to concurrent update' };
      expect(classifyError(err)).toBe(ErrorCategory.Transient);
    });

    it('should classify SQS ThrottlingException as TRANSIENT', () => {
      const err = { name: 'ThrottlingException', message: 'Rate exceeded' };
      expect(classifyError(err)).toBe(ErrorCategory.Transient);
    });

    it('should classify unknown operational errors as TRANSIENT by default', () => {
      const err = new Error('Unexpected socket drop');
      expect(classifyError(err)).toBe(ErrorCategory.Transient);
    });
  });
});
