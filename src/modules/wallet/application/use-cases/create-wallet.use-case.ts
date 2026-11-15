import { Injectable, Inject } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import {
  WALLET_REPOSITORY_TOKEN,
  type WalletRepositoryPort,
} from '../ports/wallet.repository.port';
import { CreateWalletDto } from '../dtos/create-wallet.dto';
import { WalletResponseDto, toWalletResponseDto } from '../dtos/wallet-response.dto';
import { Wallet } from '../../domain/wallet.aggregate';
import { Money } from '../../../../shared/domain/value-objects/money.value-object';
import { WalletAlreadyExistsError } from '../../domain/wallet.errors';
import { WagerTransaction } from '../../../wagering/domain/wager-transaction.entity';
import { WagerTransactionKind } from '../../../wagering/domain/wager-transaction-kind.enum';
import { WalletBalanceChanged } from '../../domain/events/wallet-balance-changed.event';

@Injectable()
export class CreateWalletUseCase {
  constructor(
    @Inject(WALLET_REPOSITORY_TOKEN)
    private readonly walletRepository: WalletRepositoryPort,
  ) {}

  async execute(dto: CreateWalletDto): Promise<WalletResponseDto> {
    const initialMoney = Money.from(dto.initialBalance);

    // 1. Invariant: One wallet per playerId + currency
    const existingWallet = await this.walletRepository.findByPlayerAndCurrency(
      dto.playerId,
      initialMoney.currency,
    );
    if (existingWallet) {
      throw new WalletAlreadyExistsError(dto.playerId, initialMoney.currency);
    }

    const walletId = uuidv7();
    const openingTxId = uuidv7();
    const openingEntryId = uuidv7();

    let openingTx: WagerTransaction | undefined;
    if (initialMoney.isPositive()) {
      openingTx = WagerTransaction.create({
        id: openingTxId,
        providerId: 'system',
        externalTransactionId: `opening-${walletId}`,
        idempotencyKey: `system:opening-${walletId}`,
        payloadHash: `opening-${walletId}`,
        walletId,
        playerId: dto.playerId,
        roundId: 'opening',
        gameId: 'opening',
        kind: WagerTransactionKind.Opening,
        money: initialMoney,
      });
      openingTx.markProcessed(undefined, new Date());
    }

    const { wallet, entry } = Wallet.open({
      id: walletId,
      playerId: dto.playerId,
      initialBalance: initialMoney,
      openingTransactionId: openingTxId,
      openingEntryId,
    });

    let outboxEvent: WalletBalanceChanged | undefined;
    if (entry) {
      outboxEvent = WalletBalanceChanged.from(wallet, entry);
    }

    await this.walletRepository.save(wallet, entry, outboxEvent, openingTx);

    return toWalletResponseDto(wallet);
  }
}
