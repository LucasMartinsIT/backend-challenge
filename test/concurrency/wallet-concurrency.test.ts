import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { FailureCode } from '../../src/domain/wagering/failure-code';
import { WagerTransactionStatus as S } from '../../src/domain/wagering/wager-transaction';
import { type Harness, buildHarness } from '../integration/harness';
import { createTestOrm, resetSchema } from '../integration/support';

let orm: MikroORM;
let h: Harness;

beforeAll(async () => {
  orm = await createTestOrm();
  await resetSchema(orm);
  h = buildHarness(orm);
});
afterAll(() => orm.close());

const money = (amount: string) => ({ amount, currency: 'BRL' });

async function expectConsistent(walletId: string) {
  const rec = await h.ledgerMatchesBalance(walletId);
  expect(rec.consistent).toBe(true);
}

describe('concorrência na mesma wallet', () => {
  test('cenário do enunciado: 100.00 e duas apostas simultâneas de 80.00', async () => {
    const w = await h.wallet('100.00');
    const [a, b] = await Promise.all([
      h.submit.execute(h.command(w, { money: money('80.00') })),
      h.submit.execute(h.command(w, { money: money('80.00') })),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([S.Processed, S.Rejected]);
    expect([a, b].find((r) => r.status === S.Rejected)!.failureCode).toBe(FailureCode.InsufficientFunds);

    expect((await h.queries.getWallet(w.walletId)).balance).toEqual(money('20.00'));
    const debits = await h.raw(
      `select 1 from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`,
      [w.walletId],
    );
    expect(debits).toHaveLength(1);
    await expectConsistent(w.walletId);
  });

  test('a mesma aposta enviada 50 vezes em paralelo gera um único débito', async () => {
    const w = await h.wallet('100.00');
    const cmd = h.command(w, { money: money('30.00') });

    const results = await Promise.all(Array.from({ length: 50 }, () => h.submit.execute(cmd)));

    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(results.filter((r) => r.idempotentReplay)).toHaveLength(49);
    expect(results.every((r) => r.status === S.Processed && r.balance.amount === '70.00')).toBe(true);

    expect((await h.queries.getWallet(w.walletId)).balance).toEqual(money('70.00'));
    expect(await h.ledgerCount(w.walletId)).toBe(2); // OPENING + 1 débito
    expect((await h.events(w.walletId, 'WagerTransactionProcessed')).length).toBe(2);
    await expectConsistent(w.walletId);
  });

  test('hot wallet: 40 apostas distintas de 10.00 contra 100.00 aceitam exatamente 10', async () => {
    const w = await h.wallet('100.00');
    const results = await Promise.all(
      Array.from({ length: 40 }, () => h.submit.execute(h.command(w, { money: money('10.00') }))),
    );

    expect(results.filter((r) => r.status === S.Processed)).toHaveLength(10);
    expect(results.filter((r) => r.status === S.Rejected)).toHaveLength(30);
    expect((await h.queries.getWallet(w.walletId)).balance).toEqual(money('0.00'));
    expect(await h.ledgerCount(w.walletId)).toBe(11);
    await expectConsistent(w.walletId);
  });

  test('misto: duplicatas e apostas diferentes ao mesmo tempo', async () => {
    const w = await h.wallet('100.00');
    const repeated = h.command(w, { money: money('20.00') });
    const calls = [
      ...Array.from({ length: 15 }, () => h.submit.execute(repeated)),
      ...Array.from({ length: 15 }, () => h.submit.execute(h.command(w, { money: money('10.00') }))),
    ];
    await Promise.all(calls);

    // 20.00 (uma vez) + 15 x 10.00 = 170.00 > 100.00, então nem tudo cabe; o saldo nunca fica negativo
    const view = await h.queries.getWallet(w.walletId);
    expect(Number(view.balance.amount)).toBeGreaterThanOrEqual(0);
    const debits = await h.raw<{ n: number }>(
      `select count(*)::int as n from wallet_ledger_entries l
        join wager_transactions t on t.id = l.transaction_id
        where l.wallet_id = ? and t.external_transaction_id = ?`,
      [w.walletId, repeated.externalTransactionId],
    );
    expect(debits[0]!.n).toBeLessThanOrEqual(1);
    await expectConsistent(w.walletId);
  });

  test('reversões concorrentes da mesma BET: só uma passa', async () => {
    const w = await h.wallet('100.00');
    const bet = h.command(w, { money: money('30.00') });
    await h.submit.execute(bet);

    const kinds = ['REFUND', 'ROLLBACK', 'REFUND', 'ROLLBACK', 'REFUND', 'ROLLBACK'] as const;
    const results = await Promise.all(
      kinds.map((kind) =>
        h.submit.execute(
          h.command(w, {
            kind: kind as never,
            money: money('30.00'),
            referenceExternalTransactionId: bet.externalTransactionId,
          }),
        ),
      ),
    );

    expect(results.filter((r) => r.status === S.Processed)).toHaveLength(1);
    expect(results.filter((r) => r.failureCode === FailureCode.ReferenceAlreadyReversed)).toHaveLength(5);
    expect((await h.queries.getWallet(w.walletId)).balance).toEqual(money('100.00'));
    await expectConsistent(w.walletId);
  });
});

describe('concorrência entre wallets', () => {
  test('wallets distintas em paralelo não interferem entre si', async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => h.wallet('100.00')));
    await Promise.all(
      wallets.flatMap((w) =>
        Array.from({ length: 5 }, () => h.submit.execute(h.command(w, { money: money('10.00') }))),
      ),
    );
    for (const w of wallets) {
      expect((await h.queries.getWallet(w.walletId)).balance).toEqual(money('50.00'));
      await expectConsistent(w.walletId);
    }
  });

  test('criações simultâneas da mesma wallet: só uma vence', async () => {
    const player = Bun.randomUUIDv7();
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        h.createWallet.execute({ playerId: player, initialBalance: money('50.00'), correlationId: 'c' }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((r) => r.status === 'rejected')) {
      expect((r as PromiseRejectedResult).reason.code).toBe('WALLET_ALREADY_EXISTS');
    }
    const rows = await h.raw('select 1 from wallets where player_id = ?', [player]);
    expect(rows).toHaveLength(1);
  });

  test('mesma chave de idempotência em wallets diferentes: conflito, nunca duas transações', async () => {
    const w1 = await h.wallet('100.00');
    const w2 = await h.wallet('100.00');
    const ext = `shared-${Bun.randomUUIDv7()}`;
    const results = await Promise.allSettled([
      h.submit.execute(h.command(w1, { ext, money: money('10.00') })),
      h.submit.execute(h.command(w2, { ext, money: money('10.00') })),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rows = await h.raw('select 1 from wager_transactions where external_transaction_id = ?', [ext]);
    expect(rows).toHaveLength(1);
    const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(loser.reason.code).toBe('IDEMPOTENCY_CONFLICT');
  });
});
