import { z } from 'zod';
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  InboxPayloadMismatchError,
  WalletNotFoundError,
} from '../../application/errors';
import type { SubmitWagerCommand, SubmitWagerResult } from '../../application/submit-wager-transaction';
import { InvalidMoneyError, InvalidTransactionError } from '../../domain/errors/domain-errors';
import { canonicalJson } from '../../domain/wagering/payload-hash';
import { WagerTransactionKind } from '../../domain/wagering/wager-transaction';
import { safeErrorSummary } from '../../infrastructure/observability/safe-error';
import { isTransientInfraError } from '../../infrastructure/persistence/transient-errors';

export const WAGER_CONSUMER_NAME = 'wager-transactions';

export type MessageDecision =
  // ack: mensagem tratada (aplicada, rejeitada por regra, duplicada ou erro de negócio terminal)
  | { action: 'ack'; outcome: 'processed' | 'replay' | 'rejected' | 'pending' | 'business-error'; messageId?: string; detail?: string }
  // retry: falha transitória; a mensagem volta à fila com backoff e a fila conta as tentativas
  | { action: 'retry'; reason: string; messageId?: string }
  // dead-letter: mensagem que nunca vai funcionar; vai para a DLQ com o motivo
  | { action: 'dead-letter'; reason: string; messageId?: string };

const envelopeSchema = z.object({
  messageId: z.string().min(1).max(128),
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.string(),
  data: z.object({
    providerId: z.string().min(1).max(128),
    externalTransactionId: z.string().min(1).max(128),
    idempotencyKey: z.string().min(1).max(255),
    playerId: z.string().min(1).max(128),
    walletId: z.guid(),
    roundId: z.string().min(1).max(128),
    gameId: z.string().min(1).max(128),
    kind: z.enum(WagerTransactionKind),
    money: z.object({ amount: z.string(), currency: z.string() }),
    referenceExternalTransactionId: z.string().min(1).max(128).optional(),
  }),
});

interface Submitter {
  execute(cmd: SubmitWagerCommand): Promise<SubmitWagerResult>;
}

/**
 * Traduz uma mensagem SQS em uma chamada ao MESMO use case da API HTTP e classifica o
 * resultado. Não conhece SQS: quem consome decide o que fazer com a decisão.
 */
export class WagerMessageHandler {
  constructor(private readonly submit: Submitter) {}

  async handle(rawBody: string): Promise<MessageDecision> {
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      return { action: 'dead-letter', reason: 'INVALID_JSON' };
    }

    const parsed = envelopeSchema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return { action: 'dead-letter', reason: `INVALID_MESSAGE: ${issue?.path.join('.')}: ${issue?.message}` };
    }
    const { messageId, data } = parsed.data;

    try {
      const result = await this.submit.execute({
        ...data,
        correlationId: messageId,
        inbox: {
          consumerName: WAGER_CONSUMER_NAME,
          messageId,
          // o conteúdo de negócio, em JSON canônico: mesma mensagem => mesmo hash
          payloadHash: new Bun.CryptoHasher('sha256').update(canonicalJson(data)).digest('hex'),
        },
      });
      const outcome = result.idempotentReplay
        ? 'replay'
        : result.status === 'REJECTED' || result.status === 'FAILED'
          ? 'rejected'
          : result.status === 'PENDING_REFERENCE'
            ? 'pending'
            : 'processed';
      return { action: 'ack', outcome, messageId };
    } catch (err) {
      return { ...classify(err), messageId };
    }
  }
}

function classify(err: unknown): MessageDecision {
  // payload que nunca vai ser aceito, não importa quantas vezes tentem
  if (
    err instanceof InvalidMoneyError ||
    err instanceof InvalidTransactionError ||
    err instanceof InboxPayloadMismatchError
  ) {
    // a mensagem de InvalidMoneyError carrega o valor recebido; no motivo vai só o código
    const detail = err instanceof InvalidMoneyError ? '' : `: ${err.message}`;
    return { action: 'dead-letter', reason: `${err.code}${detail}` };
  }
  // erro de negócio terminal: repetir não muda o resultado, então confirma e segue
  if (
    err instanceof IdempotencyConflictError ||
    err instanceof ExternalTransactionConflictError ||
    err instanceof WalletNotFoundError
  ) {
    return { action: 'ack', outcome: 'business-error', detail: err.code };
  }
  if (isTransientInfraError(err)) {
    return { action: 'retry', reason: `TRANSIENT: ${safeErrorSummary(err)}` };
  }
  // falha inesperada: tenta de novo; o limite de recebimentos da fila leva para a DLQ
  return { action: 'retry', reason: `UNEXPECTED: ${safeErrorSummary(err)}` };
}
