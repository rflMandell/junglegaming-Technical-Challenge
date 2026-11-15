import { Injectable, Inject, BadRequestException } from '@nestjs/common';
import {
  WAGER_TRANSACTION_REPOSITORY_TOKEN,
  type WagerTransactionRepositoryPort,
} from '../ports/wager-transaction.repository.port';
import { ProcessWagerTransactionDto } from '../dtos/process-wager-transaction.dto';
import { ProcessWagerTransactionResponseDto } from '../dtos/wager-transaction-response.dto';
import { WagerTransactionKind } from '../../domain/wager-transaction-kind.enum';
import { computePayloadHash } from '../../../../shared/domain/utils/canonical-json.util';

export interface ProcessWagerTransactionContext {
  idempotencyKey?: string;
  correlationId?: string;
  inbox?: {
    consumerName: string;
    messageId: string;
  };
}

@Injectable()
export class ProcessWagerTransactionUseCase {
  constructor(
    @Inject(WAGER_TRANSACTION_REPOSITORY_TOKEN)
    private readonly wagerRepository: WagerTransactionRepositoryPort,
  ) {}

  async execute(
    dto: ProcessWagerTransactionDto,
    context?: ProcessWagerTransactionContext,
  ): Promise<ProcessWagerTransactionResponseDto> {
    // 1. OPENING is internal only and cannot be submitted via API or messaging
    if (dto.kind === WagerTransactionKind.Opening) {
      throw new BadRequestException('OPENING transaction is internal and cannot be submitted externally');
    }

    const idempotencyKey = context?.idempotencyKey || `${dto.providerId}:${dto.externalTransactionId}`;

    // 2. Compute canonical payload hash
    const payloadHash = computePayloadHash({
      providerId: dto.providerId,
      externalTransactionId: dto.externalTransactionId,
      playerId: dto.playerId,
      walletId: dto.walletId,
      roundId: dto.roundId,
      gameId: dto.gameId,
      kind: dto.kind,
      money: {
        amount: dto.money.amount,
        currency: dto.money.currency,
      },
      referenceExternalTransactionId: dto.referenceExternalTransactionId,
    });

    // 3. Execute transactional wager under PESSIMISTIC_WRITE lock on walletId
    return await this.wagerRepository.executeTransactionalWager({
      dto,
      idempotencyKey,
      payloadHash,
      correlationId: context?.correlationId,
      inbox: context?.inbox,
    });
  }
}
