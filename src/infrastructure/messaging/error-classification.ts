import { BadRequestException } from '@nestjs/common';
import { DomainError } from '../../shared/domain/errors/domain.error';

export enum ErrorCategory {
  Business = 'BUSINESS',
  Transient = 'TRANSIENT',
  Permanent = 'PERMANENT',
}

export function classifyError(error: unknown): ErrorCategory {
  if (error instanceof DomainError || error instanceof BadRequestException) {
    return ErrorCategory.Business;
  }

  if (error instanceof SyntaxError || (error as any)?.name === 'ValidationError') {
    return ErrorCategory.Permanent;
  }

  const message = error instanceof Error ? error.message : String(error);
  const code = (error as any)?.code;

  // Well-known transient PostgreSQL and Network error codes
  if (
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === '40P01' || // deadlock_detected
    code === '40001' || // serialization_failure
    code === '57P01' || // admin_shutdown
    code === '57P02' || // crash_shutdown
    code === '57P03' || // cannot_connect_now
    code === '08006' || // connection_failure
    code === '08001' || // unable_to_establish_sqlconnection
    message.includes('Connection terminated') ||
    message.includes('connection timeout') ||
    message.includes('deadlock') ||
    message.includes('Lock wait timeout')
  ) {
    return ErrorCategory.Transient;
  }

  // Check if error is an SQS throttling or service unavailable error
  const name = (error as any)?.name;
  if (
    name === 'OverLimitException' ||
    name === 'ServiceUnavailable' ||
    name === 'ThrottlingException'
  ) {
    return ErrorCategory.Transient;
  }

  // By default, unknown operational errors are treated as transient to allow retries up to maxReceiveCount
  return ErrorCategory.Transient;
}
