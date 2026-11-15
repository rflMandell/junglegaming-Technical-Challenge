import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  HttpCode,
  HttpStatus,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { CreateWalletDto } from '../application/dtos/create-wallet.dto';
import { CreateWalletUseCase } from '../application/use-cases/create-wallet.use-case';
import { GetWalletUseCase } from '../application/use-cases/get-wallet.use-case';
import { WalletAlreadyExistsError, WalletNotFoundError } from '../domain/wallet.errors';
import { InvalidMoneyError } from '../../../shared/domain/errors/domain.error';

@ApiTags('Wallets')
@Controller('wallets')
export class WalletController {
  constructor(
    private readonly createWalletUseCase: CreateWalletUseCase,
    private readonly getWalletUseCase: GetWalletUseCase,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new player wallet with initial opening balance' })
  @ApiResponse({ status: 201, description: 'Wallet created successfully' })
  @ApiResponse({ status: 400, description: 'Invalid payload or monetary amount' })
  @ApiResponse({ status: 409, description: 'Wallet already exists for player' })
  async create(@Body() dto: CreateWalletDto) {
    try {
      return await this.createWalletUseCase.execute(dto);
    } catch (error) {
      if (error instanceof WalletAlreadyExistsError) {
        throw new ConflictException(error.message);
      }
      if (error instanceof InvalidMoneyError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  @Get(':walletId')
  @ApiOperation({ summary: 'Get current wallet balance and state by walletId' })
  @ApiParam({ name: 'walletId', description: 'UUID of the wallet', type: 'string' })
  @ApiResponse({ status: 200, description: 'Wallet retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Wallet not found' })
  async getById(@Param('walletId') walletId: string) {
    try {
      return await this.getWalletUseCase.execute(walletId);
    } catch (error) {
      if (error instanceof WalletNotFoundError) {
        throw new NotFoundException(error.message);
      }
      throw error;
    }
  }
}
