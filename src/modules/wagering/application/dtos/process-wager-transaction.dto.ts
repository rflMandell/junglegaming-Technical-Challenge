import { IsNotEmpty, IsObject, IsOptional, IsString, IsUUID, ValidateNested, IsEnum } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WagerTransactionKind } from '../../domain/wager-transaction-kind.enum';
import { MoneyDto } from '../../../wallet/application/dtos/create-wallet.dto';

export class ProcessWagerTransactionDto {
  @ApiProperty({ description: 'Unique identifier of the gaming provider', example: 'provider-1' })
  @IsString()
  @IsNotEmpty()
  providerId!: string;

  @ApiProperty({ description: 'Provider-specific transaction ID', example: 'tx-ext-001' })
  @IsString()
  @IsNotEmpty()
  externalTransactionId!: string;

  @ApiProperty({ description: 'Player UUID', example: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' })
  @IsUUID()
  @IsNotEmpty()
  playerId!: string;

  @ApiProperty({ description: 'Wallet UUID', example: 'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22' })
  @IsUUID()
  @IsNotEmpty()
  walletId!: string;

  @ApiProperty({ description: 'Game round identifier', example: 'round-100' })
  @IsString()
  @IsNotEmpty()
  roundId!: string;

  @ApiProperty({ description: 'Game identifier', example: 'game-roulette' })
  @IsString()
  @IsNotEmpty()
  gameId!: string;

  @ApiProperty({ enum: WagerTransactionKind, description: 'Transaction kind', example: WagerTransactionKind.Bet })
  @IsEnum(WagerTransactionKind)
  kind!: WagerTransactionKind;

  @ApiProperty({ description: 'Monetary amount and currency', type: () => MoneyDto })
  @IsObject()
  @ValidateNested()
  @Type(() => MoneyDto)
  money!: MoneyDto;

  @ApiPropertyOptional({
    description: 'Reference to an earlier external transaction ID (mandatory for WIN, LOSS, REFUND, ROLLBACK)',
    example: 'tx-ext-001',
  })
  @IsString()
  @IsOptional()
  referenceExternalTransactionId?: string;
}
