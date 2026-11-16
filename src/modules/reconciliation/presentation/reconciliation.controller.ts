import { Controller, Post, Get, Param, NotFoundException, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { ReconcileWalletUseCase } from '../application/use-cases/reconcile-wallet.use-case';
import { ReconciliationResponseDto } from '../application/dtos/reconciliation-response.dto';
import { WalletNotFoundError } from '../../wallet/domain/wallet.errors';

@ApiTags('Reconciliation')
@Controller('wallets')
export class ReconciliationController {
  constructor(private readonly reconcileWalletUseCase: ReconcileWalletUseCase) {}

  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reconcile wallet stored balance against reconstructed ledger sum' })
  @ApiParam({ name: 'walletId', description: 'Wallet UUID to reconcile' })
  @ApiResponse({ status: 200, description: 'Reconciliation report returned successfully', type: ReconciliationResponseDto })
  @ApiResponse({ status: 404, description: 'Wallet not found' })
  async reconcile(@Param('walletId') walletId: string): Promise<ReconciliationResponseDto> {
    try {
      return await this.reconcileWalletUseCase.execute(walletId);
    } catch (error) {
      if (error instanceof WalletNotFoundError) {
        throw new NotFoundException(error.message);
      }
      throw error;
    }
  }

  @Get(':walletId/reconciliation')
  @ApiOperation({ summary: 'Read-only audit reconciliation of wallet balance against ledger' })
  @ApiParam({ name: 'walletId', description: 'Wallet UUID to reconcile' })
  @ApiResponse({ status: 200, description: 'Reconciliation report returned successfully', type: ReconciliationResponseDto })
  @ApiResponse({ status: 404, description: 'Wallet not found' })
  async getReconciliation(@Param('walletId') walletId: string): Promise<ReconciliationResponseDto> {
    return this.reconcile(walletId);
  }
}

