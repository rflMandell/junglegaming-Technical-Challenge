import { Controller, Get, Param, Query } from '@nestjs/common';
import { GetWalletLedgerUseCase } from '../application/use-cases/get-wallet-ledger.use-case';

@Controller('wallets')
export class LedgerController {
  constructor(private readonly getWalletLedgerUseCase: GetWalletLedgerUseCase) {}

  @Get(':walletId/ledger')
  async getLedger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedLimit = limit ? parseInt(limit, 10) : 50;
    return await this.getWalletLedgerUseCase.execute({
      walletId,
      cursor,
      limit: parsedLimit,
    });
  }
}
