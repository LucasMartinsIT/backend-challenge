import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { Logger } from '@nestjs/common';
import { safeErrorSummary } from '../../infrastructure/observability/safe-error';
import type { MessageDecision } from './wager-message-handler';

export interface ConsumerObserver {
  onAck?(outcome: string): void;
  onRetry?(): void;
  onDeadLetter?(reason: string): void;
}

export interface ConsumerOptions {
  queueUrl: string;
  dlqUrl: string;
  waitTimeSeconds?: number;
  batchSize?: number;
  /** Quanto tempo o shutdown espera mensagens em andamento. */
  shutdownTimeoutMs?: number;
  retryBaseSeconds?: number;
  maxRetryDelaySeconds?: number;
  /** Mesmo valor do VisibilityTimeout da fila; usado para não segurar mensagens além do prazo. */
  visibilityTimeoutSeconds?: number;
  observer?: ConsumerObserver;
}

interface Handler {
  handle(rawBody: string): Promise<MessageDecision>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Se a mensagem passou desta fração do visibility timeout esperando na fila local, a fila já
// pode tê-la entregue a outra instância; melhor devolver o resto do grupo.
const VISIBILITY_BUDGET = 0.6;

// o observer nunca pode atrapalhar o consumo
function notify(fn: (() => void) | undefined) {
  try {
    fn?.();
  } catch {
    // ignora
  }
}

export class SqsWagerConsumer {
  private readonly logger = new Logger('SqsWagerConsumer');
  private readonly abort = new AbortController();
  private stopping = false;
  private loop: Promise<void> | undefined;

  private readonly waitTimeSeconds: number;
  private readonly batchSize: number;
  private readonly shutdownTimeoutMs: number;
  private readonly retryBaseSeconds: number;
  private readonly maxRetryDelaySeconds: number;
  private readonly visibilityTimeoutSeconds: number;

  constructor(
    private readonly sqs: SQSClient,
    private readonly handler: Handler,
    private readonly options: ConsumerOptions,
  ) {
    this.waitTimeSeconds = options.waitTimeSeconds ?? 10;
    this.batchSize = options.batchSize ?? 10;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 15_000;
    this.retryBaseSeconds = options.retryBaseSeconds ?? 2;
    this.maxRetryDelaySeconds = options.maxRetryDelaySeconds ?? 300;
    this.visibilityTimeoutSeconds = options.visibilityTimeoutSeconds ?? 30;
  }

  start(): void {
    if (!this.loop) {
      this.loop = this.run().catch((err) => {
        // run() já trata os erros esperados; chegar aqui é bug, e não pode morrer em silêncio
        this.logger.error({
          msg: 'o loop do consumidor terminou com erro',
          event: 'sqs.loop_crashed',
          error: safeErrorSummary(err),
        });
      });
    }
  }

  /** Para de buscar, deixa terminar o que já começou e devolve o resto à fila. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.abort.abort();
    if (!this.loop) return;

    // O timer precisa ser cancelado: um setTimeout pendente mantém o processo vivo até
    // disparar, e o shutdown ficaria esperando o timeout inteiro mesmo sem nada em andamento.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), this.shutdownTimeoutMs);
    });
    const finished = await Promise.race([this.loop.then(() => true as const), timedOut]);
    clearTimeout(timer);
    if (!finished) {
      this.logger.warn({ msg: 'shutdown atingiu o timeout com mensagens em andamento', event: 'sqs.shutdown_timeout' });
    }
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      let messages: Message[];
      try {
        const out = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: this.options.queueUrl,
            MaxNumberOfMessages: this.batchSize,
            WaitTimeSeconds: this.waitTimeSeconds,
            MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
          }),
          { abortSignal: this.abort.signal },
        );
        messages = out.Messages ?? [];
      } catch (err) {
        if (this.stopping) break;
        this.logger.error({ msg: 'falha ao receber mensagens', event: 'sqs.receive_failed', error: safeErrorSummary(err) });
        await sleep(1000);
        continue;
      }
      if (messages.length === 0) continue;
      try {
        await this.processBatch(messages);
      } catch (err) {
        this.logger.error({ msg: 'falha ao processar o lote', event: 'sqs.batch_failed', error: safeErrorSummary(err) });
      }
    }
  }

  // FIFO entrega em ordem dentro de cada grupo: mensagens do mesmo grupo seguem em sequência,
  // grupos diferentes andam em paralelo.
  private async processBatch(messages: Message[]): Promise<void> {
    const receivedAt = Date.now();
    const groups = new Map<string, Message[]>();
    for (const m of messages) {
      let key = m.Attributes?.MessageGroupId;
      if (!key) {
        // sem o grupo não dá para paralelizar com segurança: trata tudo como um grupo só
        this.logger.warn({ msg: 'mensagem sem MessageGroupId; processando em sequência', event: 'sqs.no_group' });
        key = '__sem-grupo__';
      }
      groups.set(key, [...(groups.get(key) ?? []), m]);
    }

    await Promise.all(
      [...groups.values()].map(async (group) => {
        for (let i = 0; i < group.length; i++) {
          const overBudget = Date.now() - receivedAt > this.visibilityTimeoutSeconds * 1000 * VISIBILITY_BUDGET;
          if (this.stopping || overBudget) {
            await Promise.all(group.slice(i).map((m) => this.release(m)));
            return;
          }
          const holdSeconds = await this.processOne(group[i]!);
          if (holdSeconds !== 'done') {
            // Retry (ou falha ao finalizar): a mensagem continua na frente do grupo. Seguir
            // para as próximas inverteria a ordem. Elas ficam escondidas pelo mesmo tempo da
            // que vai repetir, então reaparecem juntas e em ordem. Devolver com 0 destravaria
            // o grupo no SQS antes da hora.
            await Promise.all(group.slice(i + 1).map((m) => this.release(m, holdSeconds)));
            return;
          }
        }
      }),
    );
  }

  /**
   * 'done' quando a mensagem saiu da frente do grupo (ack ou DLQ). Caso contrário ela continua
   * lá, e o retorno diz por quantos segundos as seguintes devem ficar escondidas.
   */
  private async processOne(message: Message): Promise<'done' | number> {
    let decision: MessageDecision;
    try {
      decision = await this.handler.handle(message.Body ?? '');
    } catch (err) {
      decision = { action: 'retry', reason: `HANDLER: ${safeErrorSummary(err)}` };
    }
    const messageId = decision.messageId ?? message.MessageId;

    try {
      switch (decision.action) {
        case 'ack':
          // o commit já aconteceu dentro do handler; só agora a mensagem sai da fila
          await this.remove(message);
          this.logger.debug({ msg: 'mensagem confirmada', event: 'sqs.ack', messageId, outcome: decision.outcome });
          notify(() => this.options.observer?.onAck?.(decision.outcome));
          return 'done';
        case 'retry': {
          const seconds = await this.delay(message, messageId, decision.reason);
          notify(() => this.options.observer?.onRetry?.());
          return seconds;
        }
        case 'dead-letter':
          await this.deadLetter(message, messageId, decision.reason);
          notify(() => this.options.observer?.onDeadLetter?.(decision.reason.split(':')[0] ?? 'UNKNOWN'));
          return 'done';
      }
    } catch (err) {
      // se confirmar falhar, a mensagem reaparece e o replay é inofensivo (inbox + idempotência)
      this.logger.error({
        msg: 'falha ao finalizar a mensagem',
        event: 'sqs.finalize_failed',
        messageId,
        error: safeErrorSummary(err),
      });
      return this.visibilityTimeoutSeconds;
    }
  }

  private remove(message: Message) {
    return this.sqs.send(
      new DeleteMessageCommand({ QueueUrl: this.options.queueUrl, ReceiptHandle: message.ReceiptHandle }),
    );
  }

  private async delay(message: Message, messageId: string | undefined, reason: string): Promise<number> {
    const received = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    const seconds = Math.min(this.retryBaseSeconds * 2 ** (received - 1), this.maxRetryDelaySeconds);
    this.logger.warn({
      msg: 'mensagem devolvida para nova tentativa',
      event: 'sqs.retry',
      messageId,
      receiveCount: received,
      delaySeconds: seconds,
      reason: reason.slice(0, 160),
    });
    await this.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.options.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
    return seconds;
  }

  // Envio explícito para a DLQ (e não esperar o redrive) porque aqui já se sabe que nenhuma
  // nova tentativa vai ajudar. Se cair entre o envio e o delete, a deduplicação da DLQ FIFO
  // absorve o reenvio.
  private async deadLetter(message: Message, messageId: string | undefined, reason: string) {
    this.logger.error({
      msg: 'mensagem enviada para a DLQ',
      event: 'sqs.dead_letter',
      messageId,
      reason: reason.slice(0, 160),
    });
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.options.dlqUrl,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'unknown',
        MessageDeduplicationId: `dlq-${message.MessageId}`,
        MessageAttributes: { failureReason: { DataType: 'String', StringValue: reason.slice(0, 250) } },
      }),
    );
    await this.remove(message);
  }

  /** Devolve a mensagem à fila; `seconds` > 0 a mantém escondida por esse tempo. */
  private async release(message: Message, seconds = 0) {
    try {
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.options.queueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: seconds,
        }),
      );
    } catch (err) {
      this.logger.warn({
        msg: 'não consegui devolver a mensagem',
        event: 'sqs.release_failed',
        messageId: message.MessageId,
        error: safeErrorSummary(err),
      });
    }
  }
}
