import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Um Registry por instância da aplicação (e não o global), para que testes que sobem várias
 * aplicações no mesmo processo não colidam.
 */
export class Metrics {
  readonly registry = new Registry();

  readonly transactions = new Counter({
    name: 'wager_transactions_total',
    help: 'Transações tratadas, por status final e tipo',
    labelNames: ['status', 'kind'],
    registers: [this.registry],
  });

  readonly idempotentReplays = new Counter({
    name: 'idempotent_replays_total',
    help: 'Requisições repetidas respondidas com o resultado original',
    registers: [this.registry],
  });

  readonly inboxDuplicates = new Counter({
    name: 'inbox_duplicates_total',
    help: 'Mensagens SQS já vistas pela inbox',
    registers: [this.registry],
  });

  readonly requestErrors = new Counter({
    name: 'wager_request_errors_total',
    help: 'Pedidos recusados com erro tipado (conflito, wallet inexistente...)',
    labelNames: ['code'],
    registers: [this.registry],
  });

  readonly sqsRetries = new Counter({
    name: 'sqs_retries_total',
    help: 'Mensagens devolvidas à fila para nova tentativa',
    registers: [this.registry],
  });

  readonly sqsDeadLetters = new Counter({
    name: 'sqs_dlq_total',
    help: 'Mensagens enviadas à DLQ pelo consumidor',
    labelNames: ['reason'],
    registers: [this.registry],
  });

  readonly sqsAcks = new Counter({
    name: 'sqs_acks_total',
    help: 'Mensagens confirmadas, por resultado',
    labelNames: ['outcome'],
    registers: [this.registry],
  });

  readonly lockConflicts = new Counter({
    name: 'lock_conflicts_total',
    help: 'Deadlocks, falhas de serialização e lock timeouts que causaram nova tentativa',
    labelNames: ['code'],
    registers: [this.registry],
  });

  readonly outboxPublished = new Counter({
    name: 'outbox_published_total',
    help: 'Eventos da outbox entregues ao destino',
    registers: [this.registry],
  });

  readonly outboxPublishFailures = new Counter({
    name: 'outbox_publish_failures_total',
    help: 'Tentativas de publicar que falharam',
    registers: [this.registry],
  });

  readonly outboxAbandoned = new Counter({
    name: 'outbox_abandoned_total',
    help: 'Eventos abandonados depois de esgotar as tentativas',
    registers: [this.registry],
  });

  readonly pendingReferenceResolutions = new Counter({
    name: 'pending_reference_resolutions_total',
    help: 'Transações pendentes de referência que chegaram a um estado final',
    labelNames: ['status'],
    registers: [this.registry],
  });

  readonly reconciliationMismatches = new Counter({
    name: 'reconciliation_mismatches_total',
    help: 'Reconciliações que encontraram saldo divergente do ledger',
    registers: [this.registry],
  });

  readonly processingSeconds = new Histogram({
    name: 'wager_processing_seconds',
    help: 'Latência do processamento de uma transação, do pedido ao commit',
    labelNames: ['kind'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  readonly outboxLagSeconds = new Gauge({
    name: 'outbox_lag_seconds',
    help: 'Idade do evento pendente mais antigo da outbox',
    registers: [this.registry],
  });

  readonly outboxPending = new Gauge({
    name: 'outbox_pending',
    help: 'Eventos esperando publicação',
    registers: [this.registry],
  });

  readonly outboxFailed = new Gauge({
    name: 'outbox_failed',
    help: 'Eventos abandonados que continuam gravados para auditoria',
    registers: [this.registry],
  });

  constructor(options: { defaultMetrics?: boolean } = {}) {
    if (options.defaultMetrics) collectDefaultMetrics({ register: this.registry });
  }

  /**
   * As gauges da outbox são lidas do banco no momento do scrape. `read` pode ser cacheado por
   * quem chama, para não consultar duas vezes por scrape.
   */
  bindOutboxGauges(read: () => Promise<{ pending: number; oldestAgeSeconds: number; failed: number }>) {
    const apply = async (set: (s: Awaited<ReturnType<typeof read>>) => void) => {
      try {
        set(await read());
      } catch {
        // sem banco, a gauge simplesmente mantém o último valor
      }
    };
    const { outboxLagSeconds, outboxPending, outboxFailed } = this;
    Object.assign(outboxLagSeconds, {
      collect: () => apply((s) => outboxLagSeconds.set(s.oldestAgeSeconds)),
    });
    Object.assign(outboxPending, { collect: () => apply((s) => outboxPending.set(s.pending)) });
    Object.assign(outboxFailed, { collect: () => apply((s) => outboxFailed.set(s.failed)) });
  }
}
