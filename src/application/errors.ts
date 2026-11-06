export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends ApplicationError {
  readonly code = 'VALIDATION_ERROR';
}

export class WalletNotFoundError extends ApplicationError {
  readonly code = 'WALLET_NOT_FOUND';
  constructor(walletId: string) {
    super(`wallet ${walletId} não encontrada`);
  }
}

export class TransactionNotFoundError extends ApplicationError {
  readonly code = 'TRANSACTION_NOT_FOUND';
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';
}

// mesma Idempotency-Key com payload diferente: conflito, não replay
export class IdempotencyConflictError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_CONFLICT';
}

// mesmo (provider, externalTransactionId) chegando com outra Idempotency-Key
export class ExternalTransactionConflictError extends ApplicationError {
  readonly code = 'EXTERNAL_TRANSACTION_CONFLICT';
}

// mesma mensagem (consumer + messageId) chegando com conteúdo diferente: erro permanente
export class InboxPayloadMismatchError extends ApplicationError {
  readonly code = 'INBOX_PAYLOAD_MISMATCH';
}

export class InvalidCursorError extends ApplicationError {
  readonly code = 'INVALID_CURSOR';
}
