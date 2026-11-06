// Processo auxiliar do teste shutdown-exit: sobe um consumidor ocioso, para-o e termina sozinho.
// Se o stop() deixar algum timer pendente, o processo não sai e o teste percebe.
import { SQSClient } from '@aws-sdk/client-sqs';
import { SqsWagerConsumer } from '../../../src/interfaces/sqs/sqs-wager-consumer';

const sqs = new SQSClient({
  region: 'us-east-1',
  endpoint: process.env.AWS_ENDPOINT ?? 'http://localhost:4566',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

const consumer = new SqsWagerConsumer(
  sqs,
  { handle: async () => ({ action: 'ack', outcome: 'processed' }) as never },
  {
    queueUrl: process.env.FIXTURE_QUEUE!,
    dlqUrl: process.env.FIXTURE_DLQ!,
    waitTimeSeconds: 10,
    // bem maior que o limite do teste: se o timer vazar, o processo demora isso para sair
    shutdownTimeoutMs: 20_000,
  },
);

consumer.start();
await Bun.sleep(1000);
await consumer.stop();
console.log('parado');
