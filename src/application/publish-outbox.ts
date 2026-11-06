import type { OutboxMessage } from '../domain/messaging/outbox-message';
import type { EventPublisher, UnitOfWork } from './ports';
import type { Clock } from './support';

export interface PublishOutboxOptions {
  batchSize: number;
  /** Depois de tantas falhas o evento é abandonado (fica gravado em failed_at). */
  maxAttempts: number;
  /** Chamado quando um evento é abandonado, para log e métrica. */
  onAbandoned?: (message: OutboxMessage) => void;
}

export const DEFAULT_OUTBOX_OPTIONS: PublishOutboxOptions = { batchSize: 50, maxAttempts: 20 };

// se a conexão sumir no meio do envio, o Postgres derruba a sessão e libera as linhas
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 30_000;

/**
 * Lê eventos pendentes da outbox e os entrega ao destino. Vários publicadores podem rodar ao
 * mesmo tempo: o SKIP LOCKED faz cada um pegar um conjunto diferente de linhas.
 *
 * A entrega é at-least-once. Se o processo morrer depois de enviar e antes do commit, outra
 * instância reenvia; o destino (SQS FIFO com MessageDeduplicationId = eventId) e o consumidor
 * precisam tolerar a duplicata.
 *
 * Ordem: dentro de um lote, os eventos de uma mesma wallet saem em sequência e, se um falha, os
 * seguintes esperam. Entre publicadores diferentes a ordem não é garantida; o envelope traz
 * `walletVersion` e `eventId` para o consumidor ordenar e deduplicar.
 */
export class PublishOutbox {
  constructor(
    private readonly deps: { uow: UnitOfWork; publisher: EventPublisher; clock: Clock },
    private readonly options: PublishOutboxOptions = DEFAULT_OUTBOX_OPTIONS,
  ) {}

  /** Devolve quantas mensagens foram tentadas (0 = nada a fazer). */
  runOnce(): Promise<number> {
    const { uow, publisher, clock } = this.deps;

    return uow.run(
      async (repos) => {
        const batch = await repos.outbox.lockDue(clock.now(), this.options.batchSize);
        if (batch.length === 0) return 0;

        const byAggregate = new Map<string, OutboxMessage[]>();
        for (const message of batch) {
          byAggregate.set(message.aggregateId, [...(byAggregate.get(message.aggregateId) ?? []), message]);
        }

        // wallets diferentes em paralelo; eventos da mesma wallet um de cada vez
        await Promise.all(
          [...byAggregate.values()].map(async (group) => {
            for (const [i, message] of group.entries()) {
              let delivered = true;
              try {
                await publisher.publish(message);
              } catch {
                delivered = false;
              }

              if (delivered) {
                message.markPublished(clock.now());
                continue;
              }

              const now = clock.now();
              message.scheduleRetry(now);
              if (message.attempts >= this.options.maxAttempts) {
                message.markFailed(now);
                this.options.onAbandoned?.(message);
              } else {
                // os seguintes da mesma wallet esperam este, sem gastar tentativa deles
                for (const later of group.slice(i + 1)) later.postpone(message.nextAttemptAt!);
              }
              return;
            }
          }),
        );

        for (const message of batch) await repos.outbox.save(message);
        return batch.length;
      },
      { idleInTransactionTimeoutMs: IDLE_IN_TRANSACTION_TIMEOUT_MS },
    );
  }
}
