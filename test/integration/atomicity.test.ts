import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { UnitOfWork } from '../../src/application/ports';
import { SubmitWagerTransaction } from '../../src/application/submit-wager-transaction';
import { systemClock, uuidV7Generator } from '../../src/application/support';
import { type Harness, buildHarness } from './harness';
import { createTestOrm, resetSchema } from './support';

let orm: MikroORM;
let h: Harness;

beforeAll(async () => {
  orm = await createTestOrm();
  await resetSchema(orm);
  h = buildHarness(orm);
});
afterAll(() => orm.close());

type FailurePoint =
  | 'inbox.tryReceive'
  | 'transactions.insert'
  | 'ledger.append'
  | 'wallets.saveBalance'
  | 'outbox.add'
  | 'inbox.markProcessed';

/** Um UnitOfWork real (Postgres) em que UMA operação específica falha no meio da transação. */
function failingAt(point: FailurePoint): UnitOfWork {
  const [repo, method] = point.split('.') as [keyof Parameters<Parameters<UnitOfWork['run']>[0]>[0], string];
  return {
    run: (work, options) =>
      h.uow.run((repos) => {
        const broken = Object.create(repos[repo] as object) as Record<string, unknown>;
        broken[method] = async () => {
          throw new Error('falha injetada');
        };
        return work({ ...repos, [repo]: broken });
      }, options),
  };
}

const money = (amount: string) => ({ amount, currency: 'BRL' });

async function snapshotOf(walletId: string, ext: string, messageId: string) {
  const one = async (sql: string, params: unknown[]) => (await h.raw<{ n: number }>(sql, params))[0]!.n;
  const w = await h.queries.getWallet(walletId);
  return {
    balance: w.balance.amount,
    version: w.version,
    ledger: await h.ledgerCount(walletId),
    transactions: await one(
      'select count(*)::int as n from wager_transactions where wallet_id = ? and external_transaction_id = ?',
      [walletId, ext],
    ),
    inbox: await one('select count(*)::int as n from inbox_messages where message_id = ?', [messageId]),
    outbox: await one('select count(*)::int as n from outbox_messages where aggregate_id = ?', [walletId]),
  };
}

describe('atomicidade: transação, ledger, saldo, inbox e outbox entram juntos ou nenhum entra', () => {
  const points: FailurePoint[] = [
    'inbox.tryReceive',
    'transactions.insert',
    'ledger.append',
    'wallets.saveBalance',
    'outbox.add',
    'inbox.markProcessed',
  ];

  test.each(points)('falha em %s desfaz tudo; repetir depois aplica uma única vez', async (point) => {
    const w = await h.wallet('100.00');
    const messageId = `msg-${Bun.randomUUIDv7()}`;
    const command = h.command(w, {
      money: money('30.00'),
      inbox: { consumerName: 'wager-transactions', messageId, payloadHash: 'h' },
    });
    const before = await snapshotOf(w.walletId, command.externalTransactionId, messageId);

    const broken = new SubmitWagerTransaction({ uow: failingAt(point), clock: systemClock, ids: uuidV7Generator });
    await expect(broken.execute(command)).rejects.toThrow('falha injetada');

    // nada ficou para trás, em nenhuma das cinco tabelas
    expect(await snapshotOf(w.walletId, command.externalTransactionId, messageId)).toEqual(before);

    // e a repetição, já sem falha, aplica o efeito uma única vez
    const ok = await h.submit.execute(command);
    expect(ok).toMatchObject({ status: 'PROCESSED', idempotentReplay: false });
    const after = await snapshotOf(w.walletId, command.externalTransactionId, messageId);
    expect(after).toMatchObject({ balance: '70.00', version: 2, transactions: 1, inbox: 1 });
    expect(after.ledger).toBe(before.ledger + 1);
    expect((await h.ledgerMatchesBalance(w.walletId)).consistent).toBe(true);
  });

  test('o commit grava as cinco coisas de uma vez quando tudo dá certo', async () => {
    const w = await h.wallet('100.00');
    const messageId = `msg-${Bun.randomUUIDv7()}`;
    const command = h.command(w, {
      money: money('10.00'),
      inbox: { consumerName: 'wager-transactions', messageId, payloadHash: 'h' },
    });
    const before = await snapshotOf(w.walletId, command.externalTransactionId, messageId);
    await h.submit.execute(command);
    const after = await snapshotOf(w.walletId, command.externalTransactionId, messageId);

    expect(after.transactions).toBe(1);
    expect(after.inbox).toBe(1);
    expect(after.ledger).toBe(before.ledger + 1);
    expect(after.outbox).toBe(before.outbox + 2); // Processed + BalanceChanged
    expect(after.balance).toBe('90.00');
  });
});
