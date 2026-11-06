import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { SubmitWagerTransaction } from '../../application/submit-wager-transaction';
import { APP_CONFIG, type AppConfig } from '../../config';
import { Metrics } from '../../infrastructure/observability/metrics';
import { createSqsClient } from '../../infrastructure/sqs/sqs-client';
import { SqsWagerConsumer } from './sqs-wager-consumer';
import { WagerMessageHandler } from './wager-message-handler';

@Injectable()
export class WagerConsumerService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private consumer: SqsWagerConsumer | undefined;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SubmitWagerTransaction) private readonly submit: SubmitWagerTransaction,
    @Inject(Metrics) private readonly metrics: Metrics,
  ) {}

  onApplicationBootstrap() {
    if (!this.config.ENABLE_CONSUMER) return;
    this.consumer = new SqsWagerConsumer(createSqsClient(this.config), new WagerMessageHandler(this.submit), {
      queueUrl: this.config.WAGER_QUEUE_URL,
      dlqUrl: this.config.WAGER_DLQ_URL,
      retryBaseSeconds: this.config.CONSUMER_RETRY_BASE_SECONDS,
      visibilityTimeoutSeconds: this.config.CONSUMER_VISIBILITY_TIMEOUT_SECONDS,
      observer: {
        onAck: (outcome) => this.metrics.sqsAcks.inc({ outcome }),
        onRetry: () => this.metrics.sqsRetries.inc(),
        onDeadLetter: (reason) => this.metrics.sqsDeadLetters.inc({ reason }),
      },
    });
    this.consumer.start();
  }

  // roda antes de o ORM fechar: o consumidor termina o que está em andamento primeiro
  async beforeApplicationShutdown() {
    await this.consumer?.stop();
  }
}
