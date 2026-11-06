import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { TEST_DATABASE_URL, createTestOrm, resetSchema } from './support';

let app: INestApplication;
let base: string;

beforeAll(async () => {
  const orm = await createTestOrm();
  await resetSchema(orm);
  await orm.close();

  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.LOG_LEVEL = 'silent';
  // este teste não pode consumir da fila real
  process.env.ENABLE_CONSUMER = 'false';
  process.env.ENABLE_WORKERS = 'false';
  const { AppModule } = await import('../../src/app.module');
  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0);
  base = await app.getUrl();
  base = base.replace('[::1]', 'localhost');
});
afterAll(() => app.close());

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : undefined };
}

const money = (amount: unknown, currency = 'BRL') => ({ amount, currency });

async function newWallet(balance = '1000.00') {
  const playerId = Bun.randomUUIDv7();
  const res = await call('POST', '/wallets', { playerId, initialBalance: money(balance) });
  expect(res.status).toBe(201);
  return { walletId: res.json.id as string, playerId };
}

function tx(w: { walletId: string; playerId: string }, over: Record<string, unknown> = {}) {
  const ext = `ext-${Bun.randomUUIDv7()}`;
  return {
    providerId: 'provider-a',
    externalTransactionId: ext,
    playerId: w.playerId,
    walletId: w.walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: money('25.00'),
    ...over,
  };
}

const post = (body: Record<string, unknown>, key?: string) =>
  call('POST', '/wagering/transactions', body, {
    'idempotency-key': key ?? `${body.providerId}:${body.externalTransactionId}`,
  });

describe('health', () => {
  test('liveness é público', async () => {
    const r = await call('GET', '/health/live');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ status: 'ok' });
  });

  test('readiness confere Postgres e SQS e também é público', async () => {
    const r = await call('GET', '/health/ready');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ status: 'ok', checks: { postgres: 'up', sqs: 'up' } });
  });
});

describe('POST /wallets', () => {
  test('201 com saldo e version 1; duplicada é 409', async () => {
    const playerId = Bun.randomUUIDv7();
    const body = { playerId, initialBalance: money('1000.00') };
    const ok = await call('POST', '/wallets', body);
    expect(ok.status).toBe(201);
    expect(ok.json).toMatchObject({ playerId, balance: money('1000.00'), version: 1 });
    expect(ok.headers.get('x-correlation-id')).toBeTruthy();

    const dup = await call('POST', '/wallets', body);
    expect(dup.status).toBe(409);
    expect(dup.json.error.code).toBe('WALLET_ALREADY_EXISTS');
  });

  test('400 para valores inválidos, incluindo número JSON no lugar de string', async () => {
    for (const amount of [1000, '-1.00', '1.234', '1e3', '']) {
      const r = await call('POST', '/wallets', { playerId: 'p', initialBalance: money(amount) });
      expect(r.status).toBe(400);
      expect(r.json.error.code).toMatch(/VALIDATION_ERROR|INVALID_MONEY/);
    }
    expect((await call('POST', '/wallets', '{json quebrado')).status).toBe(400);
  });
});

describe('POST /wagering/transactions: um status para cada situação', () => {
  test('201 aplicada, 200 replay idêntico', async () => {
    const w = await newWallet();
    const body = tx(w);
    const first = await post(body);
    expect(first.status).toBe(201);
    expect(first.json).toMatchObject({ status: 'PROCESSED', balance: money('975.00'), idempotentReplay: false });

    const replay = await post(body);
    expect(replay.status).toBe(200);
    expect(replay.json).toEqual({ ...first.json, idempotentReplay: true });
  });

  test('422 para rejeição de negócio, com failureCode estável', async () => {
    const w = await newWallet('10.00');
    const r = await post(tx(w, { money: money('50.00') }));
    expect(r.status).toBe(422);
    expect(r.json).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' });
    expect(r.json.error.code).toBe('INSUFFICIENT_FUNDS');
    // replay da rejeição continua 422
    expect((await post(tx(w, { money: money('50.00') }))).status).toBe(422);
  });

  test('202 para referência pendente', async () => {
    const w = await newWallet();
    const r = await post(tx(w, { kind: 'REFUND', referenceExternalTransactionId: 'nao-chegou' }));
    expect(r.status).toBe(202);
    expect(r.json.status).toBe('PENDING_REFERENCE');
  });

  test('409 para mesma chave com payload diferente', async () => {
    const w = await newWallet();
    const body = tx(w);
    const key = `${body.providerId}:${body.externalTransactionId}`;
    expect((await post(body, key)).status).toBe(201);
    const conflict = await post({ ...body, money: money('26.00') }, key);
    expect(conflict.status).toBe(409);
    expect(conflict.json.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  test('400 sem Idempotency-Key, com OPENING, sem referência e com payload inválido', async () => {
    const w = await newWallet();
    const noKey = await call('POST', '/wagering/transactions', tx(w));
    expect(noKey.status).toBe(400);
    expect(noKey.json.error.code).toBe('MISSING_IDEMPOTENCY_KEY');

    expect((await post(tx(w, { kind: 'OPENING' }))).status).toBe(400);
    expect((await post(tx(w, { kind: 'REFUND' }))).status).toBe(400);
    expect((await post(tx(w, { kind: 'NOPE' }))).status).toBe(400);
    expect((await post(tx(w, { money: money(25) }))).status).toBe(400);
    expect((await post(tx(w, { walletId: 'nao-e-uuid' }))).status).toBe(400);
  });

  test('404 para wallet inexistente', async () => {
    const w = { walletId: Bun.randomUUIDv7(), playerId: 'p' };
    const r = await post(tx(w));
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe('WALLET_NOT_FOUND');
  });

  test('ecoa o x-correlation-id recebido', async () => {
    const w = await newWallet();
    const body = tx(w);
    const r = await call('POST', '/wagering/transactions', body, {
      'idempotency-key': 'k-corr',
      'x-correlation-id': 'meu-id-123',
    });
    expect(r.headers.get('x-correlation-id')).toBe('meu-id-123');
  });
});

describe('consultas', () => {
  test('wallet, transação (por id e por id externo), ledger paginado e reconciliação', async () => {
    const w = await newWallet('100.00');
    const bodies = [tx(w), tx(w), tx(w)];
    const created = [];
    for (const b of bodies) created.push((await post(b)).json);

    const wallet = await call('GET', `/wallets/${w.walletId}`);
    expect(wallet.json).toMatchObject({ balance: money('25.00'), version: 4 });

    const byId = await call('GET', `/wagering/transactions/${created[0].transactionId}`);
    const byExt = await call('GET', `/providers/provider-a/wagering/transactions/${bodies[0]!.externalTransactionId}`);
    expect(byId.status).toBe(200);
    expect(byExt.json).toEqual(byId.json);

    const page1 = await call('GET', `/wallets/${w.walletId}/ledger?limit=3`);
    expect(page1.json.entries).toHaveLength(3);
    expect(page1.json.nextCursor).toBeTruthy();
    const page2 = await call(
      'GET',
      `/wallets/${w.walletId}/ledger?limit=3&cursor=${encodeURIComponent(page1.json.nextCursor)}`,
    );
    expect(page2.json.entries).toHaveLength(1);
    expect(page2.json.nextCursor).toBeNull();

    const rec = await call('POST', `/wallets/${w.walletId}/reconciliation`);
    expect(rec.status).toBe(200);
    expect(rec.json).toEqual({
      walletId: w.walletId,
      storedBalance: money('25.00'),
      calculatedBalance: money('25.00'),
      difference: money('0.00'),
      consistent: true,
      checkedEntries: 4,
    });
  });

  test('404 e 400 nas consultas', async () => {
    expect((await call('GET', `/wallets/${Bun.randomUUIDv7()}`)).status).toBe(404);
    expect((await call('GET', '/wallets/xyz')).status).toBe(400);
    expect((await call('GET', `/wagering/transactions/${Bun.randomUUIDv7()}`)).status).toBe(404);
    expect((await call('GET', '/providers/p/wagering/transactions/nao-existe')).status).toBe(404);
    const w = await newWallet();
    expect((await call('GET', `/wallets/${w.walletId}/ledger?cursor=lixo`)).status).toBe(400);
    expect((await call('GET', `/wallets/${w.walletId}/ledger?limit=0`)).status).toBe(400);
    expect((await call('POST', `/wallets/${Bun.randomUUIDv7()}/reconciliation`)).status).toBe(404);
  });
});

describe('HTTP sob concorrência', () => {
  test('50 requisições idênticas em paralelo: um 201 e 49 replays 200', async () => {
    const w = await newWallet('100.00');
    const body = tx(w, { money: money('30.00') });
    const results = await Promise.all(Array.from({ length: 50 }, () => post(body)));

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(49);
    expect((await call('GET', `/wallets/${w.walletId}`)).json.balance).toEqual(money('70.00'));
    expect((await call('POST', `/wallets/${w.walletId}/reconciliation`)).json.consistent).toBe(true);
  });

  test('100.00 e duas apostas de 80.00: um 201 e um 422, saldo 20.00', async () => {
    const w = await newWallet('100.00');
    const [a, b] = await Promise.all([post(tx(w, { money: money('80.00') })), post(tx(w, { money: money('80.00') }))]);
    expect([a.status, b.status].sort()).toEqual([201, 422]);
    expect((await call('GET', `/wallets/${w.walletId}`)).json.balance).toEqual(money('20.00'));
  });
});
