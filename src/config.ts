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
