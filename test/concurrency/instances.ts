import path from 'node:path';
import { type Subprocess } from 'bun';
import { TEST_DATABASE_URL } from '../integration/support';
import { createTestQueues, drain, type TestQueues } from '../integration/sqs-support';

const ROOT = path.resolve(import.meta.dir, '../..');

export interface Instance {
  name: string;
  url: string;
  proc: Subprocess;
  /** SIGKILL: sem shutdown gracioso, como uma queda de máquina. */
  kill(): Promise<void>;
}

export interface Queues {
  queueUrl: string;
  dlqUrl: string;
  eventsUrl: string;
  cleanup(): Promise<void>;
}

/** Filas só desta execução: fila de apostas (com DLQ) e fila de eventos de saída. */
export async function makeQueues(): Promise<Queues> {
  const wagers: TestQueues = await createTestQueues(10, 5);
  const events: TestQueues = await createTestQueues(10, 5);
  return {
    queueUrl: wagers.queueUrl,
    dlqUrl: wagers.dlqUrl,
    eventsUrl: events.queueUrl,
    cleanup: async () => {
      await wagers.cleanup();
      await events.cleanup();
    },
  };
}

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response('') });
  const port = server.port!;
  await server.stop(true);
  return port;
}

async function waitReady(url: string, proc: Subprocess, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (proc.exitCode !== null) throw new Error(`instância encerrou antes de ficar pronta (código ${proc.exitCode})`);
    try {
      const res = await fetch(`${url}/health/ready`);
      if (res.status === 200) return;
    } catch {
      // ainda subindo
    }
    await Bun.sleep(150);
  }
  throw new Error(`instância não ficou pronta em ${timeoutMs}ms`);
}

/** Sobe um processo REAL da aplicação, apontando para as filas e o banco de teste. */
export async function startInstance(opts: {
  name: string;
  queues: Queues;
  consumer?: boolean;
  workers?: boolean;
}): Promise<Instance> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const proc = Bun.spawn([process.execPath, 'src/main.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: TEST_DATABASE_URL,
      WAGER_QUEUE_URL: opts.queues.queueUrl,
      WAGER_DLQ_URL: opts.queues.dlqUrl,
      EVENTS_QUEUE_URL: opts.queues.eventsUrl,
      ENABLE_CONSUMER: String(opts.consumer ?? false),
      ENABLE_WORKERS: String(opts.workers ?? false),
      INSTANCE_ID: opts.name,
      LOG_LEVEL: 'warn',
      // tempos curtos para o teste não esperar minutos
      CONSUMER_RETRY_BASE_SECONDS: '1',
      CONSUMER_VISIBILITY_TIMEOUT_SECONDS: '5',
      OUTBOX_POLL_MS: '100',
      PENDING_POLL_MS: '200',
      PENDING_BASE_DELAY_MS: '100',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  await waitReady(url, proc);
  return {
    name: opts.name,
    url,
    proc,
    kill: async () => {
      proc.kill('SIGKILL');
      await proc.exited;
    },
  };
}

/** Lê e remove tudo o que há na fila, parando depois de duas leituras vazias seguidas. */
export async function drainAll(queueUrl: string) {
  const all: Array<{ body: string; attributes: Record<string, string> }> = [];
  let empties = 0;
  while (empties < 2) {
    const batch = await drain(queueUrl, 1200);
    if (batch.length === 0) empties++;
    else {
      empties = 0;
      all.push(...batch);
    }
  }
  return all;
}
