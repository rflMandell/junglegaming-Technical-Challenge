import { Injectable, Inject } from '@nestjs/common';
import {
  WAGER_TRANSACTION_REPOSITORY_TOKEN,
  type WagerTransactionRepositoryPort,
} from '../ports/wager-transaction.repository.port';
import { WagerTransaction } from '../../domain/wager-transaction.entity';
import { WagerTransactionNotFoundError } from '../../domain/wagering.errors';

@Injectable()
export class GetWagerTransactionUseCase {
  constructor(
    @Inject(WAGER_TRANSACTION_REPOSITORY_TOKEN)
    private readonly wagerRepository: WagerTransactionRepositoryPort,
  ) {}

  async executeById(id: string): Promise<WagerTransaction> {
    const tx = await this.wagerRepository.findById(id);
    if (!tx) {
      throw new WagerTransactionNotFoundError(id);
    }
    return tx;
  }

  async executeByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction> {
    const tx = await this.wagerRepository.findByExternalId(providerId, externalTransactionId);
    if (!tx) {
      throw new WagerTransactionNotFoundError(`${providerId}:${externalTransactionId}`);
    }
    return tx;
  }
}
