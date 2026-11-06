import { SQSClient } from '@aws-sdk/client-sqs';
import type { AppConfig } from '../../config';

export function createSqsClient(config: Pick<AppConfig, 'AWS_REGION' | 'AWS_ENDPOINT' | 'AWS_ACCESS_KEY_ID' | 'AWS_SECRET_ACCESS_KEY'>) {
  return new SQSClient({
    region: config.AWS_REGION,
    endpoint: config.AWS_ENDPOINT,
    credentials: { accessKeyId: config.AWS_ACCESS_KEY_ID, secretAccessKey: config.AWS_SECRET_ACCESS_KEY },
  });
}
