import type { IntegrationEvent } from '../events/integration-event';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date | undefined;
  publishedAt?: Date | undefined;
  failedAt?: Date | undefined;
}

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 60_000;

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
    private _failedAt?: Date,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      event.toJSON() as unknown as Record<string, unknown>,
      event.occurredAt,
      0,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
      state.failedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  get failedAt(): Date | undefined {
    return this._failedAt;
  }

  /** Pendente = ainda precisa ser entregue. Publicada e abandonada não são. */
  isPending(): boolean {
    return this._publishedAt === undefined && this._failedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt <= now);
  }

  markPublished(at: Date): void {
    this._publishedAt = at;
  }

  /** Desiste da entrega (esgotou as tentativas). Fica gravada para auditoria e sai da fila. */
  markFailed(at: Date): void {
    this._failedAt = at;
  }

  /** Segura a mensagem sem contar tentativa: usada quando um evento anterior da mesma wallet falhou. */
  postpone(until: Date): void {
    this._nextAttemptAt = until;
  }

  /** Backoff exponencial: 1s, 2s, 4s... limitado a 60s. */
  scheduleRetry(now: Date): void {
    const delay = Math.min(BASE_DELAY_MS * 2 ** this._attempts, MAX_DELAY_MS);
    this._attempts += 1;
    this._nextAttemptAt = new Date(now.getTime() + delay);
  }
}
