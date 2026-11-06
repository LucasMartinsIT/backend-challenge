// Códigos estáveis e legíveis por máquina. O comentário diz o que o provedor deve fazer.
export enum FailureCode {
  // reenviar não adianta enquanto o saldo não mudar
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  // a reversão deixaria o saldo negativo; diferente de aposta sem saldo
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  // corrigir o payload
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  WalletNotFound = 'WALLET_NOT_FOUND',
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  // referência nunca apareceu depois de todas as tentativas
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  ReferenceKindNotAllowed = 'REFERENCE_KIND_NOT_ALLOWED',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  // FAILED: erro permanente de infraestrutura, fica só para auditoria
  InternalPermanentError = 'INTERNAL_PERMANENT_ERROR',
}
