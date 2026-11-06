import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import {
  ReprocessPendingReferences,
  pendingBackoffMs,
} from '../../src/application/reprocess-pending-references';
import type { UnitOfWork } from '../../src/application/ports';
import { systemClock, uuidV7Generator } from '../../src/application/support';
import { FailureCode } from '../../src/domain/wagering/failure-code';
import {
  WagerTransactionKind as K,
  WagerTransactionStatus as S,
} from '../../src/domain/wagering/wager-transaction';
import { type Harness, buildHarness } from './harness';
import { createTestOrm, resetSchema } from './support';

let orm: MikroORM;
let h: Harness;

const options = { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 50, batchSize: 50 };
const newWorker = () =>
  new ReprocessPendingReferences({ uow: h.uow, clock: systemClock, ids: uuidV7Generator }, options);

beforeAll(async () => {
  orm = await createTestOrm();
  await resetSchema(orm);
  h = buildHarness(orm);
});
afterAll(() => orm.close());

const money = (amount: string) => ({ amount, currency: 'BRL' });
const makeDue = (id: string) =>
  h.raw("update wager_transactions set next_attempt_at = now() - interval '1 second' where id = ?", [id]);

async function expectConsistent(walletId: string) {
  expect((await h.ledgerMatchesBalance(walletId)).consistent).toBe(true);
}

describe('referências fora de ordem', () => {
  test('REFUND chega antes da BET: fica pendente e é resolvido depois', async () => {
    const w = await h.wallet('100.00');
    const bet = h.command(w, { money: money('30.00') });
    const refund = h.command(w, {
      kind: K.Refund,
      money: money('30.00'),
      referenceExternalTransactionId: bet.externalTransactionId,
    });

    const early = await h.submit.execute(refund);
    expect(early.status).toBe(S.PendingReference);
    await h.submit.execute(bet);
    expect((await h.queries.getWallet(w.walletId)).balance).toEqual(money('70.00'));

    await makeDue(early.transactionId);
    await newWorker().runOnce();

    const view = await h.queries.getTransactionById(early.transactionId);
    expect(view.status).toBe(S.Processed);
    expect(view.referenceTransactionId).not.toBeNull();
    expect((await h.queries.getWallet(w.walletId)).balance).toEqual(money('100.00'));
    expect((await h.events(w.walletId, 'WagerTransactionPendingReference')).length).toBe(1);
    // OPENING + BET + REFUND
    expect((await h.events(w.walletId, 'WagerTransactionProcessed')).length).toBe(3);
    expect((await h.events(w.walletId, 'WalletBalanceChanged')).length).toBe(3);
    await expectConsistent(w.walletId);

    // o replay agora devolve o estado final, com a flag de replay
    const replay = await h.submit.execute(refund);
    expect(replay).toMatchObject({ status: S.Processed, idempotentReplay: true, balance: money('100.00') });
  });

  test('ROLLBACK chega antes do WIN', async () => {
    const w = await h.wallet('100.00');
    const win = h.command(w, { kind: K.Win, money: money('40.00') });
    const rollback = h.command(w, {
      kind: K.Rollback,
      money: money('40.00'),
      referenceExternalTransactionId: win.externalTransactionId,
    });

    const early = await h.submit.execute(rollback);
    expect(early.status).toBe(S.PendingReference);
    await h.submit.execute(win);
    expect((await h.queries.getWallet(w.walletId)).balance).toEqual(money('140.00'));

    await makeDue(early.transactionId);
    await newWorker().runOnce();

    expect((await h.queries.getTransactionById(early.transactionId)).status).toBe(S.Processed);
    expect((await h.queries.getWallet(w.walletId)).balance).toEqual(money('100.00'));
    await expectConsistent(w.walletId);
  });

  test('a referência chega mas não bate (valor): vira REJECTED na reavaliação', async () => {
    const w = await h.wallet('100.00');
    const bet = h.command(w, { money: money('30.00') });
    const refund = h.command(w, {
      kind: K.Refund,
      money: money('29.99'),
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const early = await h.submit.execute(refund);
    await h.submit.execute(bet);

    await makeDue(early.transactionId);
    await newWorker().runOnce();

    const view = await h.queries.getTransactionById(early.transactionId);
    expect(view).toMatchObject({ status: S.Rejected, failureCode: FailureCode.ReferenceAmountMismatch });
    expect((await h.queries.getWallet(w.walletId)).balance).toEqual(money('70.00'));
    expect((await h.events(w.walletId, 'WagerTransactionRejected')).length).toBe(1);
    await expectConsistent(w.walletId);
  });

  test('a referência nunca chega: depois do limite de tentativas vira REJECTED/REFERENCE_NOT_FOUND com evento', async () => {
    const w = await h.wallet('100.00');
    const early = await h.submit.execute(
      h.command(w, { kind: K.Refund, money: money('30.00'), referenceExternalTransactionId: 'fantasma' }),
    );
    const worker = newWorker();

    for (let attempt = 1; attempt <= 2; attempt++) {
      await makeDue(early.transactionId);
      await worker.runOnce();
      expect((await h.queries.getTransactionById(early.transactionId)).status).toBe(S.PendingReference);
      const [row] = await h.raw('select attempts from wager_transactions where id = ?', [early.transactionId]);
      expect(row.attempts).toBe(attempt);
    }

    await makeDue(early.transactionId);
    await worker.runOnce();

    const view = await h.queries.getTransactionById(early.transactionId);
    expect(view).toMatchObject({ status: S.Rejected, failureCode: FailureCode.ReferenceNotFound });
    expect((await h.events(w.walletId, 'WagerTransactionRejected')).length).toBe(1);
    expect((await h.queries.getWallet(w.walletId)).balance).toEqual(money('100.00'));
    expect(await h.ledgerCount(w.walletId)).toBe(1);
    await expectConsistent(w.walletId);

    // terminal: o worker não toca mais nela
    expect(await worker.runOnce()).toBe(0);
  });

  test('ainda não venceu: o worker não mexe', async () => {
    const w = await h.wallet('100.00');
    const early = await h.submit.execute(
      h.command(w, { kind: K.Refund, money: money('1.00'), referenceExternalTransactionId: 'depois' }),
    );
    await newWorker().runOnce();
    const [row] = await h.raw('select attempts, status from wager_transactions where id = ?', [early.transactionId]);
    expect(row).toMatchObject({ attempts: 0, status: 'PENDING_REFERENCE' });
  });

  test('vários workers ao mesmo tempo: a transação é aplicada uma única vez', async () => {
    const w = await h.wallet('100.00');
    const bet = h.command(w, { money: money('30.00') });
    const refund = h.command(w, {
      kind: K.Refund,
      money: money('30.00'),
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const early = await h.submit.execute(refund);
    await h.submit.execute(bet);
    await makeDue(early.transactionId);

    await Promise.all(Array.from({ length: 5 }, () => newWorker().runOnce()));

    expect((await h.queries.getWallet(w.walletId)).balance).toEqual(money('100.00'));
    const credits = await h.raw(
      `select 1 from wallet_ledger_entries where wallet_id = ? and transaction_id = ?`,
      [w.walletId, early.transactionId],
    );
    expect(credits).toHaveLength(1);
    expect((await h.events(w.walletId, 'WagerTransactionProcessed')).length).toBe(3);
    await expectConsistent(w.walletId);
  });

  test('várias instâncias sobre a mesma pendente vencida gastam uma única tentativa', async () => {
    const w = await h.wallet('100.00');
    const early = await h.submit.execute(
      h.command(w, { kind: K.Refund, money: money('1.00'), referenceExternalTransactionId: 'nunca-chega' }),
    );
    await makeDue(early.transactionId);

    await Promise.all(Array.from({ length: 6 }, () => newWorker().runOnce()));

    const [row] = await h.raw('select attempts, status from wager_transactions where id = ?', [early.transactionId]);
    // sem a releitura condicional, cada instância gastaria uma tentativa e o prazo encolheria
    expect(row).toMatchObject({ attempts: 1, status: 'PENDING_REFERENCE' });
  });

  test('candidata com defeito não trava as outras e termina como FAILED', async () => {
    // refund1 tem a BET e vai tentar gravar no ledger, onde forçamos um erro
    const w1 = await h.wallet('100.00');
    const bet1 = h.command(w1, { money: money('30.00') });
    const refund1 = await h.submit.execute(
      h.command(w1, {
        kind: K.Refund,
        money: money('30.00'),
        referenceExternalTransactionId: bet1.externalTransactionId,
      }),
    );
    await h.submit.execute(bet1);
    // refund2 é uma pendente normal, de outra wallet, que deve seguir sendo processada
    const w2 = await h.wallet('100.00');
    const refund2 = await h.submit.execute(
      h.command(w2, { kind: K.Refund, money: money('1.00'), referenceExternalTransactionId: 'nunca-chega' }),
    );

    const errors: unknown[] = [];
    const brokenUow: UnitOfWork = {
      run: (work, opts) =>
        h.uow.run((repos) => {
          const ledger = Object.create(repos.ledger);
          ledger.append = async () => {
            throw new Error('boom');
          };
          return work({ ...repos, ledger });
        }, opts),
    };
    const worker = new ReprocessPendingReferences(
      { uow: brokenUow, clock: systemClock, ids: uuidV7Generator, onError: (_c, e) => errors.push(e) },
      options,
    );

    for (let run = 1; run <= 3; run++) {
      // refund1 é sempre a primeira da fila: se travasse o lote, refund2 nunca andaria
      await h.raw("update wager_transactions set next_attempt_at = now() - interval '10 seconds' where id = ?", [
        refund1.transactionId,
      ]);
      await makeDue(refund2.transactionId);
      await worker.runOnce();
      if (run === 1) {
        const rows = await h.raw('select id, attempts from wager_transactions where id in (?, ?)', [
          refund1.transactionId,
          refund2.transactionId,
        ]);
        expect(rows.find((r) => r.id === refund1.transactionId).attempts).toBe(1);
        expect(rows.find((r) => r.id === refund2.transactionId).attempts).toBe(1);
      }
    }

    expect(errors.length).toBeGreaterThanOrEqual(3);
    expect(await h.queries.getTransactionById(refund1.transactionId)).toMatchObject({
      status: S.Failed,
      failureCode: FailureCode.InternalPermanentError,
    });
    // o saldo da wallet defeituosa não foi tocado, e a outra seguiu o fluxo normal
    expect((await h.queries.getWallet(w1.walletId)).balance).toEqual(money('70.00'));
    expect((await h.queries.getTransactionById(refund2.transactionId)).status).toBe(S.Rejected);
    await expectConsistent(w1.walletId);
  });

  test('duas reversões pendentes da mesma BET: só uma é aplicada', async () => {
    const w = await h.wallet('100.00');
    const bet = h.command(w, { money: money('30.00') });
    const reversal = (kind: K) =>
      h.command(w, { kind, money: money('30.00'), referenceExternalTransactionId: bet.externalTransactionId });
    const a = await h.submit.execute(reversal(K.Refund));
    const b = await h.submit.execute(reversal(K.Rollback));
    await h.submit.execute(bet);
    await makeDue(a.transactionId);
    await makeDue(b.transactionId);

    await Promise.all([newWorker().runOnce(), newWorker().runOnce()]);

    const statuses = [
      (await h.queries.getTransactionById(a.transactionId)).status,
      (await h.queries.getTransactionById(b.transactionId)).status,
    ].sort();
    expect(statuses).toEqual([S.Processed, S.Rejected]);
    expect((await h.queries.getWallet(w.walletId)).balance).toEqual(money('100.00'));
    await expectConsistent(w.walletId);
  });
});

describe('backoff', () => {
  test('exponencial com teto', () => {
    const o = { maxAttempts: 12, baseDelayMs: 1000, maxDelayMs: 60_000, batchSize: 20 };
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((n) => pendingBackoffMs(n, o))).toEqual([
      1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000,
    ]);
  });
});
