import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher } from '../../application/ports';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';

const SEND_TIMEOUT_MS = 5000;

export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message.payload),
        // eventos da mesma wallet saem no mesmo grupo
        MessageGroupId: message.aggregateId,
        // o eventId vira a chave de deduplicação: reenvio da mesma mensagem é descartado pela fila
        MessageDeduplicationId: message.id,
        MessageAttributes: { eventType: { DataType: 'String', StringValue: message.eventType } },
      }),
      { abortSignal: AbortSignal.timeout(SEND_TIMEOUT_MS) },
    );
  }
}
