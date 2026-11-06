import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  InboxPayloadMismatchError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../src/application/errors';
import { InvalidMoneyError, InvalidTransactionError } from '../../src/domain/errors/domain-errors';
import { FailureCode } from '../../src/domain/wagering/failure-code';
import {
  WagerTransactionKind as K,
  WagerTransactionStatus as S,
} from '../../src/domain/wagering/wager-transaction';
import { LedgerDirection } from '../../src/domain/wallet/wallet-ledger-entry';
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

const money = (amount: string, currency = 'BRL') => ({ amount, currency });

async function expectConsistent(walletId: string) {
  const rec = await h.ledgerMatchesBalance(walletId);
  expect(rec.consistent).toBe(true);
}

describe('criação de wallet', () => {
  test('saldo inicial gera OPENING e lançamento de crédito, com version 1', async () => {
    const w = await h.createWallet.execute({
      playerId: 'p-open',
      initialBalance: money('1000.00'),
      correlationId: 'c',
    });
    expect(w.version).toBe(1);
    expect(w.balance).toEqual(money('1000.00'));

    const ledger = await h.queries.getLedger(w.id, undefined, 50);
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]!.direction).toBe(LedgerDirection.Credit);
    expect(ledger.entries[0]!.balanceBefore.amount).toBe('0.00');
    expect((await h.events(w.id)).map((e) => e.event_type).sort()).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    await expectConsistent(w.id);
  });

  test('saldo inicial zero não gera transação nem lançamento', async () => {
    const w = await h.createWallet.execute({ playerId: 'p-zero', initialBalance: money('0.00'), correlationId: 'c' });
    expect(await h.ledgerCount(w.id)).toBe(0);
    await expectConsistent(w.id);
  });

  test('wallet duplicada para o mesmo player + moeda é conflito', async () => {
    const cmd = { playerId: 'p-dup', initialBalance: money('1.00'), correlationId: 'c' };
    await h.createWallet.execute(cmd);
    await expect(h.createWallet.execute(cmd)).rejects.toBeInstanceOf(WalletAlreadyExistsError);
    // outra moeda é outra wallet
    await h.createWallet.execute({ ...cmd, initialBalance: money('1.00', 'USD') });
  });

  test('saldo inicial inválido é rejeitado', async () => {
    for (const amount of ['-1.00', '1.234', '1e3', '']) {
      await expect(
        h.createWallet.execute({ playerId: 'p-bad', initialBalance: money(amount), correlationId: 'c' }),
      ).rejects.toBeInstanceOf(InvalidMoneyError);
    }
  });
});

describe('BET, WIN e LOSS', () => {
  test('BET debita, gera lançamento, version e eventos', async () => {
    const w = await h.wallet('100.00');
    const r = await h.submit.execute(h.command(w, { money: money('25.00') }));
    expect(r).toMatchObject({ status: S.Processed, idempotentReplay: false, balance: money('75.00') });

    const view = await h.queries.getWallet(w.walletId);
    expect(view.balance).toEqual(money('75.00'));
    expect(view.version).toBe(2);
    expect(await h.ledgerCount(w.walletId)).toBe(2); // OPENING + BET
    expect((await h.events(w.walletId, 'WalletBalanceChanged')).length).toBe(2);
    expect((await h.events(w.walletId, 'WagerTransactionProcessed')).length).toBe(2);
    await expectConsistent(w.walletId);
  });

  test('saldo insuficiente: REJECTED, sem lançamento, sem WalletBalanceChanged', async () => {
    const w = await h.wallet('10.00');
    const r = await h.submit.execute(h.command(w, { money: money('10.01') }));
    expect(r.status).toBe(S.Rejected);
    expect(r.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(r.balance).toEqual(money('10.00'));
    expect(await h.ledgerCount(w.walletId)).toBe(1);
    expect((await h.events(w.walletId, 'WagerTransactionRejected')).length).toBe(1);
    expect((await h.queries.getWallet(w.walletId)).version).toBe(1);
  });

  test('pode apostar exatamente o saldo', async () => {
    const w = await h.wallet('10.00');
    const r = await h.submit.execute(h.command(w, { money: money('10.00') }));
    expect(r.status).toBe(S.Processed);
    expect(r.balance).toEqual(money('0.00'));
  });

  test('WIN credita; LOSS não move saldo, não gera lançamento nem WalletBalanceChanged', async () => {
    const w = await h.wallet('100.00');
    await h.submit.execute(h.command(w, { kind: K.Win, money: money('40.00') }));
    const before = await h.events(w.walletId, 'WalletBalanceChanged');
    const loss = await h.submit.execute(h.command(w, { kind: K.Loss, money: money('5.00') }));

    expect(loss.status).toBe(S.Processed);
    expect(loss.balance).toEqual(money('140.00'));
    expect(await h.ledgerCount(w.walletId)).toBe(2); // OPENING + WIN
    expect((await h.events(w.walletId, 'WalletBalanceChanged')).length).toBe(before.length);
    expect((await h.events(w.walletId, 'WagerTransactionProcessed')).length).toBe(3);
    await expectConsistent(w.walletId);
  });

  test('moeda diferente da wallet é rejeitada e persistida', async () => {
    const w = await h.wallet('100.00');
    const r = await h.submit.execute(h.command(w, { money: money('1.00', 'USD') }));
    expect(r.status).toBe(S.Rejected);
    expect(r.failureCode).toBe(FailureCode.CurrencyMismatch);
  });

  test('jogador diferente do dono da wallet é rejeitado', async () => {
    const w = await h.wallet('100.00');
    const r = await h.submit.execute(h.command(w, { playerId: 'outro-jogador' }));
    expect(r.failureCode).toBe(FailureCode.WalletPlayerMismatch);
    expect((await h.queries.getWallet(w.walletId)).balance).toEqual(money('100.00'));
  });

  test('wallet inexistente: erro e nada gravado', async () => {
    const w = { walletId: Bun.randomUUIDv7(), playerId: 'x' };
    await expect(h.submit.execute(h.command(w))).rejects.toBeInstanceOf(WalletNotFoundError);
  });
});

describe('entrada inválida', () => {
  test('OPENING não pode ser submetido', async () => {
    const w = await h.wallet('10.00');
    await expect(h.submit.execute(h.command(w, { kind: K.Opening }))).rejects.toBeInstanceOf(InvalidTransactionError);
  });

  test('REFUND e ROLLBACK sem referência são inválidos', async () => {
    const w = await h.wallet('10.00');
    await expect(h.submit.execute(h.command(w, { kind: K.Refund }))).rejects.toBeInstanceOf(InvalidTransactionError);
    await expect(h.submit.execute(h.command(w, { kind: K.Rollback }))).rejects.toBeInstanceOf(InvalidTransactionError);
  });

  test('valor inválido', async () => {
    const w = await h.wallet('10.00');
    for (const amount of ['0.00', '-5.00', 'abc', '1.001']) {
      await expect(h.submit.execute(h.command(w, { money: money(amount) }))).rejects.toThrow();
    }
  });
});

describe('idempotência', () => {
  test('replay devolve o resultado original, incluindo o saldo da época', async () => {
    const w = await h.wallet('100.00');
    const cmd = h.command(w, { money: money('30.00') });
    const first = await h.submit.execute(cmd);
    await h.submit.execute(h.command(w, { money: money('20.00') })); // saldo muda depois

    const replay = await h.submit.execute(cmd);
    expect(replay).toEqual({ ...first, idempotentReplay: true });
    expect(replay.balance).toEqual(money('70.00')); // não os 50.00 de agora
    expect(await h.ledgerCount(w.walletId)).toBe(3);
  });

  test('replay de rejeição devolve a mesma rejeição', async () => {
    const w = await h.wallet('5.00');
    const cmd = h.command(w, { money: money('50.00') });
    const first = await h.submit.execute(cmd);
    const replay = await h.submit.execute(cmd);
    expect(replay).toEqual({ ...first, idempotentReplay: true });
    expect(replay.failureCode).toBe(FailureCode.InsufficientFunds);
    expect((await h.events(w.walletId, 'WagerTransactionRejected')).length).toBe(1);
  });

  test('mesma chave com payload diferente é conflito e não grava nada', async () => {
    const w = await h.wallet('100.00');
    const cmd = h.command(w, { money: money('10.00') });
    await h.submit.execute(cmd);
    await expect(h.submit.execute({ ...cmd, money: money('11.00') })).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(h.submit.execute({ ...cmd, roundId: 'round-2' })).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect((await h.queries.getWallet(w.walletId)).balance).toEqual(money('90.00'));
    expect(await h.ledgerCount(w.walletId)).toBe(2);
  });

  test('o mesmo external id com outra chave é conflito', async () => {
    const w = await h.wallet('100.00');
    const cmd = h.command(w);
    await h.submit.execute(cmd);
    await expect(h.submit.execute({ ...cmd, idempotencyKey: 'outra-chave' })).rejects.toBeInstanceOf(
      ExternalTransactionConflictError,
    );
  });

  test('provedores diferentes podem reusar o mesmo external id', async () => {
    const w = await h.wallet('100.00');
    await h.submit.execute(h.command(w, { ext: 'same', providerId: 'a', idempotencyKey: 'a:same' }));
    const r = await h.submit.execute(h.command(w, { ext: 'same', providerId: 'b', idempotencyKey: 'b:same' }));
    expect(r.status).toBe(S.Processed);
  });
});

describe('REFUND', () => {
  async function betted(balance = '100.00', amount = '30.00') {
    const w = await h.wallet(balance);
    const bet = h.command(w, { money: money(amount) });
    await h.submit.execute(bet);
    return { w, bet };
  }

  test('devolve o valor da BET', async () => {
    const { w, bet } = await betted();
    const r = await h.submit.execute(
      h.command(w, { kind: K.Refund, money: money('30.00'), referenceExternalTransactionId: bet.externalTransactionId }),
    );
    expect(r).toMatchObject({ status: S.Processed, balance: money('100.00') });
    const tx = await h.queries.getTransactionById(r.transactionId);
    expect(tx.referenceTransactionId).not.toBeNull();
    await expectConsistent(w.walletId);
  });

  test('só uma reversão por transação, seja REFUND ou ROLLBACK', async () => {
    const { w, bet } = await betted();
    const ref = bet.externalTransactionId;
    await h.submit.execute(h.command(w, { kind: K.Refund, money: money('30.00'), referenceExternalTransactionId: ref }));

    const second = await h.submit.execute(
      h.command(w, { kind: K.Refund, money: money('30.00'), referenceExternalTransactionId: ref }),
    );
    const rollback = await h.submit.execute(
      h.command(w, { kind: K.Rollback, money: money('30.00'), referenceExternalTransactionId: ref }),
    );
    expect(second.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    expect(rollback.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    expect((await h.queries.getWallet(w.walletId)).balance).toEqual(money('100.00'));
  });

  test('valor diferente do da referência', async () => {
    const { w, bet } = await betted();
    const r = await h.submit.execute(
      h.command(w, { kind: K.Refund, money: money('29.99'), referenceExternalTransactionId: bet.externalTransactionId }),
    );
    expect(r.failureCode).toBe(FailureCode.ReferenceAmountMismatch);
  });

  test('só referencia BET', async () => {
    const w = await h.wallet('100.00');
    const win = h.command(w, { kind: K.Win, money: money('10.00') });
    await h.submit.execute(win);
    const r = await h.submit.execute(
      h.command(w, { kind: K.Refund, money: money('10.00'), referenceExternalTransactionId: win.externalTransactionId }),
    );
    expect(r.failureCode).toBe(FailureCode.ReferenceKindNotAllowed);
  });

  test('referência de outra rodada, outra wallet ou outro jogador', async () => {
    const { w, bet } = await betted();
    const ref = bet.externalTransactionId;
    const otherRound = await h.submit.execute(
      h.command(w, { kind: K.Refund, money: money('30.00'), roundId: 'round-X', referenceExternalTransactionId: ref }),
    );
    expect(otherRound.failureCode).toBe(FailureCode.ReferenceMismatch);

    const other = await h.wallet('100.00');
    const otherWallet = await h.submit.execute(
      h.command(other, { kind: K.Refund, money: money('30.00'), referenceExternalTransactionId: ref }),
    );
    expect(otherWallet.failureCode).toBe(FailureCode.ReferenceMismatch);
  });

  test('referência que foi rejeitada não pode ser revertida', async () => {
    const w = await h.wallet('5.00');
    const bet = h.command(w, { money: money('50.00') });
    expect((await h.submit.execute(bet)).status).toBe(S.Rejected);
    const r = await h.submit.execute(
      h.command(w, { kind: K.Refund, money: money('50.00'), referenceExternalTransactionId: bet.externalTransactionId }),
    );
    expect(r.failureCode).toBe(FailureCode.ReferenceNotProcessed);
  });
});

describe('ROLLBACK', () => {
  test('de BET devolve (crédito)', async () => {
    const w = await h.wallet('100.00');
    const bet = h.command(w, { money: money('30.00') });
    await h.submit.execute(bet);
    const r = await h.submit.execute(
      h.command(w, { kind: K.Rollback, money: money('30.00'), referenceExternalTransactionId: bet.externalTransactionId }),
    );
    expect(r.balance).toEqual(money('100.00'));
    await expectConsistent(w.walletId);
  });

  test('de WIN retira o prêmio (débito)', async () => {
    const w = await h.wallet('100.00');
    const win = h.command(w, { kind: K.Win, money: money('40.00') });
    await h.submit.execute(win);
    const r = await h.submit.execute(
      h.command(w, { kind: K.Rollback, money: money('40.00'), referenceExternalTransactionId: win.externalTransactionId }),
    );
    expect(r).toMatchObject({ status: S.Processed, balance: money('100.00') });
    await expectConsistent(w.walletId);
  });

  test('de REFUND também funciona', async () => {
    const w = await h.wallet('100.00');
    const bet = h.command(w, { money: money('30.00') });
    const refund = h.command(w, { kind: K.Refund, money: money('30.00'), referenceExternalTransactionId: bet.externalTransactionId });
    await h.submit.execute(bet);
    await h.submit.execute(refund);
    const r = await h.submit.execute(
      h.command(w, { kind: K.Rollback, money: money('30.00'), referenceExternalTransactionId: refund.externalTransactionId }),
    );
    expect(r.balance).toEqual(money('70.00'));
  });

  test('reversão que deixaria o saldo negativo tem código próprio', async () => {
    const w = await h.wallet('50.00');
    const win = h.command(w, { kind: K.Win, money: money('40.00') });
    await h.submit.execute(win);
    await h.submit.execute(h.command(w, { money: money('85.00') })); // gasta quase tudo
    const r = await h.submit.execute(
      h.command(w, { kind: K.Rollback, money: money('40.00'), referenceExternalTransactionId: win.externalTransactionId }),
    );
    expect(r.status).toBe(S.Rejected);
    expect(r.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
    expect(r.failureCode).not.toBe(FailureCode.InsufficientFunds);
    expect((await h.queries.getWallet(w.walletId)).balance).toEqual(money('5.00'));
    await expectConsistent(w.walletId);
  });
});

describe('referência fora de ordem', () => {
  test('referência ausente: PENDING_REFERENCE, sem efeito no saldo, com evento', async () => {
    const w = await h.wallet('100.00');
    const r = await h.submit.execute(
      h.command(w, { kind: K.Refund, money: money('30.00'), referenceExternalTransactionId: 'ainda-nao-chegou' }),
    );
    expect(r.status).toBe(S.PendingReference);
    expect(r.balance).toEqual(money('100.00'));
    expect(await h.ledgerCount(w.walletId)).toBe(1);
    expect((await h.events(w.walletId, 'WagerTransactionPendingReference')).length).toBe(1);

    const [row] = await h.raw('select next_attempt_at, attempts from wager_transactions where id = ?', [r.transactionId]);
    expect(row.next_attempt_at).not.toBeNull();
    expect(row.attempts).toBe(0);
  });

  test('replay de pendente devolve o mesmo status', async () => {
    const w = await h.wallet('100.00');
    const cmd = h.command(w, { kind: K.Rollback, money: money('1.00'), referenceExternalTransactionId: 'x' });
    const first = await h.submit.execute(cmd);
    expect(await h.submit.execute(cmd)).toEqual({ ...first, idempotentReplay: true });
  });
});

describe('consultas', () => {
  test('ledger com cursor: páginas estáveis, sem repetição nem buraco', async () => {
    const w = await h.wallet('1000.00');
    for (let i = 0; i < 7; i++) await h.submit.execute(h.command(w, { money: money('1.00') }));

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await h.queries.getLedger(w.walletId, cursor, 3);
      seen.push(...page.entries.map((e) => e.id));
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor);

    expect(pages).toBe(3);
    expect(seen).toHaveLength(8); // OPENING + 7
    expect(new Set(seen).size).toBe(8);
  });

  test('cursor inválido', async () => {
    const w = await h.wallet('1.00');
    await expect(h.queries.getLedger(w.walletId, 'lixo', 10)).rejects.toThrow('cursor inválido');
  });

  test('consulta por id interno e por id do provedor', async () => {
    const w = await h.wallet('100.00');
    const cmd = h.command(w);
    const r = await h.submit.execute(cmd);
    const byId = await h.queries.getTransactionById(r.transactionId);
    const byExt = await h.queries.getTransactionByExternalId('prov', cmd.externalTransactionId);
    expect(byExt).toEqual(byId);
    expect(byId).toMatchObject({ kind: K.Bet, status: S.Processed, balance: money('90.00') });
  });

  test('reconciliação consistente e divergência sinalizada (sem corrigir)', async () => {
    const mismatches: string[] = [];
    const queries = new (await import('../../src/application/queries')).WalletQueries(h.uow, (i) =>
      mismatches.push(i.difference),
    );
    const w = await h.wallet('100.00');
    await h.submit.execute(h.command(w, { money: money('10.00') }));

    const ok = await queries.reconcile(w.walletId);
    expect(ok).toMatchObject({ consistent: true, checkedEntries: 2, difference: money('0.00') });

    // adultera o saldo por fora para simular um bug
    await h.raw('update wallets set balance = 95.00 where id = ?', [w.walletId]);
    const bad = await queries.reconcile(w.walletId);
    expect(bad.consistent).toBe(false);
    expect(bad.storedBalance).toEqual(money('95.00'));
    expect(bad.calculatedBalance).toEqual(money('90.00'));
    expect(bad.difference).toEqual(money('5.00'));
    expect(mismatches).toEqual(['5.00']);
    // não corrige silenciosamente
    expect((await h.queries.getWallet(w.walletId)).balance).toEqual(money('95.00'));
  });

  test('wallet inexistente nas consultas', async () => {
    const id = Bun.randomUUIDv7();
    await expect(h.queries.getWallet(id)).rejects.toBeInstanceOf(WalletNotFoundError);
    await expect(h.queries.reconcile(id)).rejects.toBeInstanceOf(WalletNotFoundError);
  });
});

describe('achados da revisão', () => {
  test('WIN não pode creditar sobre uma BET que já foi devolvida', async () => {
    const w = await h.wallet('100.00');
    const bet = h.command(w, { money: money('10.00') });
    await h.submit.execute(bet);
    await h.submit.execute(
      h.command(w, { kind: K.Refund, money: money('10.00'), referenceExternalTransactionId: bet.externalTransactionId }),
    );
    const win = await h.submit.execute(
      h.command(w, { kind: K.Win, money: money('50.00'), referenceExternalTransactionId: bet.externalTransactionId }),
    );
    expect(win.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    expect((await h.queries.getWallet(w.walletId)).balance).toEqual(money('100.00'));
  });

  test('WIN com referência válida continua funcionando', async () => {
    const w = await h.wallet('100.00');
    const bet = h.command(w, { money: money('10.00') });
    await h.submit.execute(bet);
    const win = await h.submit.execute(
      h.command(w, { kind: K.Win, money: money('30.00'), referenceExternalTransactionId: bet.externalTransactionId }),
    );
    expect(win.status).toBe(S.Processed);
    expect(win.balance).toEqual(money('120.00'));
  });

  test('update da transação sem saldo novo preserva balance_after', async () => {
    const w = await h.wallet('100.00');
    const r = await h.submit.execute(h.command(w, { money: money('10.00') }));
    await h.uow.run(async (repos) => {
      const stored = (await repos.transactions.findById(r.transactionId))!;
      await repos.transactions.update(stored.transaction);
    });
    const view = await h.queries.getTransactionById(r.transactionId);
    expect(view.balance).toEqual(money('90.00'));
  });

  test('inbox: redelivery idêntica vira replay; mesmo messageId com conteúdo diferente é erro permanente', async () => {
    const w = await h.wallet('100.00');
    const messageId = `msg-${Bun.randomUUIDv7()}`;
    const inbox = (payloadHash: string) => ({ consumerName: 'wager-consumer', messageId, payloadHash });
    const cmd = h.command(w, { money: money('10.00'), inbox: inbox('hash-a') });

    const first = await h.submit.execute(cmd);
    const again = await h.submit.execute(cmd);
    expect(again).toEqual({ ...first, idempotentReplay: true });
    expect((await h.queries.getWallet(w.walletId)).balance).toEqual(money('90.00'));

    const other = h.command(w, { money: money('10.00'), inbox: inbox('hash-b') });
    await expect(h.submit.execute(other)).rejects.toBeInstanceOf(InboxPayloadMismatchError);
    expect((await h.queries.getWallet(w.walletId)).balance).toEqual(money('90.00'));

    const [row] = await h.raw('select processed_at from inbox_messages where message_id = ?', [messageId]);
    expect(row.processed_at).not.toBeNull();
  });

  test('chave já usada + wallet inexistente é conflito de idempotência, não 404', async () => {
    const w = await h.wallet('100.00');
    const cmd = h.command(w);
    await h.submit.execute(cmd);
    await expect(
      h.submit.execute({ ...cmd, walletId: Bun.randomUUIDv7() }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });
});
