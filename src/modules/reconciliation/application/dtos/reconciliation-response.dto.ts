import { MoneyProps } from '../../../../shared/domain/value-objects/money.value-object';

export interface ReconciliationResponseDto {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}
