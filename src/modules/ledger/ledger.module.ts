import { Module } from '@nestjs/common';
import { LedgerController } from './presentation/ledger.controller';
import { GetWalletLedgerUseCase } from './application/use-cases/get-wallet-ledger.use-case';
import { LEDGER_REPOSITORY_TOKEN } from './application/ports/ledger.repository.port';
import { LedgerRepository } from './infrastructure/ledger.repository';

@Module({
  controllers: [LedgerController],
  providers: [
    GetWalletLedgerUseCase,
    {
      provide: LEDGER_REPOSITORY_TOKEN,
      useClass: LedgerRepository,
    },
  ],
  exports: [GetWalletLedgerUseCase, LEDGER_REPOSITORY_TOKEN],
})
export class LedgerModule {}
