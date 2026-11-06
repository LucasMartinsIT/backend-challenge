import { describe, expect, test } from 'bun:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import pinoHttp from 'pino-http';
import {
  buildHandledLog,
  pinoHttpOptions,
  resolveCorrelationId,
} from '../../src/infrastructure/observability/logging';
import { Metrics } from '../../src/infrastructure/observability/metrics';
import { safeErrorSummary } from '../../src/infrastructure/observability/safe-error';

describe('safeErrorSummary', () => {
  test('erro de banco: sem a mensagem, que pode trazer o SQL com valores', () => {
    const err = Object.assign(new Error('insert into wallets (balance) values (999.99) - duplicate key'), {
      name: 'UniqueConstraintViolationException',
      code: '23505',
      constraint: 'wallets_player_currency_unique',
    });
    const summary = safeErrorSummary(err);
    expect(summary).toContain('code=23505');
    expect(summary).toContain('constraint=wallets_player_currency_unique');
    expect(summary).not.toContain('999.99');
    expect(summary).not.toContain('insert into');
  });

  test('erro comum mantém a mensagem', () => {
    expect(safeErrorSummary(new Error('algo quebrou'))).toBe('Error algo quebrou');
  });

  test('erro de rede mantém a mensagem (código não é SQLSTATE)', () => {
    const err = Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' });
    expect(safeErrorSummary(err)).toContain('connect refused');
  });

  test('valor que não é Error', () => {
    expect(safeErrorSummary('texto')).toBe('texto');
    expect(safeErrorSummary(undefined)).toBe('undefined');
  });
});

describe('buildHandledLog', () => {
  const event = {
    correlationId: 'corr-1',
    messageId: 'msg-1',
    transactionId: 'tx-1',
    walletId: 'w-1',
    providerId: 'prov',
    kind: 'BET',
    status: 'REJECTED',
    failureCode: 'INSUFFICIENT_FUNDS' as never,
    idempotentReplay: false,
    durationMs: 12.3456,
  };

  test('traz os campos de correlação exigidos', () => {
    expect(buildHandledLog(event)).toMatchObject({
      correlationId: 'corr-1',
      messageId: 'msg-1',
      transactionId: 'tx-1',
      walletId: 'w-1',
      providerId: 'prov',
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      durationMs: 12.3,
    });
  });

  test('não carrega valores monetários', () => {
    const json = JSON.stringify(buildHandledLog(event));
    expect(json).not.toMatch(/amount|money|balance|saldo/i);
  });
});

describe('correlation id', () => {
  test('aceita um id razoável e troca o que não presta', () => {
    expect(resolveCorrelationId('meu-id_1.2:3')).toBe('meu-id_1.2:3');
    expect(resolveCorrelationId('tem espaço')).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolveCorrelationId('x'.repeat(200))).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolveCorrelationId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolveCorrelationId(['a', 'b'])).toBe('a');
  });
});

describe('log HTTP de verdade (pino-http com a configuração da aplicação)', () => {
  async function withLoggedServer(
    handler: (res: { locals?: unknown }) => void,
    run: (url: string, lines: () => Array<Record<string, any>>, rawLines: () => string[]) => Promise<void>,
  ) {
    const written: string[] = [];
    const logger = pinoHttp(pinoHttpOptions({ LOG_LEVEL: 'info', INSTANCE_ID: 'test-1' }) as never, {
      write: (line: string) => void written.push(line),
    } as never);
    const server = createServer((req, res) => {
      logger(req, res);
      const r = res as typeof res & { locals?: unknown };
      r.locals = {};
      handler(r);
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await run(url, () => written.map((l) => JSON.parse(l)), () => written);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  test('loga correlationId e contexto; não loga cabeçalhos nem corpo', async () => {
    await withLoggedServer(
      (res) => {
        res.locals = { logContext: { walletId: 'w-9', transactionId: 'tx-9', providerId: 'prov-a' } };
      },
      async (url, lines, rawLines) => {
        const res = await fetch(`${url}/wagering/transactions`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer segredo-123',
            cookie: 'sessao=abc',
            'x-correlation-id': 'corr-123',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ money: { amount: '999.99', currency: 'BRL' } }),
        });
        expect(res.headers.get('x-correlation-id')).toBe('corr-123');
        await Bun.sleep(20);

        const [line] = lines();
        expect(line).toMatchObject({
          correlationId: 'corr-123',
          walletId: 'w-9',
          transactionId: 'tx-9',
          providerId: 'prov-a',
          instance: 'test-1',
          res: { statusCode: 200 },
        });
        expect(line!.req).toEqual({ id: 'corr-123', method: 'POST', url: '/wagering/transactions' });
        const raw = JSON.stringify(line);
        // cada chave aparece uma vez: sem campo duplicado na linha final
        const rawLine = rawLines()[0]!;
        expect(rawLine.match(/"correlationId":/g)).toHaveLength(1);
        expect(rawLine.match(/"walletId":/g)).toHaveLength(1);
        expect(raw).not.toContain('segredo-123');
        expect(raw).not.toContain('sessao=abc');
        expect(raw).not.toContain('999.99');
      },
    );
  });

  test('health e metrics não geram log', async () => {
    await withLoggedServer(
      () => {},
      async (url, lines) => {
        await fetch(`${url}/health/live`);
        await fetch(`${url}/health/ready`);
        await fetch(`${url}/metrics`);
        await Bun.sleep(20);
        expect(lines()).toHaveLength(0);
      },
    );
  });

  test('id de correlação inválido é substituído por um gerado', async () => {
    await withLoggedServer(
      () => {},
      async (url, lines) => {
        const res = await fetch(`${url}/qualquer`, { headers: { 'x-correlation-id': 'com espaço e <script>' } });
        await Bun.sleep(20);
        const generated = res.headers.get('x-correlation-id')!;
        expect(generated).toMatch(/^[0-9a-f-]{36}$/);
        expect(lines()[0]!.correlationId).toBe(generated);
      },
    );
  });
});

describe('Metrics', () => {
  const EXPECTED = [
    'wager_transactions_total',
    'idempotent_replays_total',
    'inbox_duplicates_total',
    'sqs_retries_total',
    'sqs_dlq_total',
    'lock_conflicts_total',
    'outbox_lag_seconds',
    'outbox_pending',
    'wager_processing_seconds',
    'reconciliation_mismatches_total',
  ];

  test('expõe todas as métricas exigidas pelo enunciado', async () => {
    const output = await new Metrics().registry.metrics();
    for (const name of EXPECTED) expect(output).toContain(`# TYPE ${name} `);
  });

  test('contadores com rótulo e histograma', async () => {
    const m = new Metrics();
    m.transactions.inc({ status: 'PROCESSED', kind: 'BET' });
    m.transactions.inc({ status: 'PROCESSED', kind: 'BET' });
    m.lockConflicts.inc({ code: '40P01' });
    m.processingSeconds.observe({ kind: 'BET' }, 0.02);
    const out = await m.registry.metrics();
    expect(out).toContain('wager_transactions_total{status="PROCESSED",kind="BET"} 2');
    expect(out).toContain('lock_conflicts_total{code="40P01"} 1');
    expect(out).toContain('wager_processing_seconds_count{kind="BET"} 1');
  });

  test('gauges da outbox são lidas na hora do scrape', async () => {
    const m = new Metrics();
    let stats = { pending: 3, oldestAgeSeconds: 12, failed: 1 };
    m.bindOutboxGauges(async () => stats);
    let out = await m.registry.metrics();
    expect(out).toContain('outbox_lag_seconds 12');
    expect(out).toContain('outbox_pending 3');
    expect(out).toContain('outbox_failed 1');

    stats = { pending: 0, oldestAgeSeconds: 0, failed: 1 };
    out = await m.registry.metrics();
    expect(out).toContain('outbox_pending 0');
  });

  test('se o banco falhar no scrape, o /metrics continua respondendo', async () => {
    const m = new Metrics();
    m.bindOutboxGauges(async () => {
      throw new Error('banco fora');
    });
    expect(await m.registry.metrics()).toContain('# TYPE outbox_lag_seconds gauge');
  });

  test('registries são independentes entre instâncias', async () => {
    const a = new Metrics();
    const b = new Metrics();
    a.idempotentReplays.inc();
    expect(await b.registry.metrics()).toContain('idempotent_replays_total 0');
  });
});
