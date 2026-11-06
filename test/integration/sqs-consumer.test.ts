import { ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { SqsWagerConsumer } from '../../src/interfaces/sqs/sqs-wager-consumer';
import { type MessageDecision, WagerMessageHandler } from '../../src/interfaces/sqs/wager-message-handler';
import { type Harness, buildHarness } from './harness';
import { createTestOrm, resetSchema } from './support';
import { type TestQueues, createTestQueues, drain, isDrained, send, sleep, sqs, waitFor } from './sqs-support';

let orm: MikroORM;
let h: Harness;
const queuesToClean: TestQueues[] = [];
const consumersToStop: SqsWagerConsumer[] = [];

beforeAll(async () => {
  orm = await createTestOrm();
  await resetSchema(orm);
  h = buildHarness(orm);
});
afterEach(async () => {
  await Promise.all(consumersToStop.splice(0).map((c) => c.stop()));
});
afterAll(async () => {
  await Promise.all(queuesToClean.map((q) => q.cleanup()));
  await orm.close();
});

async function setup(
  opts: {
    handler?: { handle(b: string): Promise<MessageDecision> };
    maxReceive?: number;
    visibility?: number;
    consumer?: { visibilityTimeoutSeconds?: number };
  } = {},
) {
  const queues = await createTestQueues(opts.maxReceive ?? 3, opts.visibility ?? 5);
  queuesToClean.push(queues);
  const consumer = new SqsWagerConsumer(sqs, opts.handler ?? new WagerMessageHandler(h.submit), {
    ...queues,
    waitTimeSeconds: 1,
    retryBaseSeconds: 1,
    shutdownTimeoutMs: 8000,
    ...opts.consumer,
  });
  consumersToStop.push(consumer);
  return { queues, consumer };
}

const money = (amount: string) => ({ amount, currency: 'BRL' });

function wagerMessage(w: { walletId: string; playerId: string }, over: Record<string, unknown> = {}, dataOver: Record<string, unknown> = {}) {
  const ext = `ext-${Bun.randomUUIDv7()}`;
  return {
    messageId: `msg-${Bun.randomUUIDv7()}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'prov',
      externalTransactionId: ext,
      idempotencyKey: `prov:${ext}`,
      playerId: w.playerId,
      walletId: w.walletId,
      roundId: 'r1',
      gameId: 'g1',
      kind: 'BET',
      money: money('25.00'),
      ...dataOver,
    },
    ...over,
  };
}

const balanceOf = async (walletId: string) => (await h.queries.getWallet(walletId)).balance;

describe('consumidor SQS', () => {
  test('mensagem válida é aplicada, gravada na inbox e removida da fila só depois do commit', async () => {
    const { queues, consumer } = await setup();
    const w = await h.wallet('100.00');
    const msg = wagerMessage(w);
    consumer.start();
    await send(queues.queueUrl, msg, w.walletId);

    await waitFor(async () => (await balanceOf(w.walletId)).amount === '75.00', 15_000, 'débito');
    await waitFor(() => isDrained(queues.queueUrl), 10_000, 'fila vazia');

    const [inbox] = await h.raw('select processed_at from inbox_messages where message_id = ?', [msg.messageId]);
    expect(inbox.processed_at).not.toBeNull();
    expect(await h.ledgerCount(w.walletId)).toBe(2);
    expect((await h.ledgerMatchesBalance(w.walletId)).consistent).toBe(true);
    expect(await drain(queues.dlqUrl, 500)).toHaveLength(0);
  });

  test('a mesma mensagem entregue várias vezes só debita uma vez', async () => {
    const { queues, consumer } = await setup();
    const w = await h.wallet('100.00');
    const msg = wagerMessage(w);
    consumer.start();
    // ids de deduplicação diferentes: o SQS não barra, quem barra é a inbox
    for (let i = 0; i < 5; i++) await send(queues.queueUrl, msg, w.walletId, `d-${i}`);

    await waitFor(() => isDrained(queues.queueUrl), 20_000, 'fila vazia');
    expect(await balanceOf(w.walletId)).toEqual(money('75.00'));
    expect(await h.ledgerCount(w.walletId)).toBe(2);
    const inbox = await h.raw('select 1 from inbox_messages where message_id = ?', [msg.messageId]);
    expect(inbox).toHaveLength(1);
  });

  test('rejeição de negócio é confirmada (ack) e fica registrada, sem ir para a DLQ', async () => {
    const { queues, consumer } = await setup();
    const w = await h.wallet('10.00');
    const msg = wagerMessage(w, {}, { money: money('50.00') });
    consumer.start();
    await send(queues.queueUrl, msg, w.walletId);

    await waitFor(() => isDrained(queues.queueUrl), 15_000, 'fila vazia');
    const view = await h.queries.getTransactionByExternalId('prov', msg.data.externalTransactionId);
    expect(view).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' });
    expect(await balanceOf(w.walletId)).toEqual(money('10.00'));
    expect(await drain(queues.dlqUrl, 500)).toHaveLength(0);
  });

  test('wallet inexistente é erro de negócio terminal: ack, nada na DLQ', async () => {
    const { queues, consumer } = await setup();
    consumer.start();
    await send(queues.queueUrl, wagerMessage({ walletId: Bun.randomUUIDv7(), playerId: 'x' }));
    await waitFor(() => isDrained(queues.queueUrl), 15_000, 'fila vazia');
    expect(await drain(queues.dlqUrl, 500)).toHaveLength(0);
  });

  test('mensagens que nunca vão funcionar vão para a DLQ com o motivo', async () => {
    const { queues, consumer } = await setup();
    const w = await h.wallet('100.00');
    consumer.start();

    await send(queues.queueUrl, '{isto-nao-e-json', 'a');
    await send(queues.queueUrl, wagerMessage(w, { type: 'Outro' }), 'b');
    await send(queues.queueUrl, wagerMessage(w, {}, { kind: 'OPENING' }), 'c');
    await send(queues.queueUrl, wagerMessage(w, {}, { money: money('1.234') }), 'd');

    await waitFor(() => isDrained(queues.queueUrl), 15_000, 'fila principal vazia');
    const dead = await drain(queues.dlqUrl, 4000);
    expect(dead).toHaveLength(4);
    const reasons = dead.map((d) => d.attributes.failureReason ?? '');
    expect(reasons.some((r) => r.startsWith('INVALID_JSON'))).toBe(true);
    expect(reasons.some((r) => r.startsWith('INVALID_MESSAGE'))).toBe(true);
    expect(reasons.some((r) => r.startsWith('INVALID_TRANSACTION'))).toBe(true);
    expect(reasons.some((r) => r.startsWith('INVALID_MONEY'))).toBe(true);
    expect(await balanceOf(w.walletId)).toEqual(money('100.00'));
  });

  test('mesmo messageId com conteúdo diferente vai para a DLQ e não aplica nada', async () => {
    const { queues, consumer } = await setup();
    const w = await h.wallet('100.00');
    const first = wagerMessage(w);
    const forged = wagerMessage(w, { messageId: first.messageId });
    consumer.start();
    await send(queues.queueUrl, first, w.walletId);
    await waitFor(async () => (await balanceOf(w.walletId)).amount === '75.00', 15_000, 'primeira aplicada');
    await send(queues.queueUrl, forged, w.walletId);

    await waitFor(() => isDrained(queues.queueUrl), 15_000, 'fila vazia');
    const dead = await drain(queues.dlqUrl, 3000);
    expect(dead).toHaveLength(1);
    expect(dead[0]!.attributes.failureReason).toStartWith('INBOX_PAYLOAD_MISMATCH');
    expect(await balanceOf(w.walletId)).toEqual(money('75.00'));
  });
});

describe('falhas transitórias', () => {
  test('retry com backoff: falha duas vezes e na terceira processa', async () => {
    let calls = 0;
    const real = new WagerMessageHandler(h.submit);
    const flaky = {
      handle: async (body: string): Promise<MessageDecision> => {
        calls++;
        if (calls <= 2) return { action: 'retry', reason: 'TRANSIENT: banco fora' };
        return real.handle(body);
      },
    };
    const { queues, consumer } = await setup({ handler: flaky, maxReceive: 5 });
    const w = await h.wallet('100.00');
    consumer.start();
    const started = Date.now();
    await send(queues.queueUrl, wagerMessage(w), w.walletId);

    await waitFor(async () => (await balanceOf(w.walletId)).amount === '75.00', 30_000, 'processamento após retries');
    expect(calls).toBe(3);
    // backoff 1s + 2s: não pode ter sido instantâneo
    expect(Date.now() - started).toBeGreaterThanOrEqual(2500);
    expect(await h.ledgerCount(w.walletId)).toBe(2);
  });

  test('esgotadas as tentativas, a fila move a mensagem para a DLQ', async () => {
    const alwaysFails = { handle: async (): Promise<MessageDecision> => ({ action: 'retry', reason: 'TRANSIENT: sempre' }) };
    const { queues, consumer } = await setup({ handler: alwaysFails, maxReceive: 3 });
    const w = await h.wallet('100.00');
    consumer.start();
    await send(queues.queueUrl, wagerMessage(w), w.walletId);

    let dead: Awaited<ReturnType<typeof drain>> = [];
    await waitFor(
      async () => {
        dead = dead.concat(await drain(queues.dlqUrl, 1000));
        return dead.length > 0;
      },
      60_000,
      'mensagem na DLQ',
    );
    expect(dead).toHaveLength(1);
    expect(await balanceOf(w.walletId)).toEqual(money('100.00'));
  });
});

describe('recuperação após falhas', () => {
  test('worker morre depois do commit e antes do ack: a redelivery não duplica o débito', async () => {
    const { queues, consumer } = await setup({ visibility: 30 });
    const w = await h.wallet('100.00');
    const msg = wagerMessage(w);
    await send(queues.queueUrl, msg, w.walletId);

    // "worker que morreu": recebe, processa e commita, mas nunca confirma
    const received = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queues.queueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 5, VisibilityTimeout: 2 }),
    );
    expect(received.Messages).toHaveLength(1);
    const decision = await new WagerMessageHandler(h.submit).handle(received.Messages![0]!.Body!);
    expect(decision).toMatchObject({ action: 'ack', outcome: 'processed' });
    expect(await balanceOf(w.walletId)).toEqual(money('75.00'));

    // outra instância assume quando a visibilidade expira
    consumer.start();
    await waitFor(() => isDrained(queues.queueUrl), 20_000, 'fila vazia');
    expect(await balanceOf(w.walletId)).toEqual(money('75.00'));
    expect(await h.ledgerCount(w.walletId)).toBe(2);
    expect((await h.ledgerMatchesBalance(w.walletId)).consistent).toBe(true);
  });

  test('shutdown gracioso: termina o que começou, devolve o resto e nada se perde nem duplica', async () => {
    const { queues, consumer } = await setup();
    const wallets = await Promise.all(Array.from({ length: 8 }, () => h.wallet('100.00')));
    for (const w of wallets) await send(queues.queueUrl, wagerMessage(w), w.walletId);

    consumer.start();
    await sleep(300);
    await consumer.stop(); // SIGTERM simulado com mensagens possivelmente em andamento

    // uma segunda instância termina o trabalho
    const second = new SqsWagerConsumer(sqs, new WagerMessageHandler(h.submit), {
      ...queues,
      waitTimeSeconds: 1,
      retryBaseSeconds: 1,
    });
    consumersToStop.push(second);
    second.start();

    await waitFor(() => isDrained(queues.queueUrl), 30_000, 'fila vazia');
    for (const w of wallets) {
      expect(await balanceOf(w.walletId)).toEqual(money('75.00'));
      expect(await h.ledgerCount(w.walletId)).toBe(2);
    }
  });
});

describe('ordem dentro do grupo FIFO', () => {
  const idOf = (body: string) => (JSON.parse(body) as { messageId: string }).messageId;

  test('retry na frente do grupo segura as mensagens seguintes', async () => {
    const calls: string[] = [];
    let firstFailed = false;
    const handler = {
      handle: async (body: string): Promise<MessageDecision> => {
        const id = idOf(body);
        calls.push(id);
        if (id === 'A' && !firstFailed) {
          firstFailed = true;
          return { action: 'retry', reason: 'TRANSIENT: primeira tentativa' };
        }
        return { action: 'ack', outcome: 'processed', messageId: id };
      },
    };
    const { queues, consumer } = await setup({ handler, maxReceive: 10 });
    const w = await h.wallet('100.00');
    for (const id of ['A', 'B', 'C']) {
      await send(queues.queueUrl, { ...wagerMessage(w), messageId: id }, w.walletId);
    }
    consumer.start();

    await waitFor(() => isDrained(queues.queueUrl), 30_000, 'fila vazia');
    // A falha uma vez, é repetida, e só depois vêm B e C: a ordem original é preservada
    expect(calls).toEqual(['A', 'A', 'B', 'C']);
  });

  test('lote lento devolve o resto do grupo em vez de estourar o visibility timeout', async () => {
    const calls: string[] = [];
    const handler = {
      handle: async (body: string): Promise<MessageDecision> => {
        calls.push(idOf(body));
        await sleep(1500);
        return { action: 'ack', outcome: 'processed' };
      },
    };
    const { queues, consumer } = await setup({
      handler,
      visibility: 5,
      consumer: { visibilityTimeoutSeconds: 5 },
    });
    const w = await h.wallet('100.00');
    const ids = ['m1', 'm2', 'm3', 'm4', 'm5'];
    for (const id of ids) await send(queues.queueUrl, { ...wagerMessage(w), messageId: id }, w.walletId);
    consumer.start();

    await waitFor(() => isDrained(queues.queueUrl), 40_000, 'fila vazia');
    // cada mensagem processada exatamente uma vez e na ordem de envio
    expect(calls).toEqual(ids);
  });
});
