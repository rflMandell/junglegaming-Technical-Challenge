import { DomainError } from '../../../shared/domain/errors/domain.error';

export class IdempotencyPayloadMismatchError extends DomainError {
  constructor(idempotencyKey: string) {
    super(
      `Idempotency conflict: A transaction with key '${idempotencyKey}' already exists with a different payload`,
    );
  }
}

export class WagerTransactionNotFoundError extends DomainError {
  constructor(identifier: string) {
    super(`Wager transaction '${identifier}' was not found`);
  }
}

export class BusinessRuleViolationError extends DomainError {
  constructor(message: string) {
    super(message);
  }
}
