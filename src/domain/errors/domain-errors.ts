export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';
}

export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';
}

export class InvalidTransactionError extends DomainError {
  readonly code = 'INVALID_TRANSACTION';
}

// erro de programação: tentar mexer numa transação que já está em estado terminal
export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';
}

export class LedgerImbalanceError extends DomainError {
  readonly code = 'LEDGER_IMBALANCE';
}

export class InvalidWalletError extends DomainError {
  readonly code = 'INVALID_WALLET';
}
