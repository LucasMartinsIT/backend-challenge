import { SQSClient } from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { PublishOutbox } from '../../src/application/publish-outbox';
import type { EventPublisher } from '../../src/application/ports';
import { type Clock, systemClock } from '../../src/application/support';
import type { OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { ReadinessChecker } from '../../src/infrastructure/health/readiness-checker';
import { SqsEventPublisher } from '../../src/infrastructure/sqs/sqs-event-publisher';
import { type Harness, buildHarness } from './harness';
import { type TestQueues, createTestQueues, drain, sleep, sqs } from './sqs-support';
import { createTestOrm, resetSchema } from './support';

let orm: MikroORM;
let h: Harness;
let events: TestQueues;

beforeAll(async () => {
  orm = await createTestOrm();
  await resetSchema(orm);
  h = buildHarness(orm);
  events = await createTestQueues();
});
afterAll(async () => {
  await events.cleanup();
  await orm.close();
});

const money = (amount: string) => ({ amount, currency: 'BRL' });
const publisherWith = (publisher: EventPublisher, clock: Clock = systemClock, batchSize = 50, maxAttempts = 20) =>
  new PublishOutbox({ uow: h.uow, publisher, clock }, { batchSize, maxAttempts });

const makeAggregateDue = (walletId: string) =>
  h.raw("update outbox_messages set next_attempt_at = now() - interval '1 second' where aggregate_id = ?", [walletId]);

class RecordingPublisher implements EventPublisher {
  published: string[] = [];
  constructor(private readonly delayMs = 0) {}
  async publish(m: OutboxMessage) {
    if (this.delayMs) await sleep(this.delayMs);
    this.published.push(m.id);
  }
}

const unpublished = async (walletId?: string) =>
  (
    await h.raw<{ n: number }>(
      `select count(*)::int as n from outbox_messages where published_at is null ${walletId ? 'and aggregate_id = ?' : ''}`,
      walletId ? [walletId] : [],
    )
  )[0]!.n;

describe('publicador da outbox', () => {
  test('publica no SQS com grupo = wallet e deduplicação = eventId, e marca como publicado', async () => {
    const w = await h.wallet('100.00');
    await h.submit.execute(h.command(w, { money: money('10.00') }));
    expect(await unpublished(w.walletId)).toBe(4); // OPENING (2 eventos) + BET (2 eventos)

    const publisher = new SqsEventPublisher(sqs, events.queueUrl);
    while ((await publisherWith(publisher).runOnce()) > 0);

    expect(await unpublished(w.walletId)).toBe(0);
    const delivered = (await drain(events.queueUrl, 3000)).map((m) => JSON.parse(m.body));
    const mine = delivered.filter((e) => e.aggregateId === w.walletId);
    expect(mine).toHaveLength(4);
    expect(mine.map((e) => e.eventType).sort()).toEqual([
      'WagerTransactionProcessed',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
      'WalletBalanceChanged',
    ]);
    const changed = mine.filter((e) => e.eventType === 'WalletBalanceChanged');
    expect(changed.map((e) => e.data.walletVersion).sort()).toEqual([1, 2]);
    expect(mine.every((e) => e.version === 1 && e.correlationId && e.eventId)).toBe(true);
  });

  test('falha ao publicar agenda retry com backoff e a mensagem não se perde', async () => {
    const w = await h.wallet('50.00');
    let failing = true;
    const flaky: EventPublisher = {
      publish: async () => {
        if (failing) throw new Error('sqs fora do ar');
      },
    };
    const outbox = publisherWith(flaky);

    await outbox.runOnce();
    const rows = await h.raw(
      'select attempts, next_attempt_at, published_at from outbox_messages where aggregate_id = ? order by occurred_at, id',
      [w.walletId],
    );
    expect(rows).toHaveLength(2);
    // o primeiro evento falhou e gastou tentativa; o segundo só espera por ele
    expect(rows.map((r) => r.attempts)).toEqual([1, 0]);
    for (const r of rows) {
      expect(r.published_at).toBeNull();
      expect(new Date(r.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
    }

    // ainda não venceu: nada a fazer para essas linhas
    failing = false;
    await h.raw('update outbox_messages set next_attempt_at = now() - interval \'1 second\' where aggregate_id = ?', [
      w.walletId,
    ]);
    while ((await outbox.runOnce()) > 0);
    expect(await unpublished(w.walletId)).toBe(0);
  });

  test('publicadores concorrentes nunca pegam a mesma linha', async () => {
    const wallets = await Promise.all(Array.from({ length: 15 }, () => h.wallet('100.00')));
    for (const w of wallets) await h.submit.execute(h.command(w, { money: money('1.00') }));

    const publisher = new RecordingPublisher(30); // lento de propósito, para forçar sobreposição
    const instances = Array.from({ length: 4 }, () => publisherWith(publisher, systemClock, 10));
    await Promise.all(
      instances.map(async (outbox) => {
        while ((await outbox.runOnce()) > 0);
      }),
    );

    expect(await unpublished()).toBe(0);
    const counts = new Map<string, number>();
    for (const id of publisher.published) counts.set(id, (counts.get(id) ?? 0) + 1);
    expect(counts.size).toBe(publisher.published.length);
    expect([...counts.values()].every((n) => n === 1)).toBe(true);
    expect(publisher.published.length).toBeGreaterThanOrEqual(15 * 4);
  });

  test('processo morre depois de enviar e antes do commit: outra instância reenvia e a fila deduplica', async () => {
    // esvazia o que sobrou de outros testes para contar só este evento
    while ((await publisherWith(new RecordingPublisher()).runOnce()) > 0);
    await drain(events.queueUrl, 1000);

    const w = await h.wallet('100.00');
    const sqsPublisher = new SqsEventPublisher(sqs, events.queueUrl);

    // o relógio é consultado antes de enviar (lockDue) e depois (markPublished): lançar na
    // segunda chamada simula a morte do processo entre o envio e o commit
    let calls = 0;
    const dying: Clock = {
      now: () => {
        if (++calls >= 2) throw new Error('processo morreu');
        return new Date();
      },
    };
    await expect(publisherWith(sqsPublisher, dying).runOnce()).rejects.toThrow('processo morreu');
    // o commit não aconteceu: a outbox ainda considera tudo pendente
    expect(await unpublished(w.walletId)).toBe(2);

    // outra instância assume e publica de novo
    while ((await publisherWith(sqsPublisher).runOnce()) > 0);
    expect(await unpublished(w.walletId)).toBe(0);

    const delivered = (await drain(events.queueUrl, 3000)).map((m) => JSON.parse(m.body));
    const mine = delivered.filter((e) => e.aggregateId === w.walletId);
    // cada evento aparece UMA vez, apesar de ter sido enviado duas vezes
    expect(mine).toHaveLength(2);
    expect(new Set(mine.map((e) => e.eventId)).size).toBe(2);
  });

  test('se um evento da wallet falha, os seguintes dela esperam e a ordem se mantém', async () => {
    while ((await publisherWith(new RecordingPublisher()).runOnce()) > 0);
    const w = await h.wallet('100.00');
    await h.submit.execute(h.command(w, { money: money('10.00') }));
    const order = (
      await h.raw<{ id: string }>(
        'select id from outbox_messages where aggregate_id = ? order by occurred_at, id',
        [w.walletId],
      )
    ).map((r) => r.id);
    expect(order).toHaveLength(4);

    const published: string[] = [];
    let failFirst = true;
    const publisher: EventPublisher = {
      publish: async (m) => {
        if (m.id === order[0] && failFirst) throw new Error('destino fora');
        published.push(m.id);
      },
    };
    const outbox = publisherWith(publisher);

    await outbox.runOnce();
    expect(published).toEqual([]); // nada passou na frente do primeiro
    const rows = await h.raw<{ attempts: number; next_attempt_at: string | null }>(
      'select attempts, next_attempt_at from outbox_messages where aggregate_id = ? order by occurred_at, id',
      [w.walletId],
    );
    expect(rows[0]!.attempts).toBe(1);
    for (const later of rows.slice(1)) {
      expect(later.attempts).toBe(0); // esperar não gasta tentativa
      expect(later.next_attempt_at).not.toBeNull();
    }

    failFirst = false;
    await makeAggregateDue(w.walletId);
    while ((await outbox.runOnce()) > 0);
    expect(published).toEqual(order);
  });

  test('mensagem que sempre falha é abandonada e sai do cálculo de lag', async () => {
    while ((await publisherWith(new RecordingPublisher()).runOnce()) > 0);
    const w = await h.wallet('10.00');
    const abandoned: string[] = [];
    const outbox = new PublishOutbox(
      {
        uow: h.uow,
        publisher: {
          publish: async () => {
            throw new Error('payload recusado');
          },
        },
        clock: systemClock,
      },
      { batchSize: 50, maxAttempts: 2, onAbandoned: (m) => abandoned.push(m.id) },
    );

    for (let i = 0; i < 10; i++) {
      await makeAggregateDue(w.walletId);
      await outbox.runOnce();
    }

    const rows = await h.raw<{ failed_at: string | null; published_at: string | null; attempts: number }>(
      'select failed_at, published_at, attempts from outbox_messages where aggregate_id = ?',
      [w.walletId],
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.failed_at !== null && r.published_at === null && r.attempts === 2)).toBe(true);
    expect(abandoned).toHaveLength(2);

    // fora da fila de entrega e fora do lag; contada à parte
    expect(await makeAggregateDue(w.walletId).then(() => outbox.runOnce())).toBe(0);
    const stats = await h.uow.run((r) => r.outbox.stats(new Date()));
    expect(stats.pending).toBe(0);
    expect(stats.oldestAgeSeconds).toBe(0);
    expect(stats.failed).toBeGreaterThanOrEqual(2);
  });

  test('o evento só existe se a transação financeira foi confirmada', async () => {
    const w = await h.wallet('10.00');
    const before = await h.raw<{ n: number }>('select count(*)::int as n from outbox_messages where aggregate_id = ?', [
      w.walletId,
    ]);
    // dispara um erro no meio do use case: chave duplicada com payload diferente
    const cmd = h.command(w, { money: money('5.00') });
    await h.submit.execute(cmd);
    await expect(h.submit.execute({ ...cmd, money: money('6.00') })).rejects.toThrow();
    const after = await h.raw<{ n: number }>('select count(*)::int as n from outbox_messages where aggregate_id = ?', [
      w.walletId,
    ]);
    expect(after[0]!.n - before[0]!.n).toBe(2); // só os eventos da aposta que valeu
  });
});

describe('readiness', () => {
  test('pronto quando Postgres e SQS respondem', async () => {
    const checker = new ReadinessChecker(orm, sqs, [events.queueUrl]);
    expect(await checker.check()).toEqual({ ready: true, checks: { postgres: 'up', sqs: 'up' } });
  });

  test('não pronto quando o SQS está inalcançável', async () => {
    const dead = new SQSClient({
      region: 'us-east-1',
      endpoint: 'http://127.0.0.1:1',
      credentials: { accessKeyId: 'x', secretAccessKey: 'x' },
      maxAttempts: 1,
    });
    const checker = new ReadinessChecker(orm, dead, [events.queueUrl]);
    expect(await checker.check()).toEqual({ ready: false, checks: { postgres: 'up', sqs: 'down' } });
  });
});
