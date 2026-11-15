import { Module } from '@nestjs/common';
import { WageringController } from './presentation/wagering.controller';
import { ProcessWagerTransactionUseCase } from './application/use-cases/process-wager-transaction.use-case';
import { GetWagerTransactionUseCase } from './application/use-cases/get-wager-transaction.use-case';
import { WAGER_TRANSACTION_REPOSITORY_TOKEN } from './application/ports/wager-transaction.repository.port';
import { WagerTransactionRepository } from './infrastructure/wager-transaction.repository';
import { WalletModule } from '../wallet/wallet.module';

@Module({
  imports: [WalletModule],
  controllers: [WageringController],
  providers: [
    ProcessWagerTransactionUseCase,
    GetWagerTransactionUseCase,
    {
      provide: WAGER_TRANSACTION_REPOSITORY_TOKEN,
      useClass: WagerTransactionRepository,
    },
  ],
  exports: [
    ProcessWagerTransactionUseCase,
    GetWagerTransactionUseCase,
    WAGER_TRANSACTION_REPOSITORY_TOKEN,
  ],
})
export class WageringModule {}
