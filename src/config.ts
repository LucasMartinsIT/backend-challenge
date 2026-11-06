import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url().default('postgres://wagering:wagering@localhost:5433/wagering'),
  AWS_REGION: z.string().default('us-east-1'),
  AWS_ENDPOINT: z.string().url().default('http://localhost:4566'),
  AWS_ACCESS_KEY_ID: z.string().default('test'),
  AWS_SECRET_ACCESS_KEY: z.string().default('test'),
  WAGER_QUEUE_URL: z.string().default('http://localhost:4566/000000000000/wager-transactions.fifo'),
  WAGER_DLQ_URL: z.string().default('http://localhost:4566/000000000000/wager-transactions-dlq.fifo'),
  EVENTS_QUEUE_URL: z.string().default('http://localhost:4566/000000000000/wallet-events.fifo'),
  OUTBOX_POLL_MS: z.coerce.number().int().min(10).default(500),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
  PENDING_POLL_MS: z.coerce.number().int().min(10).default(1000),
  PENDING_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(12),
  PENDING_BASE_DELAY_MS: z.coerce.number().int().min(1).default(1000),
  CONSUMER_RETRY_BASE_SECONDS: z.coerce.number().int().min(0).default(2),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  INSTANCE_ID: z.string().default(`pid-${process.pid}`),
  // permitem subir uma instância só de API ou só de workers
  ENABLE_CONSUMER: z.stringbool().default(true),
  ENABLE_WORKERS: z.stringbool().default(true),
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return schema.parse(env);
}

export const APP_CONFIG = Symbol('APP_CONFIG');
