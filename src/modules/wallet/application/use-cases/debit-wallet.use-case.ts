import { Injectable, Inject } from '@nestjs/common';
import {
  WALLET_REPOSITORY_TOKEN,
  type WalletRepositoryPort,
} from '../ports/wallet.repository.port';
import { Money } from '../../../../shared/domain/value-objects/money.value-object';
import { Wallet } from '../../domain/wallet.aggregate';
import { WalletLedgerEntry } from '../../../ledger/domain/wallet-ledger-entry.entity';
import { WalletBalanceChanged } from '../../domain/events/wallet-balance-changed.event';

export interface DebitWalletCommand {
  walletId: string;
  amount: Money;
  transactionId: string;
  correlationId?: string;
}

@Injectable()
export class DebitWalletUseCase {
  constructor(
    @Inject(WALLET_REPOSITORY_TOKEN)
    private readonly walletRepository: WalletRepositoryPort,
  ) {}

  async execute(command: DebitWalletCommand): Promise<{
    wallet: Wallet;
    entry: WalletLedgerEntry;
    event: WalletBalanceChanged;
  }> {
    return await this.walletRepository.debitWithLock(
      command.walletId,
      command.amount,
      command.transactionId,
      command.correlationId,
    );
  }
}
