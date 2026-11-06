import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

export const sqs = new SQSClient({
  region: 'us-east-1',
  endpoint: process.env.AWS_ENDPOINT ?? 'http://localhost:4566',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(check: () => Promise<boolean>, timeoutMs = 15_000, label = 'condição') {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await sleep(150);
  }
  throw new Error(`timeout esperando ${label}`);
}

export interface TestQueues {
  queueUrl: string;
  dlqUrl: string;
  cleanup(): Promise<void>;
}

/** Filas só deste teste: o app de desenvolvimento rodando ao mesmo tempo não interfere. */
export async function createTestQueues(maxReceiveCount = 3, visibilityTimeout = 5): Promise<TestQueues> {
  const id = Bun.randomUUIDv7().slice(-12);
  const dlq = await sqs.send(
    new CreateQueueCommand({
      QueueName: `t-${id}-dlq.fifo`,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
    }),
  );
  const dlqUrl = dlq.QueueUrl!;
  const dlqArn = (
    await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }))
  ).Attributes!.QueueArn!;
  const main = await sqs.send(
    new CreateQueueCommand({
      QueueName: `t-${id}.fifo`,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        VisibilityTimeout: String(visibilityTimeout),
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: String(maxReceiveCount) }),
      },
    }),
  );
  const queueUrl = main.QueueUrl!;
  return {
    queueUrl,
    dlqUrl,
    async cleanup() {
      await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl })).catch(() => {});
      await sqs.send(new DeleteQueueCommand({ QueueUrl: dlqUrl })).catch(() => {});
    },
  };
}

export function send(queueUrl: string, body: unknown, group = 'g', dedupId = Bun.randomUUIDv7()) {
  return sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
      MessageGroupId: group,
      MessageDeduplicationId: dedupId,
    }),
  );
}

export async function queueDepth(queueUrl: string): Promise<{ visible: number; inFlight: number }> {
  const a = (
    await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      }),
    )
  ).Attributes!;
  return {
    visible: Number(a.ApproximateNumberOfMessages),
    inFlight: Number(a.ApproximateNumberOfMessagesNotVisible),
  };
}

export async function isDrained(queueUrl: string) {
  const d = await queueDepth(queueUrl);
  return d.visible === 0 && d.inFlight === 0;
}

/** Lê (e remove) tudo o que há na fila. */
export async function drain(queueUrl: string, waitMs = 2000) {
  const out: Array<{ body: string; attributes: Record<string, string> }> = [];
  const end = Date.now() + waitMs;
  while (Date.now() < end) {
    const r = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageAttributeNames: ['All'],
      }),
    );
    for (const m of r.Messages ?? []) {
      out.push({
        body: m.Body!,
        attributes: Object.fromEntries(
          Object.entries(m.MessageAttributes ?? {}).map(([k, v]) => [k, v.StringValue ?? '']),
        ),
      });
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle }));
    }
  }
  return out;
}
