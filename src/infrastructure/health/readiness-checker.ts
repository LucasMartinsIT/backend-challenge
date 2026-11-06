import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';

export interface ReadinessResult {
  ready: boolean;
  checks: { postgres: 'up' | 'down'; sqs: 'up' | 'down' };
}

const TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS)),
  ]);
}

export class ReadinessChecker {
  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SQSClient,
    private readonly queueUrls: string[],
  ) {}

  async check(): Promise<ReadinessResult> {
    const [postgres, sqs] = await Promise.all([this.postgres(), this.sqsQueues()]);
    return { ready: postgres && sqs, checks: { postgres: postgres ? 'up' : 'down', sqs: sqs ? 'up' : 'down' } };
  }

  private async postgres(): Promise<boolean> {
    try {
      await withTimeout(this.orm.em.fork().execute('select 1'));
      return true;
    } catch {
      return false;
    }
  }

  private async sqsQueues(): Promise<boolean> {
    try {
      await Promise.all(
        this.queueUrls.map((QueueUrl) =>
          withTimeout(
            this.sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['QueueArn'] }), {
              abortSignal: AbortSignal.timeout(TIMEOUT_MS),
            }),
          ),
        ),
      );
      return true;
    } catch {
      return false;
    }
  }
}
