import { afterAll, beforeAll, expect, test } from 'bun:test';
import path from 'node:path';
import { type TestQueues, createTestQueues } from './sqs-support';

let queues: TestQueues;
beforeAll(async () => {
  queues = await createTestQueues();
});
afterAll(() => queues.cleanup());

// Regressão: o stop() do consumidor deixava um setTimeout de 15 s pendente, o processo só saía
// quando ele disparava e o `docker stop` (que espera 10 s) acabava matando o contêiner à força.
test('um processo com consumidor parado sai logo, sem esperar o timeout de shutdown', async () => {
  const fixture = path.resolve(import.meta.dir, 'fixtures/idle-consumer.ts');
  const started = performance.now();
  const proc = Bun.spawn([process.execPath, fixture], {
    env: { ...process.env, FIXTURE_QUEUE: queues.queueUrl, FIXTURE_DLQ: queues.dlqUrl },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await proc.exited;
  const elapsedMs = performance.now() - started;

  expect(code).toBe(0);
  expect(await new Response(proc.stdout).text()).toContain('parado');
  // ~1 s de espera do próprio fixture + o stop(); o vazamento levava 20 s
  expect(elapsedMs).toBeLessThan(8000);
}, 30_000);
