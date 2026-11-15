import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Headers,
  Res,
  HttpStatus,
  BadRequestException,
  NotFoundException,
  ConflictException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiHeader } from '@nestjs/swagger';
import type { Response } from 'express';
import { ProcessWagerTransactionDto } from '../application/dtos/process-wager-transaction.dto';
import { ProcessWagerTransactionUseCase } from '../application/use-cases/process-wager-transaction.use-case';
import { GetWagerTransactionUseCase } from '../application/use-cases/get-wager-transaction.use-case';
import { IdempotencyPayloadMismatchError, WagerTransactionNotFoundError } from '../domain/wagering.errors';
import { WalletNotFoundError } from '../../wallet/domain/wallet.errors';
import { WagerTransactionStatus } from '../domain/wager-transaction-status.enum';

@ApiTags('Wagering')
@Controller()
export class WageringController {
  constructor(
    private readonly processWagerUseCase: ProcessWagerTransactionUseCase,
    private readonly getWagerUseCase: GetWagerTransactionUseCase,
  ) {}

  @Post('wagering/transactions')
  @ApiOperation({ summary: 'Process a wagering transaction (BET, WIN, LOSS, REFUND, ROLLBACK)' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'Unique idempotency key from provider' })
  @ApiHeader({ name: 'X-Correlation-Id', required: false, description: 'Distributed tracing correlation ID' })
  @ApiResponse({ status: 201, description: 'Transaction processed successfully' })
  @ApiResponse({ status: 200, description: 'Idempotent replay of previously processed transaction' })
  @ApiResponse({ status: 202, description: 'Transaction accepted but pending reference transaction' })
  @ApiResponse({ status: 400, description: 'Missing required header or malformed payload' })
  @ApiResponse({ status: 404, description: 'Wallet not found' })
  @ApiResponse({ status: 409, description: 'Idempotency key reused with different payload' })
  @ApiResponse({ status: 422, description: 'Transaction rejected by business rules (e.g. INSUFFICIENT_FUNDS)' })
  async processTransaction(
    @Body() dto: ProcessWagerTransactionDto,
    @Headers('idempotency-key') idempotencyKeyHeader?: string,
    @Headers('x-correlation-id') correlationId?: string,
    @Res() res?: Response,
  ) {
    if (!idempotencyKeyHeader) {
      throw new BadRequestException("Header 'Idempotency-Key' is required for wagering transactions");
    }

    try {
      const result = await this.processWagerUseCase.execute(dto, {
        idempotencyKey: idempotencyKeyHeader,
        correlationId,
      });

      if (!res) {
        return result;
      }

      if (result.status === WagerTransactionStatus.Rejected) {
        return res.status(HttpStatus.UNPROCESSABLE_ENTITY).json({
          statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
          error: 'Unprocessable Entity',
          failureCode: result.failureCode,
          transactionId: result.transactionId,
          balance: result.balance,
          idempotentReplay: result.idempotentReplay,
        });
      }

      if (result.status === WagerTransactionStatus.PendingReference) {
        return res.status(HttpStatus.ACCEPTED).json(result);
      }

      if (result.idempotentReplay) {
        return res.status(HttpStatus.OK).json(result);
      }

      return res.status(HttpStatus.CREATED).json(result);
    } catch (error) {
      if (error instanceof IdempotencyPayloadMismatchError) {
        throw new ConflictException({
          statusCode: HttpStatus.CONFLICT,
          error: 'Conflict',
          message: error.message,
          failureCode: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
        });
      }
      if (error instanceof WalletNotFoundError) {
        throw new NotFoundException(error.message);
      }
      throw error;
    }
  }

  @Get('wagering/transactions/:transactionId')
  @ApiOperation({ summary: 'Get wagering transaction details by internal transactionId' })
  @ApiParam({ name: 'transactionId', description: 'Internal UUID of the transaction' })
  @ApiResponse({ status: 200, description: 'Transaction found' })
  @ApiResponse({ status: 404, description: 'Transaction not found' })
  async getById(@Param('transactionId') transactionId: string) {
    try {
      const tx = await this.getWagerUseCase.executeById(transactionId);
      return {
        id: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        playerId: tx.playerId,
        roundId: tx.roundId,
        gameId: tx.gameId,
        kind: tx.kind,
        money: tx.money.toJSON(),
        status: tx.status,
        failureCode: tx.failureCode,
        createdAt: tx.createdAt.toISOString(),
        processedAt: tx.processedAt?.toISOString(),
      };
    } catch (error) {
      if (error instanceof WagerTransactionNotFoundError) {
        throw new NotFoundException(error.message);
      }
      throw error;
    }
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  @ApiOperation({ summary: 'Get wagering transaction details by providerId and externalTransactionId' })
  @ApiParam({ name: 'providerId', description: 'Provider identifier' })
  @ApiParam({ name: 'externalTransactionId', description: 'Provider external transaction ID' })
  @ApiResponse({ status: 200, description: 'Transaction found' })
  @ApiResponse({ status: 404, description: 'Transaction not found' })
  async getByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    try {
      const tx = await this.getWagerUseCase.executeByExternalId(providerId, externalTransactionId);
      return {
        id: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        playerId: tx.playerId,
        roundId: tx.roundId,
        gameId: tx.gameId,
        kind: tx.kind,
        money: tx.money.toJSON(),
        status: tx.status,
        failureCode: tx.failureCode,
        createdAt: tx.createdAt.toISOString(),
        processedAt: tx.processedAt?.toISOString(),
      };
    } catch (error) {
      if (error instanceof WagerTransactionNotFoundError) {
        throw new NotFoundException(error.message);
      }
      throw error;
    }
  }
}
