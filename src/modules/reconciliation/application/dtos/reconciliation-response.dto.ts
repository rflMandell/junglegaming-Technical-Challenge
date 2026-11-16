import { ApiProperty } from '@nestjs/swagger';
import type { MoneyProps } from '../../../../shared/domain/value-objects/money.value-object';

export class ReconciliationMoneyDto implements MoneyProps {
  @ApiProperty({ description: 'Decimal string representation of money amount', example: '975.00' })
  amount!: string;

  @ApiProperty({ description: 'ISO 4217 currency code', example: 'BRL' })
  currency!: string;
}

export class ReconciliationResponseDto {
  @ApiProperty({ description: 'Wallet UUID', example: '0192f291-27dd-7d3f-8071-5f8685deef37' })
  walletId!: string;

  @ApiProperty({ description: 'Stored balance in the wallet aggregate', type: () => ReconciliationMoneyDto })
  storedBalance!: MoneyProps;

  @ApiProperty({ description: 'Reconstructed balance from all ledger entries', type: () => ReconciliationMoneyDto })
  calculatedBalance!: MoneyProps;

  @ApiProperty({ description: 'Difference between stored and calculated balance (stored - calculated)', type: () => ReconciliationMoneyDto })
  difference!: MoneyProps;

  @ApiProperty({ description: 'Indicates whether the stored balance matches the calculated balance exactly', example: true })
  consistent!: boolean;

  @ApiProperty({ description: 'Total number of ledger entries checked', example: 42 })
  checkedEntries!: number;
}

