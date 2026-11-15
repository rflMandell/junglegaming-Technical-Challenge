import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { DomainError } from '../../domain/errors/domain.error';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidMoneyError,
  InvalidTransactionStateError,
  UnbalancedLedgerEntryError,
} from '../../domain/errors/domain.error';
import {
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../../modules/wallet/domain/wallet.errors';
import {
  IdempotencyPayloadMismatchError,
  WagerTransactionNotFoundError,
} from '../../../modules/wagering/domain/wagering.errors';

@Catch()
export class GlobalHttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalHttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { correlationId?: string }>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let error = 'Internal Server Error';
    let message: string | string[] = 'An unexpected error occurred';
    let failureCode: string | undefined = undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      if (typeof res === 'object' && res !== null) {
        const obj = res as Record<string, any>;
        error = obj.error || exception.name;
        message = obj.message || exception.message;
        failureCode = obj.failureCode;
      } else {
        error = exception.name;
        message = String(res);
      }
    } else if (exception instanceof InvalidMoneyError) {
      status = HttpStatus.BAD_REQUEST;
      error = 'Bad Request';
      message = exception.message;
      failureCode = 'INVALID_PAYLOAD';
    } else if (
      exception instanceof WalletNotFoundError ||
      exception instanceof WagerTransactionNotFoundError
    ) {
      status = HttpStatus.NOT_FOUND;
      error = 'Not Found';
      message = exception.message;
    } else if (
      exception instanceof IdempotencyPayloadMismatchError ||
      exception instanceof WalletAlreadyExistsError
    ) {
      status = HttpStatus.CONFLICT;
      error = 'Conflict';
      message = exception.message;
      failureCode =
        exception instanceof IdempotencyPayloadMismatchError
          ? 'IDEMPOTENCY_PAYLOAD_MISMATCH'
          : undefined;
    } else if (
      exception instanceof InsufficientFundsError ||
      exception instanceof CurrencyMismatchError ||
      exception instanceof InvalidTransactionStateError ||
      exception instanceof UnbalancedLedgerEntryError ||
      exception instanceof DomainError
    ) {
      status = HttpStatus.UNPROCESSABLE_ENTITY;
      error = 'Unprocessable Entity';
      message = exception.message;
      if (exception instanceof InsufficientFundsError) {
        failureCode = 'INSUFFICIENT_FUNDS';
      } else if (exception instanceof CurrencyMismatchError) {
        failureCode = 'CURRENCY_MISMATCH';
      }
    } else if (exception instanceof Error) {
      message = exception.message;
      this.logger.error(
        `Unhandled Exception on ${request.method} ${request.url}: ${exception.message}`,
        exception.stack,
      );
    }

    const payload = {
      statusCode: status,
      error,
      message,
      ...(failureCode ? { failureCode } : {}),
      correlationId: request.correlationId,
      timestamp: new Date().toISOString(),
      path: request.url,
    };

    response.status(status).json(payload);
  }
}
