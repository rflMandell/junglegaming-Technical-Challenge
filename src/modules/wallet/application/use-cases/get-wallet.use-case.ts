import { Injectable, Inject } from '@nestjs/common';
import {
  WALLET_REPOSITORY_TOKEN,
  type WalletRepositoryPort,
} from '../ports/wallet.repository.port';
import { WalletResponseDto, toWalletResponseDto } from '../dtos/wallet-response.dto';
import { WalletNotFoundError } from '../../domain/wallet.errors';

@Injectable()
export class GetWalletUseCase {
  constructor(
    @Inject(WALLET_REPOSITORY_TOKEN)
    private readonly walletRepository: WalletRepositoryPort,
  ) {}

  async execute(walletId: string): Promise<WalletResponseDto> {
    const wallet = await this.walletRepository.findById(walletId);
    if (!wallet) {
      throw new WalletNotFoundError(walletId);
    }
    return toWalletResponseDto(wallet);
  }
}
