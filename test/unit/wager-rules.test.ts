import { beforeEach, describe, expect, test } from 'bun:test';
import { CreateWallet } from '../../src/application/create-wallet';
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  WalletNotFoundError,
} from '../../src/application/errors';
import { WalletQueries } from '../../src/application/queries';
import { SubmitWagerTransaction, type SubmitWagerCommand } from '../../src/application/submit-wager-transaction';
import type { Clock, IdGenerator } from '../../src/application/support';
import { InvalidMoneyError, InvalidTransactionError } from '../../src/domain/errors/domain-errors';
import { FailureCode } from '../../src/domain/wagering/failure-code';
import {
  WagerTransactionKind as K,
  WagerTransactionStatus as S,
} from '../../src/domain/wagering/wager-transaction';
import { InMemoryStore, InMemoryUnitOfWork } from './support/in-memory';

// Regras de negócio sem banco: rápidas e sem infraestrutura. As garantias do Postgres e a
// concorrência real são cobertas nos testes de integração e de concorrência.

let store: InMemoryStore;
let submit: SubmitWagerTransaction;
let createWallet: CreateWallet;
let queries: WalletQueries;
let counter = 0;

const clock: Clock = { now: () => new Date('2026-01-01T00:00:00Z') };
const ids: IdGenerator = { next: () => `id-${++counter}` };
const money = (amount: string, currency = 'BRL') => ({ amount, currency });

beforeEach(() => {
  counter = 0;
  store = new InMemoryStore();
  const uow = new InMemoryUnitOfWork(store);
  submit = new SubmitWagerTransaction({ uow, clock, ids });
  createWallet = new CreateWallet({ uow, clock, ids });
  queries = new WalletQueries(uow);
});

async function wallet(balance = '100.00') {
  const w = await createWallet.execute({
    playerId: `player-${++counter}`,
    initialBalance: money(balance),
    correlationId: 'c',
  });
  return { walletId: w.id, playerId: w.playerId };
}

function cmd(w: { walletId: string; playerId: string }, over: Partial<SubmitWagerCommand> & { ext?: string } = {}): SubmitWagerCommand {
  const ext = over.ext ?? `ext-${++counter}`;
  return {
    idempotencyKey: `prov:${ext}`,
    providerId: 'prov',
    externalTransactionId: ext,
    playerId: w.playerId,
    walletId: w.walletId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: K.Bet,
    money: money('10.00'),
    correlationId: 'c',
    ...over,
  };
}

const balance = async (walletId: string) => (await queries.getWallet(walletId)).balance;
const eventTypes = () => store.outbox.map((m) => m.eventType);

describe('BET', () => {
  test('debita, gera um lançamento DEBIT e os eventos', async () => {
    const w = await wallet('100.00');
    const r = await submit.execute(cmd(w, { money: money('25.00') }));
    expect(r).toMatchObject({ status: S.Processed, balance: money('75.00'), idempotentReplay: false });
    expect(store.ledger.at(-1)).toMatchObject({ direction: 'DEBIT' });
    expect(eventTypes()).toContain('WalletBalanceChanged');
  });

  test('saldo insuficiente: rejeita, sem lançamento e sem WalletBalanceChanged', async () => {
    const w = await wallet('10.00');
    const ledgerBefore = store.ledger.length;
    const eventsBefore = eventTypes().filter((t) => t === 'WalletBalanceChanged').length;
    const r = await submit.execute(cmd(w, { money: money('10.01') }));
    expect(r).toMatchObject({ status: S.Rejected, failureCode: FailureCode.InsufficientFunds });
    expect(store.ledger.length).toBe(ledgerBefore);
    expect(eventTypes().filter((t) => t === 'WalletBalanceChanged').length).toBe(eventsBefore);
    expect(eventTypes()).toContain('WagerTransactionRejected');
    expect(await balance(w.walletId)).toEqual(money('10.00'));
  });

  test('aceita apostar exatamente o saldo', async () => {
    const w = await wallet('10.00');
    expect((await submit.execute(cmd(w, { money: money('10.00') }))).balance).toEqual(money('0.00'));
  });
});

describe('WIN e LOSS', () => {
  test('WIN credita', async () => {
    const w = await wallet('100.00');
    expect((await submit.execute(cmd(w, { kind: K.Win, money: money('40.00') }))).balance).toEqual(money('140.00'));
  });

  test('LOSS não movimenta saldo, não gera lançamento, mas gera Processed', async () => {
    const w = await wallet('100.00');
    const ledgerBefore = store.ledger.length;
    const balanceChangedBefore = eventTypes().filter((t) => t === 'WalletBalanceChanged').length;
    const r = await submit.execute(cmd(w, { kind: K.Loss, money: money('5.00') }));
    expect(r).toMatchObject({ status: S.Processed, balance: money('100.00') });
    expect(store.ledger.length).toBe(ledgerBefore);
    expect(eventTypes().filter((t) => t === 'WalletBalanceChanged').length).toBe(balanceChangedBefore);
    expect(eventTypes().filter((t) => t === 'WagerTransactionProcessed').length).toBe(2); // OPENING + LOSS
  });

  test('WIN referenciando uma BET da mesma rodada', async () => {
    const w = await wallet('100.00');
    const bet = cmd(w);
    await submit.execute(bet);
    const win = await submit.execute(
      cmd(w, { kind: K.Win, money: money('30.00'), referenceExternalTransactionId: bet.externalTransactionId }),
    );
    expect(win.status).toBe(S.Processed);
  });
});

describe('REFUND', () => {
  async function betted() {
    const w = await wallet('100.00');
    const bet = cmd(w, { money: money('30.00') });
    await submit.execute(bet);
    const refund = (over: Partial<SubmitWagerCommand> = {}) =>
      cmd(w, { kind: K.Refund, money: money('30.00'), referenceExternalTransactionId: bet.externalTransactionId, ...over });
    return { w, bet, refund };
  }

  test('devolve o valor da BET', async () => {
    const { w, refund } = await betted();
    expect((await submit.execute(refund())).balance).toEqual(money('100.00'));
    expect(await balance(w.walletId)).toEqual(money('100.00'));
  });

  test('só pode reverter uma vez (REFUND e depois REFUND ou ROLLBACK)', async () => {
    const { refund } = await betted();
    await submit.execute(refund());
    expect((await submit.execute(refund())).failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    expect((await submit.execute(refund({ kind: K.Rollback }))).failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
  });

  test('valor diferente do da referência', async () => {
    const { refund } = await betted();
    expect((await submit.execute(refund({ money: money('29.99') }))).failureCode).toBe(
      FailureCode.ReferenceAmountMismatch,
    );
  });

  test('só referencia BET', async () => {
    const w = await wallet();
    const win = cmd(w, { kind: K.Win, money: money('10.00') });
    await submit.execute(win);
    const r = await submit.execute(
      cmd(w, { kind: K.Refund, money: money('10.00'), referenceExternalTransactionId: win.externalTransactionId }),
    );
    expect(r.failureCode).toBe(FailureCode.ReferenceKindNotAllowed);
  });

  test('outra rodada ou outra wallet: REFERENCE_MISMATCH', async () => {
    const { refund, bet } = await betted();
    expect((await submit.execute(refund({ roundId: 'round-2' }))).failureCode).toBe(FailureCode.ReferenceMismatch);

    const other = await wallet();
    const crossWallet = cmd(other, {
      kind: K.Refund,
      money: money('30.00'),
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    expect((await submit.execute(crossWallet)).failureCode).toBe(FailureCode.ReferenceMismatch);
  });

  test('referência rejeitada não pode ser revertida', async () => {
    const w = await wallet('5.00');
    const bet = cmd(w, { money: money('50.00') });
    expect((await submit.execute(bet)).status).toBe(S.Rejected);
    const r = await submit.execute(
      cmd(w, { kind: K.Refund, money: money('50.00'), referenceExternalTransactionId: bet.externalTransactionId }),
    );
    expect(r.failureCode).toBe(FailureCode.ReferenceNotProcessed);
  });

  test('referência ausente: PENDING_REFERENCE, sem efeito no saldo, com evento', async () => {
    const w = await wallet();
    const r = await submit.execute(
      cmd(w, { kind: K.Refund, money: money('30.00'), referenceExternalTransactionId: 'ainda-nao-chegou' }),
    );
    expect(r).toMatchObject({ status: S.PendingReference, balance: money('100.00') });
    expect(eventTypes()).toContain('WagerTransactionPendingReference');
    expect(store.ledger.filter((e) => e.walletId === w.walletId)).toHaveLength(1); // só o OPENING
  });
});

describe('ROLLBACK', () => {
  test('de BET credita; de WIN debita', async () => {
    const w = await wallet('100.00');
    const bet = cmd(w, { money: money('30.00') });
    const win = cmd(w, { kind: K.Win, money: money('40.00') });
    await submit.execute(bet);
    await submit.execute(win);
    const rollbackWin = await submit.execute(
      cmd(w, { kind: K.Rollback, money: money('40.00'), referenceExternalTransactionId: win.externalTransactionId }),
    );
    expect(rollbackWin.balance).toEqual(money('70.00'));
    const rollbackBet = await submit.execute(
      cmd(w, { kind: K.Rollback, money: money('30.00'), referenceExternalTransactionId: bet.externalTransactionId }),
    );
    expect(rollbackBet.balance).toEqual(money('100.00'));
  });

  test('reversão que deixaria o saldo negativo tem código próprio', async () => {
    const w = await wallet('50.00');
    const win = cmd(w, { kind: K.Win, money: money('40.00') });
    await submit.execute(win);
    await submit.execute(cmd(w, { money: money('85.00') }));
    const r = await submit.execute(
      cmd(w, { kind: K.Rollback, money: money('40.00'), referenceExternalTransactionId: win.externalTransactionId }),
    );
    expect(r).toMatchObject({ status: S.Rejected, failureCode: FailureCode.ReversalInsufficientFunds });
    expect(r.failureCode).not.toBe(FailureCode.InsufficientFunds);
    expect(await balance(w.walletId)).toEqual(money('5.00'));
  });
});

describe('moeda e dono da wallet', () => {
  test('conflito de moeda é rejeitado', async () => {
    const w = await wallet();
    const r = await submit.execute(cmd(w, { money: money('1.00', 'USD') }));
    expect(r.failureCode).toBe(FailureCode.CurrencyMismatch);
  });

  test('outro jogador não opera a wallet', async () => {
    const w = await wallet();
    expect((await submit.execute(cmd(w, { playerId: 'intruso' }))).failureCode).toBe(FailureCode.WalletPlayerMismatch);
  });
});

describe('idempotência', () => {
  test('replay devolve o resultado original com o saldo da época', async () => {
    const w = await wallet('100.00');
    const first = cmd(w, { money: money('30.00') });
    const original = await submit.execute(first);
    await submit.execute(cmd(w, { money: money('20.00') }));
    const replay = await submit.execute(first);
    expect(replay).toEqual({ ...original, idempotentReplay: true });
    expect(replay.balance).toEqual(money('70.00'));
  });

  test('mesma chave com payload divergente é conflito e não grava nada', async () => {
    const w = await wallet('100.00');
    const original = cmd(w, { money: money('10.00') });
    await submit.execute(original);
    const ledgerBefore = store.ledger.length;
    await expect(submit.execute({ ...original, money: money('11.00') })).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(store.ledger.length).toBe(ledgerBefore);
    expect(await balance(w.walletId)).toEqual(money('90.00'));
  });

  test('o mesmo id externo com outra chave é conflito', async () => {
    const w = await wallet();
    const original = cmd(w);
    await submit.execute(original);
    await expect(submit.execute({ ...original, idempotencyKey: 'outra' })).rejects.toBeInstanceOf(
      ExternalTransactionConflictError,
    );
  });

  test('a ordem das chaves do JSON não muda a identidade da requisição', async () => {
    const w = await wallet();
    const a = cmd(w);
    const reordered = Object.fromEntries(Object.entries(a).reverse()) as SubmitWagerCommand;
    const first = await submit.execute(a);
    expect(await submit.execute(reordered)).toMatchObject({ transactionId: first.transactionId, idempotentReplay: true });
  });
});

describe('entradas inválidas e inbox', () => {
  test('OPENING não pode ser submetido; REFUND sem referência é inválido', async () => {
    const w = await wallet();
    await expect(submit.execute(cmd(w, { kind: K.Opening }))).rejects.toBeInstanceOf(InvalidTransactionError);
    await expect(submit.execute(cmd(w, { kind: K.Refund }))).rejects.toBeInstanceOf(InvalidTransactionError);
  });

  test('valores inválidos são recusados', async () => {
    const w = await wallet();
    for (const amount of ['0.00', '-1.00', '1.234', '1e3', 'abc']) {
      await expect(submit.execute(cmd(w, { money: money(amount) }))).rejects.toThrow();
    }
    await expect(submit.execute(cmd(w, { money: money('1.234') }))).rejects.toBeInstanceOf(InvalidMoneyError);
  });

  test('wallet inexistente', async () => {
    await expect(submit.execute(cmd({ walletId: 'nao-existe', playerId: 'x' }))).rejects.toBeInstanceOf(WalletNotFoundError);
  });

  test('mesma mensagem da inbox entregue duas vezes aplica uma só vez', async () => {
    const w = await wallet('100.00');
    const message = cmd(w, { inbox: { consumerName: 'wager', messageId: 'm1', payloadHash: 'h' } });
    const first = await submit.execute(message);
    const again = await submit.execute(message);
    expect(again).toEqual({ ...first, idempotentReplay: true });
    expect(await balance(w.walletId)).toEqual(money('90.00'));
    expect(store.inbox.get('wager/m1')!.isProcessed()).toBe(true);
  });
});

describe('criação de wallet e reconciliação', () => {
  test('OPENING gera crédito no ledger e a wallet nasce com version 1', async () => {
    const w = await createWallet.execute({ playerId: 'p', initialBalance: money('1000.00'), correlationId: 'c' });
    expect(w.version).toBe(1);
    expect(store.ledger).toHaveLength(1);
    expect(store.ledger[0]).toMatchObject({ direction: 'CREDIT' });
  });

  test('saldo == soma do ledger depois de uma sequência de operações', async () => {
    const w = await wallet('100.00');
    const bet = cmd(w, { money: money('30.00') });
    await submit.execute(bet);
    await submit.execute(cmd(w, { kind: K.Win, money: money('55.50') }));
    await submit.execute(cmd(w, { kind: K.Refund, money: money('30.00'), referenceExternalTransactionId: bet.externalTransactionId }));
    const rec = await queries.reconcile(w.walletId);
    expect(rec.consistent).toBe(true);
    expect(rec.storedBalance).toEqual(money('155.50'));
  });
});
