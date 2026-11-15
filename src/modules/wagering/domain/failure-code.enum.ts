export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  AmountMismatch = 'AMOUNT_MISMATCH',
  ReversalWouldCauseNegativeBalance = 'REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  InvalidPayload = 'INVALID_PAYLOAD',
  IdempotencyPayloadMismatch = 'IDEMPOTENCY_PAYLOAD_MISMATCH',
  TransactionAlreadyTerminal = 'TRANSACTION_ALREADY_TERMINAL',
  InternalInfrastructureError = 'INTERNAL_INFRASTRUCTURE_ERROR',
}
