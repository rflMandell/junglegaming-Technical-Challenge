import { MoneyProps } from '../../../../shared/domain/value-objects/money.value-object';
import { WagerTransactionStatus } from '../../domain/wager-transaction-status.enum';
import { FailureCode } from '../../domain/failure-code.enum';

export interface ProcessWagerTransactionResponseDto {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}
