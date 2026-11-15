import { Module } from '@nestjs/common';
import { ReconciliationController } from './presentation/reconciliation.controller';
import { ReconcileWalletUseCase } from './application/use-cases/reconcile-wallet.use-case';
import { WalletModule } from '../wallet/wallet.module';
import { LedgerModule } from '../ledger/ledger.module';

@Module({
  imports: [WalletModule, LedgerModule],
  controllers: [ReconciliationController],
  providers: [ReconcileWalletUseCase],
  exports: [ReconcileWalletUseCase],
})
export class ReconciliationModule {}
