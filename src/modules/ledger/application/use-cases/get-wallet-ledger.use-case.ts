import { Injectable, Inject } from '@nestjs/common';
import {
  LEDGER_REPOSITORY_TOKEN,
  type LedgerRepositoryPort,
  type GetLedgerQuery,
} from '../ports/ledger.repository.port';
import { MoneyProps } from '../../../../shared/domain/value-objects/money.value-object';
import { LedgerDirection } from '../../domain/ledger-direction.enum';

export interface LedgerEntryResponseDto {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface PaginatedLedgerResponseDto {
  items: LedgerEntryResponseDto[];
  nextCursor?: string;
  hasMore: boolean;
}

@Injectable()
export class GetWalletLedgerUseCase {
  constructor(
    @Inject(LEDGER_REPOSITORY_TOKEN)
    private readonly ledgerRepository: LedgerRepositoryPort,
  ) {}

  async execute(query: GetLedgerQuery): Promise<PaginatedLedgerResponseDto> {
    const result = await this.ledgerRepository.findByWalletWithCursor(query);

    return {
      items: result.items.map((entry) => ({
        id: entry.id,
        walletId: entry.walletId,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        createdAt: entry.createdAt.toISOString(),
      })),
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    };
  }
}
