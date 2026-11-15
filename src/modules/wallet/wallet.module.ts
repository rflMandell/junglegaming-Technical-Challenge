import { Module } from '@nestjs/common';
import { WalletController } from './presentation/wallet.controller';
import { CreateWalletUseCase } from './application/use-cases/create-wallet.use-case';
import { GetWalletUseCase } from './application/use-cases/get-wallet.use-case';
import { DebitWalletUseCase } from './application/use-cases/debit-wallet.use-case';
import { CreditWalletUseCase } from './application/use-cases/credit-wallet.use-case';
import { WALLET_REPOSITORY_TOKEN } from './application/ports/wallet.repository.port';
import { WalletRepository } from './infrastructure/wallet.repository';

@Module({
  controllers: [WalletController],
  providers: [
    CreateWalletUseCase,
    GetWalletUseCase,
    DebitWalletUseCase,
    CreditWalletUseCase,
    {
      provide: WALLET_REPOSITORY_TOKEN,
      useClass: WalletRepository,
    },
  ],
  exports: [
    CreateWalletUseCase,
    GetWalletUseCase,
    DebitWalletUseCase,
    CreditWalletUseCase,
    WALLET_REPOSITORY_TOKEN,
  ],
})
export class WalletModule {}
