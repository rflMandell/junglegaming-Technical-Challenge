import { Injectable, Inject } from '@nestjs/common';
import {
  WALLET_REPOSITORY_TOKEN,
  type WalletRepositoryPort,
} from '../ports/wallet.repository.port';
import { Money } from '../../../../shared/domain/value-objects/money.value-object';
import { Wallet } from '../../domain/wallet.aggregate';
import { WalletLedgerEntry } from '../../../ledger/domain/wallet-ledger-entry.entity';
import { WalletBalanceChanged } from '../../domain/events/wallet-balance-changed.event';

export interface CreditWalletCommand {
  walletId: string;
  amount: Money;
  transactionId: string;
  correlationId?: string;
}

@Injectable()
export class CreditWalletUseCase {
  constructor(
    @Inject(WALLET_REPOSITORY_TOKEN)
    private readonly walletRepository: WalletRepositoryPort,
  ) {}

  async execute(command: CreditWalletCommand): Promise<{
    wallet: Wallet;
    entry: WalletLedgerEntry;
    event: WalletBalanceChanged;
  }> {
    return await this.walletRepository.creditWithLock(
      command.walletId,
      command.amount,
      command.transactionId,
      command.correlationId,
    );
  }
}
