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
import type { Response } from 'express';
import { ProcessWagerTransactionDto } from '../application/dtos/process-wager-transaction.dto';
import { ProcessWagerTransactionUseCase } from '../application/use-cases/process-wager-transaction.use-case';
import { GetWagerTransactionUseCase } from '../application/use-cases/get-wager-transaction.use-case';
import { IdempotencyPayloadMismatchError, WagerTransactionNotFoundError } from '../domain/wagering.errors';
import { WalletNotFoundError } from '../../wallet/domain/wallet.errors';
import { WagerTransactionStatus } from '../domain/wager-transaction-status.enum';

@Controller()
export class WageringController {
  constructor(
    private readonly processWagerUseCase: ProcessWagerTransactionUseCase,
    private readonly getWagerUseCase: GetWagerTransactionUseCase,
  ) {}

  @Post('wagering/transactions')
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
        throw new ConflictException(error.message);
      }
      if (error instanceof WalletNotFoundError) {
        throw new NotFoundException(error.message);
      }
      throw error;
    }
  }

  @Get('wagering/transactions/:transactionId')
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
