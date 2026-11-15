import { IsNotEmpty, IsObject, IsString, IsUUID, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class MoneyDto {
  @ApiProperty({ description: 'Decimal string representation of money amount (e.g. "100.00")', example: '100.00' })
  @IsString()
  @IsNotEmpty()
  amount!: string;

  @ApiProperty({ description: 'ISO 4217 3-letter currency code', example: 'BRL' })
  @IsString()
  @IsNotEmpty()
  currency!: string;
}

export class CreateWalletDto {
  @ApiProperty({ description: 'Unique identifier of the player owning the wallet', example: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' })
  @IsUUID()
  @IsNotEmpty()
  playerId!: string;

  @ApiProperty({ description: 'Initial balance for the wallet', type: () => MoneyDto })
  @IsObject()
  @ValidateNested()
  @Type(() => MoneyDto)
  initialBalance!: MoneyDto;
}
