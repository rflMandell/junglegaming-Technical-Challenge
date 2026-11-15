import { DomainError } from '../../../shared/domain/errors/domain.error';

export class WalletNotFoundError extends DomainError {
  constructor(walletId: string) {
    super(`Wallet with id '${walletId}' was not found`);
  }
}

export class WalletAlreadyExistsError extends DomainError {
  constructor(playerId: string, currency: string) {
    super(`Wallet already exists for player '${playerId}' and currency '${currency}'`);
  }
}
