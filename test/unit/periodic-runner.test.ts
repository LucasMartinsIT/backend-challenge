import { describe, expect, test } from 'bun:test';
import { PeriodicRunner } from '../../src/infrastructure/workers/periodic-runner';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('PeriodicRunner', () => {
  test('repete a tarefa e para limpo', async () => {
    let runs = 0;
    const runner = new PeriodicRunner('t', async () => (++runs, 0), 10);
    runner.start();
    await sleep(120);
    await runner.stop();
    const stoppedAt = runs;
    expect(stoppedAt).toBeGreaterThan(3);
    await sleep(50);
    expect(runs).toBe(stoppedAt);
  });

  test('quando há trabalho, roda de novo imediatamente (drena o backlog)', async () => {
    let backlog = 20;
    const runner = new PeriodicRunner('t', async () => (backlog > 0 ? (backlog--, 1) : 0), 10_000);
    runner.start();
    await sleep(100);
    await runner.stop();
    expect(backlog).toBe(0);
  });

  test('erro na tarefa não derruba o loop', async () => {
    let runs = 0;
    const runner = new PeriodicRunner('t', async () => {
      runs++;
      if (runs === 1) throw new Error('falhou');
      return 0;
    }, 10);
    runner.start();
    await sleep(100);
    await runner.stop();
    expect(runs).toBeGreaterThan(2);
  });

  test('stop acorda um sono longo', async () => {
    const runner = new PeriodicRunner('t', async () => 0, 60_000);
    runner.start();
    await sleep(20);
    const started = Date.now();
    await runner.stop();
    expect(Date.now() - started).toBeLessThan(500);
  });
});
