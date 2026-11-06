/**
 * Teste de carga: bun run test:load
 *
 * Sobe N instâncias reais da aplicação (workers ligados) contra o Postgres e o LocalStack do
 * Docker Compose, gera tráfego HTTP concorrente e mede latência, taxa de erro, conflitos de
 * lock e o lag da outbox. Ao final confere o invariante saldo == soma do ledger.
 *
 * Parâmetros por variável de ambiente (valores padrão entre parênteses):
 *   LOAD_INSTANCES (3)  LOAD_WALLETS (200)  LOAD_DURATION_S (20)
 *   LOAD_CONCURRENCY (64)  LOAD_REPLAY_RATE (0.05)  LOAD_HOT_SHARE (0.8)
 */
import os from 'node:os';
import { type Instance, makeQueues, startInstance } from '../concurrency/instances';
import { buildHarness } from '../integration/harness';
import { createTestOrm, resetSchema } from '../integration/support';

const cfg = {
  instances: Number(process.env.LOAD_INSTANCES ?? 3),
  wallets: Number(process.env.LOAD_WALLETS ?? 200),
  durationS: Number(process.env.LOAD_DURATION_S ?? 20),
  concurrency: Number(process.env.LOAD_CONCURRENCY ?? 64),
  replayRate: Number(process.env.LOAD_REPLAY_RATE ?? 0.05),
  hotShare: Number(process.env.LOAD_HOT_SHARE ?? 0.8),
};

interface Sample {
  ms: number;
  status: number; // 0 = erro de rede
}

interface Req {
  body: Record<string, unknown>;
  key: string;
}

const percentile = (sorted: number[], p: number) =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;

/** Soma de todas as séries de uma métrica (com ou sem rótulos). */
function metricSum(text: string, name: string): number {
  let total = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) continue;
    if (line.startsWith(`${name} `) || line.startsWith(`${name}{`)) total += Number(line.slice(line.lastIndexOf(' ') + 1));
  }
  return total;
}

async function scrape(instance: Instance): Promise<string> {
  try {
    return await (await fetch(`${instance.url}/metrics`)).text();
  } catch {
    return '';
  }
}

async function main() {
  const orm = await createTestOrm();
  await resetSchema(orm);
  const h = buildHarness(orm);
  const queues = await makeQueues();

  console.log(`subindo ${cfg.instances} instâncias...`);
  const instances = await Promise.all(
    Array.from({ length: cfg.instances }, (_, i) => startInstance({ name: `load-${i}`, queues, workers: true })),
  );

  try {
    console.log(`criando ${cfg.wallets} wallets...`);
    const wallets: Array<{ walletId: string; playerId: string }> = [];
    for (let i = 0; i < cfg.wallets; i += 20) {
      const chunk = await Promise.all(
        Array.from({ length: Math.min(20, cfg.wallets - i) }, () => h.wallet('100000.00')),
      );
      wallets.push(...chunk);
    }
    const hotCount = Math.max(1, Math.floor(wallets.length * 0.1));
    const hot = wallets.slice(0, hotCount);
    const cold = wallets.slice(hotCount);
    const pickWallet = () => {
      const pool = Math.random() < cfg.hotShare || cold.length === 0 ? hot : cold;
      return pool[Math.floor(Math.random() * pool.length)]!;
    };

    const kinds = [
      { kind: 'BET', weight: 70, amount: '1.00' },
      { kind: 'WIN', weight: 25, amount: '1.50' },
      { kind: 'LOSS', weight: 5, amount: '1.00' },
    ];
    const pickKind = () => {
      let r = Math.random() * 100;
      for (const k of kinds) if ((r -= k.weight) < 0) return k;
      return kinds[0]!;
    };

    const recent: Req[] = [];
    const makeRequest = (): Req => {
      if (recent.length > 20 && Math.random() < cfg.replayRate) {
        return recent[Math.floor(Math.random() * recent.length)]!; // repetição exata
      }
      const w = pickWallet();
      const k = pickKind();
      const ext = `load-${Bun.randomUUIDv7()}`;
      const req: Req = {
        key: `load:${ext}`,
        body: {
          providerId: 'load',
          externalTransactionId: ext,
          playerId: w.playerId,
          walletId: w.walletId,
          roundId: 'r1',
          gameId: 'g1',
          kind: k.kind,
          money: { amount: k.amount, currency: 'BRL' },
        },
      };
      recent.push(req);
      if (recent.length > 500) recent.shift();
      return req;
    };

    const samples: Sample[] = [];
    const statusCount = new Map<number, number>();
    const startedAt = Date.now();
    const endAt = startedAt + cfg.durationS * 1000;

    // amostra o lag da outbox a cada segundo, enquanto a carga roda
    let maxLag = 0;
    let maxPending = 0;
    const sampler = setInterval(async () => {
      const text = await scrape(instances[0]!);
      maxLag = Math.max(maxLag, metricSum(text, 'outbox_lag_seconds'));
      maxPending = Math.max(maxPending, metricSum(text, 'outbox_pending'));
    }, 1000);

    console.log(`carga: ${cfg.concurrency} usuários virtuais por ${cfg.durationS}s...`);
    let rr = 0;
    await Promise.all(
      Array.from({ length: cfg.concurrency }, async () => {
        while (Date.now() < endAt) {
          const req = makeRequest();
          const instance = instances[rr++ % instances.length]!;
          const t0 = performance.now();
          let status = 0;
          try {
            const res = await fetch(`${instance.url}/wagering/transactions`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'idempotency-key': req.key },
              body: JSON.stringify(req.body),
            });
            status = res.status;
            await res.arrayBuffer();
          } catch {
            status = 0;
          }
          samples.push({ ms: performance.now() - t0, status });
          statusCount.set(status, (statusCount.get(status) ?? 0) + 1);
        }
      }),
    );
    const elapsedS = (Date.now() - startedAt) / 1000;
    clearInterval(sampler);

    // quanto tempo a outbox leva para esvaziar depois que a carga para
    const drainStart = Date.now();
    let drained = false;
    while (Date.now() - drainStart < 60_000) {
      const [row] = await h.raw<{ n: number }>(
        `select count(*)::int as n from outbox_messages where published_at is null and failed_at is null`,
      );
      if (row!.n === 0) {
        drained = true;
        break;
      }
      await Bun.sleep(100);
    }
    const drainS = (Date.now() - drainStart) / 1000;

    const scrapes = await Promise.all(instances.map(scrape));
    const lockConflicts = scrapes.reduce((s, t) => s + metricSum(t, 'lock_conflicts_total'), 0);
    const replays = scrapes.reduce((s, t) => s + metricSum(t, 'idempotent_replays_total'), 0);

    const [dupes] = await h.raw<{ n: number }>(
      `select count(*)::int as n from (select idempotency_key from wager_transactions group by 1 having count(*) > 1) d`,
    );
    const divergent = await h.raw(
      `select w.id from wallets w
         left join (select wallet_id, sum(case when direction='CREDIT' then amount else -amount end) s
                      from wallet_ledger_entries group by wallet_id) l on l.wallet_id = w.id
        where w.balance <> coalesce(l.s, 0)`,
    );

    const ok = samples.filter((s) => s.status >= 200 && s.status < 300);
    const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
    const serverErrors = samples.filter((s) => s.status >= 500 && s.status !== 503).length;
    const transient = samples.filter((s) => s.status === 503).length;
    const networkErrors = samples.filter((s) => s.status === 0).length;

    const fmt = (n: number) => n.toFixed(1);
    const lines = [
      '',
      '## Resultado',
      '',
      `| Item | Valor |`,
      `|---|---|`,
      `| Requisições | ${samples.length} em ${fmt(elapsedS)}s |`,
      `| Throughput | **${fmt(samples.length / elapsedS)} req/s** (${fmt(ok.length / elapsedS)} com 2xx) |`,
      `| Latência p50 / p95 / p99 | **${fmt(percentile(sorted, 50))} / ${fmt(percentile(sorted, 95))} / ${fmt(percentile(sorted, 99))} ms** |`,
      `| Latência máxima | ${fmt(sorted[sorted.length - 1] ?? 0)} ms |`,
      `| Status | ${[...statusCount.entries()].sort().map(([s, n]) => `${s === 0 ? 'erro de rede' : s}: ${n}`).join(' · ')} |`,
      `| Taxa de erro (5xx sem 503, mais rede) | ${fmt(((serverErrors + networkErrors) / samples.length) * 100)}% (${serverErrors + networkErrors}) |`,
      `| 503 (transitórios) | ${transient} |`,
      `| Conflitos de lock (retries internos) | ${lockConflicts} |`,
      `| Replays de idempotência | ${replays} |`,
      `| Lag máximo da outbox durante a carga | ${fmt(maxLag)} s (pendentes no pico: ${maxPending}) |`,
      `| Tempo para esvaziar a outbox depois da carga | ${drained ? `${fmt(drainS)} s` : 'NÃO esvaziou em 60 s'} |`,
      `| Chaves de idempotência duplicadas no banco | ${dupes!.n} |`,
      `| Wallets com saldo ≠ ledger | ${divergent.length} |`,
      '',
      '## Ambiente',
      '',
      `- CPU: ${os.cpus()[0]?.model.trim()} (${os.cpus().length} threads)`,
      `- Memória: ${(os.totalmem() / 1024 ** 3).toFixed(1)} GB · SO: ${os.type()} ${os.release()}`,
      `- Bun ${Bun.version} · ${cfg.instances} instâncias da aplicação (workers ligados)`,
      `- Postgres 16 e LocalStack em containers locais, na MESMA máquina do gerador de carga`,
      '',
      '## Parâmetros',
      '',
      `- ${cfg.wallets} wallets com 100000,00 BRL (${hotCount} quentes recebem ${Math.round(cfg.hotShare * 100)}% do tráfego)`,
      `- ${cfg.concurrency} usuários virtuais por ${cfg.durationS}s, requisições distribuídas em round-robin`,
      `- mistura: 70% BET de 1,00 · 25% WIN de 1,50 · 5% LOSS; ${Math.round(cfg.replayRate * 100)}% são repetições exatas`,
      '',
    ];
    console.log(lines.join('\n'));

    const failed = divergent.length > 0 || dupes!.n > 0 || serverErrors + networkErrors > 0 || !drained;
    console.log(failed ? 'RESULTADO: FALHOU (veja acima)' : 'RESULTADO: invariantes preservados');
    process.exitCode = failed ? 1 : 0;
  } finally {
    await Promise.all(instances.map((i) => i.kill().catch(() => {})));
    await queues.cleanup();
    await orm.close();
  }
}

await main();
