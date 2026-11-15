import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiQuery } from '@nestjs/swagger';
import { GetWalletLedgerUseCase } from '../application/use-cases/get-wallet-ledger.use-case';

@ApiTags('Ledger')
@Controller('wallets')
export class LedgerController {
  constructor(private readonly getWalletLedgerUseCase: GetWalletLedgerUseCase) {}

  @Get(':walletId/ledger')
  @ApiOperation({ summary: 'Get paginated immutable financial ledger entries for a wallet' })
  @ApiParam({ name: 'walletId', description: 'UUID of the wallet', type: 'string' })
  @ApiQuery({ name: 'cursor', required: false, description: 'Opaque base64 cursor for pagination', type: 'string' })
  @ApiQuery({ name: 'limit', required: false, description: 'Number of entries to fetch (max 100, default 50)', type: 'number' })
  @ApiResponse({ status: 200, description: 'Ledger page retrieved successfully' })
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
