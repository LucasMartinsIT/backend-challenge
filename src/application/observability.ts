import type { FailureCode } from '../domain/wagering/failure-code';

/** O que aconteceu com uma transação, sem nenhum valor monetário. */
export interface WagerHandledEvent {
  correlationId: string;
  messageId?: string | undefined;
  transactionId: string;
  walletId: string;
  providerId: string;
  kind: string;
  status: string;
  failureCode?: FailureCode | undefined;
  idempotentReplay: boolean;
  durationMs: number;
}

/**
 * Ganchos de observabilidade do caso de uso. São chamados depois do commit e nunca podem
 * quebrar o processamento: quem implementa não deve lançar.
 */
export interface WagerObserver {
  handled?(event: WagerHandledEvent): void;
  inboxDuplicate?(): void;
  /** Pedido recusado com erro tipado (conflito de idempotência, wallet inexistente...). */
  failed?(code: string): void;
}

export function safely(fn: (() => void) | undefined) {
  try {
    fn?.();
  } catch {
    // observabilidade nunca derruba o fluxo financeiro
  }
}
