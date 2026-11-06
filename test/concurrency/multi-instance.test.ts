import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { type Harness, buildHarness } from '../integration/harness';
import { isDrained, send, waitFor } from '../integration/sqs-support';
import { createTestOrm, resetSchema } from '../integration/support';
import { type Instance, type Queues, drainAll, makeQueues, startInstance } from './instances';

// Estes testes sobem PROCESSOS REAIS da aplicação (bun src/main.ts), todos falando com o mesmo
// Postgres e o mesmo SQS (LocalStack). Nada aqui é mock: instâncias são mortas com SIGKILL.

let orm: MikroORM;
let h: Harness;
const allQueues: Queues[] = [];
const allInstances: Instance[] = [];
const LONG = 180_000;

beforeAll(async () => {
  orm = await createTestOrm();
  await resetSchema(orm);
  h = buildHarness(orm);
});
afterAll(async () => {
  await Promise.all(allInstances.map((i) => i.kill().catch(() => {})));
  await Promise.all(allQueues.map((q) => q.cleanup()));
  await orm.close();
});

const money = (amount: string) => ({ amount, currency: 'BRL' });

async function newQueues() {
  const q = await makeQueues();
  allQueues.push(q);
  return q;
}

async function spawn(count: number, queues: Queues, opts: { consumer?: boolean; workers?: boolean }, prefix = 'inst') {
  const instances = await Promise.all(
    Array.from({ length: count }, (_, i) => startInstance({ name: `${prefix}-${i}`, queues, ...opts })),
  );
  allInstances.push(...instances);
  return instances;
}

const killAll = (instances: Instance[]) => Promise.all(instances.map((i) => i.kill().catch(() => {})));

/** O invariante central, em TODAS as wallets do banco: saldo gravado == saldo reconstruído pelo ledger. */
async function expectLedgerMatchesBalanceEverywhere() {
  const divergent = await h.raw(
    `select w.id, w.balance::text as balance, coalesce(l.s, 0)::text as ledger
       from wallets w
       left join (
         select wallet_id, sum(case when direction = 'CREDIT' then amount else -amount end) as s
           from wallet_ledger_entries group by wallet_id
       ) l on l.wallet_id = w.id
      where w.balance <> coalesce(l.s, 0)`,
  );
  expect(divergent).toEqual([]);
}

interface ApiResult {
  status: number;
  json: any;
}

/** Como um provedor de verdade: em 503 reenvia com a mesma Idempotency-Key. */
async function postBet(instance: Instance, body: Record<string, unknown>, key: string): Promise<ApiResult> {
  for (let attempt = 1; attempt <= 8; attempt++) {
    const res = await fetch(`${instance.url}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify(body),
    });
    if (res.status !== 503) return { status: res.status, json: await res.json() };
    await Bun.sleep(100 * attempt);
  }
  throw new Error('503 persistente');
}

function httpBody(w: { walletId: string; playerId: string }, ext: string, amount: string, extra: Record<string, unknown> = {}) {
  return {
    providerId: 'mi',
    externalTransactionId: ext,
    playerId: w.playerId,
    walletId: w.walletId,
    roundId: 'r1',
    gameId: 'g1',
    kind: 'BET',
    money: money(amount),
    ...extra,
  };
}

function sqsMessage(
  w: { walletId: string; playerId: string },
  messageId: string,
  ext: string,
  amount: string,
  extra: Record<string, unknown> = {},
) {
  return {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: { ...httpBody(w, ext, amount, extra), idempotencyKey: `mi:${ext}` },
  };
}

const inList = (ids: string[]) => ids.map(() => '?').join(',');

const processedBets = async (walletIds: string[]) =>
  (
    await h.raw<{ n: number }>(
      `select count(*)::int as n from wager_transactions where kind = 'BET' and status = 'PROCESSED' and wallet_id in (${inList(walletIds)})`,
      walletIds,
    )
  )[0]!.n;

async function sendInChunks(jobs: Array<() => Promise<unknown>>, size = 25) {
  for (let i = 0; i < jobs.length; i += size) await Promise.all(jobs.slice(i, i + size).map((j) => j()));
}

describe('API com 3 instâncias', () => {
  let instances: Instance[];
  let queues: Queues;

  beforeAll(async () => {
    queues = await newQueues();
    instances = await spawn(3, queues, { workers: true }, 'api');
  }, 60_000);
  afterAll(() => killAll(instances));

  const pick = (i: number) => instances[i % instances.length]!;

  test('a mesma aposta enviada 50 vezes, espalhada pelas instâncias, gera um único débito', async () => {
    const w = await h.wallet('100.00');
    const body = httpBody(w, `dup-${Bun.randomUUIDv7()}`, '30.00');
    const key = `mi:${body.externalTransactionId}`;

    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => postBet(pick(i), body, key)));

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(49);
    expect(new Set(results.map((r) => r.json.transactionId)).size).toBe(1);
    expect((await h.queries.getWallet(w.walletId)).balance).toEqual(money('70.00'));
    expect(await h.ledgerCount(w.walletId)).toBe(2);
    await expectLedgerMatchesBalanceEverywhere();
  }, LONG);

  test('duas apostas de 80,00 sobre 100,00, em instâncias diferentes, em 20 wallets ao mesmo tempo', async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => h.wallet('100.00')));
    const outcomes = await Promise.all(
      wallets.map(async (w, n) => {
        const [a, b] = await Promise.all([
          postBet(pick(n), httpBody(w, `r-${Bun.randomUUIDv7()}`, '80.00'), `k-${Bun.randomUUIDv7()}`),
          postBet(pick(n + 1), httpBody(w, `r-${Bun.randomUUIDv7()}`, '80.00'), `k-${Bun.randomUUIDv7()}`),
        ]);
        return [a.status, b.status].sort();
      }),
    );
    for (const statuses of outcomes) expect(statuses).toEqual([201, 422]);
    for (const w of wallets) {
      expect((await h.queries.getWallet(w.walletId)).balance).toEqual(money('20.00'));
      expect(await h.ledgerCount(w.walletId)).toBe(2); // OPENING + um único débito
    }
    await expectLedgerMatchesBalanceEverywhere();
  }, LONG);

  test('hot wallet: 60 apostas de 10,00 vindas de 3 instâncias aceitam exatamente 10', async () => {
    const w = await h.wallet('100.00');
    const results = await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        postBet(pick(i), httpBody(w, `hot-${Bun.randomUUIDv7()}`, '10.00'), `k-${Bun.randomUUIDv7()}`),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(10);
    expect(results.filter((r) => r.status === 422)).toHaveLength(50);
    expect(results.filter((r) => r.status === 422).every((r) => r.json.failureCode === 'INSUFFICIENT_FUNDS')).toBe(true);
    expect((await h.queries.getWallet(w.walletId)).balance).toEqual(money('0.00'));
    await expectLedgerMatchesBalanceEverywhere();
  }, LONG);

  test('reversões da mesma BET disparadas em instâncias diferentes: só uma vale', async () => {
    const w = await h.wallet('100.00');
    const bet = httpBody(w, `bet-${Bun.randomUUIDv7()}`, '30.00');
    expect((await postBet(pick(0), bet, `mi:${bet.externalTransactionId}`)).status).toBe(201);

    const kinds = ['REFUND', 'ROLLBACK', 'REFUND', 'ROLLBACK', 'REFUND', 'ROLLBACK'];
    const results = await Promise.all(
      kinds.map((kind, i) =>
        postBet(
          pick(i),
          httpBody(w, `rev-${Bun.randomUUIDv7()}`, '30.00', {
            kind,
            referenceExternalTransactionId: bet.externalTransactionId,
          }),
          `k-${Bun.randomUUIDv7()}`,
        ),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.json.failureCode === 'REFERENCE_ALREADY_REVERSED')).toHaveLength(5);
    expect((await h.queries.getWallet(w.walletId)).balance).toEqual(money('100.00'));
    await expectLedgerMatchesBalanceEverywhere();
  }, LONG);
});

interface LoadPlan {
  wallets: number;
  betsPerWallet: number;
  deliveries: number;
}

async function seedLoad(queues: Queues, plan: LoadPlan) {
  const run = Bun.randomUUIDv7().slice(-8);
  const wallets = await Promise.all(Array.from({ length: plan.wallets }, () => h.wallet('100.00')));
  const jobs: Array<() => Promise<unknown>> = [];
  for (const [wi, w] of wallets.entries()) {
    for (let n = 0; n < plan.betsPerWallet; n++) {
      const msg = sqsMessage(w, `m-${run}-${wi}-${n}`, `e-${run}-${wi}-${n}`, '10.00');
      // a mesma mensagem entregue várias vezes (ids de deduplicação do SQS diferentes de propósito)
      for (let d = 0; d < plan.deliveries; d++) {
        jobs.push(() => send(queues.queueUrl, msg, w.walletId, `${msg.messageId}-d${d}`));
      }
    }
  }
  await sendInChunks(jobs);
  return { run, wallets, walletIds: wallets.map((w) => w.walletId), totalBets: plan.wallets * plan.betsPerWallet };
}

/** Espera tudo terminar e confere cada garantia do desafio sobre o resultado. */
async function expectExactlyOnce(
  queues: Queues,
  load: Awaited<ReturnType<typeof seedLoad>>,
  plan: LoadPlan,
) {
  await waitFor(
    async () => (await processedBets(load.walletIds)) === load.totalBets && (await isDrained(queues.queueUrl)),
    150_000,
    'todas as mensagens aplicadas e a fila vazia',
  );

  const expectedBalance = (100 - 10 * plan.betsPerWallet).toFixed(2);
  for (const id of load.walletIds) {
    expect((await h.queries.getWallet(id)).balance.amount).toBe(expectedBalance);
    expect(await h.ledgerCount(id)).toBe(1 + plan.betsPerWallet); // OPENING + uma linha por aposta
  }
  const inbox = await h.raw<{ n: number }>(
    `select count(*)::int as n from inbox_messages where consumer_name = 'wager-transactions' and message_id like ?`,
    [`m-${load.run}-%`],
  );
  expect(inbox[0]!.n).toBe(load.totalBets);
  expect(await drainAll(queues.dlqUrl)).toHaveLength(0);
  await expectLedgerMatchesBalanceEverywhere();

  // outbox: tudo publicado, e cada evento chegou à fila de saída uma única vez
  await waitFor(
    async () =>
      (
        await h.raw<{ n: number }>(
          `select count(*)::int as n from outbox_messages where published_at is null and failed_at is null and aggregate_id in (${inList(load.walletIds)})`,
          load.walletIds,
        )
      )[0]!.n === 0,
    60_000,
    'outbox esvaziada',
  );
  const expectedEvents = (
    await h.raw<{ id: string }>(`select id from outbox_messages where aggregate_id in (${inList(load.walletIds)})`, load.walletIds)
  ).map((r) => r.id);
  const delivered = (await drainAll(queues.eventsUrl))
    .map((m) => JSON.parse(m.body).eventId as string)
    .filter((id) => expectedEvents.includes(id));
  expect(delivered).toHaveLength(expectedEvents.length);
  expect(new Set(delivered).size).toBe(expectedEvents.length);
}

describe('consumo SQS com instâncias morrendo', () => {
  const plan: LoadPlan = { wallets: 20, betsPerWallet: 3, deliveries: 3 };

  test('3 instâncias; uma é morta (SIGKILL) no meio: cada aposta é aplicada exatamente uma vez', async () => {
    const queues = await newQueues();
    const load = await seedLoad(queues, plan);
    const instances = await spawn(3, queues, { consumer: true, workers: true }, 'consumer');
    try {
      await waitFor(async () => (await processedBets(load.walletIds)) >= 12, 60_000, 'progresso inicial');
      await instances[1]!.kill(); // pode estar com mensagens já commitadas e ainda sem ack
      await expectExactlyOnce(queues, load, plan);
    } finally {
      await killAll(instances);
    }
  }, LONG);

  test('reinício: todas as instâncias morrem no meio da carga, outras sobem e a consistência final se mantém', async () => {
    const queues = await newQueues();
    const load = await seedLoad(queues, plan);
    const before = await spawn(3, queues, { consumer: true, workers: true }, 'before');
    let after: Instance[] = [];
    try {
      await waitFor(async () => (await processedBets(load.walletIds)) >= 10, 60_000, 'progresso inicial');
      await killAll(before); // queda total
      const partial = await processedBets(load.walletIds);
      expect(partial).toBeLessThan(load.totalBets); // morreram com trabalho pela frente

      after = await spawn(2, queues, { consumer: true, workers: true }, 'after');
      await expectExactlyOnce(queues, load, plan);
    } finally {
      await killAll([...before, ...after]);
    }
  }, LONG);

  test('REFUND chega antes da BET em mensagens distintas: as pendências são resolvidas pelos workers', async () => {
    const queues = await newQueues();
    const wallets = await Promise.all(Array.from({ length: 10 }, () => h.wallet('100.00')));
    const run = Bun.randomUUIDv7().slice(-8);
    const instances = await spawn(3, queues, { consumer: true, workers: true }, 'pending');
    try {
      const refunds: string[] = [];
      for (const [i, w] of wallets.entries()) {
        const betExt = `bet-${run}-${i}`;
        const refundExt = `refund-${run}-${i}`;
        refunds.push(refundExt);
        // mesmo grupo FIFO (a wallet): o REFUND é processado antes da BET que ele referencia
        await send(
          queues.queueUrl,
          sqsMessage(w, `m-${run}-r${i}`, refundExt, '25.00', {
            kind: 'REFUND',
            referenceExternalTransactionId: betExt,
          }),
          w.walletId,
        );
        await send(queues.queueUrl, sqsMessage(w, `m-${run}-b${i}`, betExt, '25.00'), w.walletId);
      }

      await waitFor(
        async () =>
          (
            await h.raw<{ n: number }>(
              `select count(*)::int as n from wager_transactions where kind = 'REFUND' and status = 'PROCESSED' and external_transaction_id in (${inList(refunds)})`,
              refunds,
            )
          )[0]!.n === wallets.length,
        90_000,
        'todos os REFUND resolvidos',
      );
      for (const w of wallets) {
        expect((await h.queries.getWallet(w.walletId)).balance).toEqual(money('100.00'));
        expect(await h.ledgerCount(w.walletId)).toBe(3); // OPENING, BET, REFUND
      }
      await expectLedgerMatchesBalanceEverywhere();
      await waitFor(() => isDrained(queues.queueUrl), 30_000, 'fila vazia');
      expect(await drainAll(queues.dlqUrl)).toHaveLength(0);
    } finally {
      await killAll(instances);
    }
  }, LONG);

  test('a mesma transação por HTTP e por SQS ao mesmo tempo, em instâncias diferentes: um único efeito', async () => {
    const queues = await newQueues();
    const instances = await spawn(3, queues, { consumer: true, workers: true }, 'mixed');
    try {
      const w = await h.wallet('100.00');
      const run = Bun.randomUUIDv7().slice(-8);
      const exts = Array.from({ length: 5 }, (_, i) => `mix-${run}-${i}`);

      await Promise.all(
        exts.flatMap((ext, i) => [
          postBet(instances[i % 3]!, httpBody(w, ext, '10.00'), `mi:${ext}`),
          send(queues.queueUrl, sqsMessage(w, `m-${run}-${i}`, ext, '10.00'), w.walletId),
        ]),
      );

      await waitFor(() => isDrained(queues.queueUrl), 60_000, 'fila vazia');
      const rows = await h.raw<{ n: number }>(
        `select count(*)::int as n from wager_transactions where wallet_id = ? and kind = 'BET'`,
        [w.walletId],
      );
      expect(rows[0]!.n).toBe(5);
      expect((await h.queries.getWallet(w.walletId)).balance).toEqual(money('50.00'));
      expect(await h.ledgerCount(w.walletId)).toBe(6);
      expect(await drainAll(queues.dlqUrl)).toHaveLength(0);
      await expectLedgerMatchesBalanceEverywhere();
    } finally {
      await killAll(instances);
    }
  }, LONG);
});
