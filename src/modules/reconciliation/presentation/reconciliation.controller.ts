import { Controller, Post, Param, NotFoundException, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ReconcileWalletUseCase } from '../application/use-cases/reconcile-wallet.use-case';
import { WalletNotFoundError } from '../../wallet/domain/wallet.errors';

@ApiTags('Reconciliation')
@Controller('wallets')
export class ReconciliationController {
  constructor(private readonly reconcileWalletUseCase: ReconcileWalletUseCase) {}

  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reconcile wallet stored balance against reconstructed ledger sum' })
  @ApiResponse({ status: 200, description: 'Reconciliation report returned successfully' })
  @ApiResponse({ status: 404, description: 'Wallet not found' })
  async reconcile(@Param('walletId') walletId: string) {
    try {
      return await this.reconcileWalletUseCase.execute(walletId);
    } catch (error) {
      if (error instanceof WalletNotFoundError) {
        throw new NotFoundException(error.message);
      }
      throw error;
    }
  }
}
