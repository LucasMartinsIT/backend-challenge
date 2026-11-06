import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';

export interface ReadinessResult {
  ready: boolean;
  checks: { postgres: 'up' | 'down'; sqs: 'up' | 'down' };
}

const TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS);
  });
  // cancelar o timer evita que ele segure o processo vivo depois da resposta
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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
