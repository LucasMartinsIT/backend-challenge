import { describe, expect, test } from 'bun:test';
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  InboxPayloadMismatchError,
  WalletNotFoundError,
} from '../../src/application/errors';
import type { SubmitWagerCommand, SubmitWagerResult } from '../../src/application/submit-wager-transaction';
import { InvalidMoneyError, InvalidTransactionError } from '../../src/domain/errors/domain-errors';
import { WagerMessageHandler } from '../../src/interfaces/sqs/wager-message-handler';

const data = {
  providerId: 'prov',
  externalTransactionId: 'ext-1',
  idempotencyKey: 'prov:ext-1',
  playerId: 'p1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'r1',
  gameId: 'g1',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};
const message = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    messageId: 'msg-1',
    type: 'WagerTransactionRequested',
    occurredAt: '2026-07-29T15:00:00.000Z',
    data,
    ...over,
  });

const ok = (over: Partial<SubmitWagerResult> = {}): SubmitWagerResult => ({
  transactionId: 't1',
  status: 'PROCESSED' as never,
  balance: { amount: '75.00', currency: 'BRL' },
  idempotentReplay: false,
  ...over,
});

function handlerWith(fn: (cmd: SubmitWagerCommand) => Promise<SubmitWagerResult>) {
  const calls: SubmitWagerCommand[] = [];
  const handler = new WagerMessageHandler({
    execute: (cmd) => {
      calls.push(cmd);
      return fn(cmd);
    },
  });
  return { handler, calls };
}

describe('WagerMessageHandler: mensagens inválidas vão para a DLQ', () => {
  const never = async () => ok();

  test('JSON quebrado', async () => {
    const { handler, calls } = handlerWith(never);
    expect(await handler.handle('{nao-e-json')).toMatchObject({ action: 'dead-letter', reason: 'INVALID_JSON' });
    expect(calls).toHaveLength(0);
  });

  test.each([
    ['tipo desconhecido', { type: 'Outra' }],
    ['sem messageId', { messageId: undefined }],
    ['walletId que não é uuid', { data: { ...data, walletId: 'x' } }],
    ['kind inexistente', { data: { ...data, kind: 'TIP' } }],
    ['sem idempotencyKey', { data: { ...data, idempotencyKey: undefined } }],
    ['amount numérico', { data: { ...data, money: { amount: 25, currency: 'BRL' } } }],
  ])('%s', async (_name, over) => {
    const { handler, calls } = handlerWith(never);
    const d = await handler.handle(message(over));
    expect(d.action).toBe('dead-letter');
    expect(calls).toHaveLength(0);
  });
});

describe('WagerMessageHandler: uso do use case', () => {
  test('repassa os dados, usa o messageId como correlação e monta a inbox', async () => {
    const { handler, calls } = handlerWith(async () => ok());
    expect(await handler.handle(message())).toMatchObject({ action: 'ack', outcome: 'processed' });
    expect(calls[0]).toMatchObject({
      ...data,
      correlationId: 'msg-1',
      inbox: { consumerName: 'wager-transactions', messageId: 'msg-1' },
    });
    expect(calls[0]!.inbox!.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('o hash da inbox não depende da ordem das chaves', async () => {
    const { handler, calls } = handlerWith(async () => ok());
    await handler.handle(message());
    const reordered = { ...data, money: { currency: 'BRL', amount: '25.00' }, kind: 'BET' };
    await handler.handle(message({ data: Object.fromEntries(Object.entries(reordered).reverse()) }));
    expect(calls[0]!.inbox!.payloadHash).toBe(calls[1]!.inbox!.payloadHash);
  });

  test.each([
    [{ idempotentReplay: true }, 'replay'],
    [{ status: 'REJECTED' as never }, 'rejected'],
    [{ status: 'PENDING_REFERENCE' as never }, 'pending'],
  ])('resultado %p vira ack/%s', async (over, outcome) => {
    const { handler } = handlerWith(async () => ok(over));
    expect(await handler.handle(message())).toMatchObject({ action: 'ack', outcome });
  });
});

describe('WagerMessageHandler: classificação dos erros', () => {
  const failing = (err: unknown) => handlerWith(async () => Promise.reject(err)).handler;

  test.each([
    ['dinheiro inválido', new InvalidMoneyError('x')],
    ['transação inválida', new InvalidTransactionError('x')],
    ['inbox com conteúdo diferente', new InboxPayloadMismatchError('x')],
  ])('permanente (%s) -> DLQ', async (_n, err) => {
    expect((await failing(err).handle(message())).action).toBe('dead-letter');
  });

  test.each([
    ['conflito de idempotência', new IdempotencyConflictError('x')],
    ['conflito de id externo', new ExternalTransactionConflictError('x')],
    ['wallet inexistente', new WalletNotFoundError('w')],
  ])('negócio terminal (%s) -> ack', async (_n, err) => {
    expect(await failing(err).handle(message())).toMatchObject({ action: 'ack', outcome: 'business-error' });
  });

  test.each([
    ['deadlock', Object.assign(new Error('deadlock'), { code: '40P01' })],
    ['lock timeout', Object.assign(new Error('lock'), { code: '55P03' })],
    ['conexão recusada', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })],
  ])('transitório (%s) -> retry', async (_n, err) => {
    expect((await failing(err).handle(message())).action).toBe('retry');
  });

  test('erro desconhecido também tenta de novo (a fila limita as tentativas)', async () => {
    const d = await failing(new Error('bug')).handle(message());
    expect(d).toMatchObject({ action: 'retry' });
    expect((d as { reason: string }).reason).toContain('UNEXPECTED');
  });
});
