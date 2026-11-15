import { Injectable, Inject, Logger } from '@nestjs/common';
import {
  WALLET_REPOSITORY_TOKEN,
  type WalletRepositoryPort,
} from '../../../wallet/application/ports/wallet.repository.port';
import {
  LEDGER_REPOSITORY_TOKEN,
  type LedgerRepositoryPort,
} from '../../../ledger/application/ports/ledger.repository.port';
import { ReconciliationResponseDto } from '../dtos/reconciliation-response.dto';
import { WalletNotFoundError } from '../../../wallet/domain/wallet.errors';
import { Money } from '../../../../shared/domain/value-objects/money.value-object';
import { LedgerDirection } from '../../../ledger/domain/ledger-direction.enum';

@Injectable()
export class ReconcileWalletUseCase {
  private readonly logger = new Logger(ReconcileWalletUseCase.name);

  constructor(
    @Inject(WALLET_REPOSITORY_TOKEN)
    private readonly walletRepository: WalletRepositoryPort,
    @Inject(LEDGER_REPOSITORY_TOKEN)
    private readonly ledgerRepository: LedgerRepositoryPort,
  ) {}

  async execute(walletId: string): Promise<ReconciliationResponseDto> {
    const wallet = await this.walletRepository.findById(walletId);
    if (!wallet) {
      throw new WalletNotFoundError(walletId);
    }

    // Retrieve all ledger entries for this wallet
    let allEntries: any[] = [];
    let cursor: string | undefined = undefined;
    let hasMore = true;

    while (hasMore) {
      const page = await this.ledgerRepository.findByWalletWithCursor({
        walletId,
        cursor,
        limit: 100,
      });
      allEntries.push(...page.items);
      hasMore = page.hasMore;
      cursor = page.nextCursor;
    }

    // Sort in chronological order (oldest first)
    allEntries.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    let calculatedBalance = Money.zero(wallet.currency);
    for (const entry of allEntries) {
      if (entry.direction === LedgerDirection.Credit) {
        calculatedBalance = calculatedBalance.add(entry.money);
      } else {
        calculatedBalance = calculatedBalance.subtract(entry.money);
      }
    }

    const storedBalance = wallet.balance;
    const difference = storedBalance.subtract(calculatedBalance);
    const consistent = difference.isZero();

    if (!consistent) {
      this.logger.warn(
        `🚨 FINANCIAL RECONCILIATION INCONSISTENCY DETECTED on wallet '${walletId}': ` +
          `storedBalance=${storedBalance.toString()}, calculatedBalance=${calculatedBalance.toString()}, ` +
          `difference=${difference.toString()}, checkedEntries=${allEntries.length}`,
      );
    } else {
      this.logger.log(
        `✅ Financial reconciliation consistent for wallet '${walletId}': ` +
          `balance=${storedBalance.toString()} ${wallet.currency}, checkedEntries=${allEntries.length}`,
      );
    }

    return {
      walletId,
      storedBalance: storedBalance.toJSON(),
      calculatedBalance: calculatedBalance.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: allEntries.length,
    };
  }
}
