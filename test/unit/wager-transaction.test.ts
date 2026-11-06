import { describe, expect, test } from 'bun:test';
import {
  InvalidTransactionError,
  InvalidTransactionStateError,
} from '../../src/domain/errors/domain-errors';
import { Money } from '../../src/domain/money/money';
import { FailureCode } from '../../src/domain/wagering/failure-code';
import { hashPayload } from '../../src/domain/wagering/payload-hash';
import {
  WagerTransaction,
  WagerTransactionKind as K,
  WagerTransactionStatus as S,
} from '../../src/domain/wagering/wager-transaction';
import { LedgerDirection } from '../../src/domain/wallet/wallet-ledger-entry';

const at = new Date('2026-01-01T00:00:00Z');
const money = Money.from({ amount: '25.00', currency: 'BRL' });

function tx(kind: K, extra: { ref?: string; id?: string; money?: Money } = {}) {
  return WagerTransaction.create({
    id: extra.id ?? 't1',
    providerId: 'prov',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'prov:ext-1',
    payloadHash: 'h1',
    walletId: 'w1',
    playerId: 'p1',
    roundId: 'r1',
    gameId: 'g1',
    kind,
    money: extra.money ?? money,
    referenceExternalTransactionId: extra.ref,
    createdAt: at,
  });
}

describe('WagerTransaction: criação', () => {
  test('nasce PENDING', () => {
    expect(tx(K.Bet).status).toBe(S.Pending);
  });

  test('OPENING não pode ser criado pela entrada externa', () => {
    expect(() => tx(K.Opening)).toThrow(InvalidTransactionError);
  });

  test('createOpening existe para uso interno', () => {
    const o = WagerTransaction.createOpening({
      id: 'o1',
      providerId: 'internal',
      externalTransactionId: 'opening:w1',
      idempotencyKey: 'opening:w1',
      payloadHash: 'h',
      walletId: 'w1',
      playerId: 'p1',
      roundId: 'opening',
      gameId: 'opening',
      money,
      createdAt: at,
    });
    expect(o.kind).toBe(K.Opening);
    expect(o.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test.each([K.Refund, K.Rollback])('%s exige referência', (kind) => {
    expect(() => tx(kind)).toThrow(InvalidTransactionError);
    expect(tx(kind, { ref: 'ext-0' }).requiresReference()).toBe(true);
  });

  test('BET não aceita referência', () => {
    expect(() => tx(K.Bet, { ref: 'x' })).toThrow(InvalidTransactionError);
  });

  test('valor precisa ser positivo', () => {
    expect(() => tx(K.Bet, { money: Money.zero('BRL') })).toThrow(InvalidTransactionError);
  });
});

describe('WagerTransaction: transições', () => {
  test('PENDING -> PROCESSED guarda referência e data', () => {
    const t = tx(K.Refund, { ref: 'ext-0' });
    t.markProcessed('internal-ref', at);
    expect(t.status).toBe(S.Processed);
    expect(t.referenceTransactionId).toBe('internal-ref');
    expect(t.processedAt).toEqual(at);
    expect(t.isTerminal()).toBe(true);
  });

  test('PENDING -> PENDING_REFERENCE -> PROCESSED', () => {
    const t = tx(K.Rollback, { ref: 'ext-0' });
    t.markPendingReference();
    expect(t.isTerminal()).toBe(false);
    t.markPendingReference(); // nova tentativa, continua esperando
    t.markProcessed('ref', at);
    expect(t.status).toBe(S.Processed);
  });

  test('reject e fail guardam o failureCode', () => {
    const a = tx(K.Bet);
    a.reject(FailureCode.InsufficientFunds);
    expect(a.status).toBe(S.Rejected);
    expect(a.failureCode).toBe(FailureCode.InsufficientFunds);

    const b = tx(K.Bet);
    b.fail(FailureCode.InternalPermanentError);
    expect(b.status).toBe(S.Failed);
  });

  test.each([
    ['PROCESSED', (t: WagerTransaction) => t.markProcessed(undefined, at)],
    ['REJECTED', (t: WagerTransaction) => t.reject(FailureCode.InsufficientFunds)],
    ['FAILED', (t: WagerTransaction) => t.fail(FailureCode.InternalPermanentError)],
  ])('estado terminal %s não aceita nenhuma transição', (_name, finish) => {
    const t = tx(K.Bet);
    finish(t);
    expect(t.isTerminal()).toBe(true);
    expect(() => t.markProcessed(undefined, at)).toThrow(InvalidTransactionStateError);
    expect(() => t.markPendingReference()).toThrow(InvalidTransactionStateError);
    expect(() => t.reject(FailureCode.InsufficientFunds)).toThrow(InvalidTransactionStateError);
    expect(() => t.fail(FailureCode.InternalPermanentError)).toThrow(InvalidTransactionStateError);
  });
});

describe('WagerTransaction: regras por tipo', () => {
  test('LOSS não afeta saldo', () => {
    expect(tx(K.Loss).affectsBalance()).toBe(false);
    expect(tx(K.Bet).affectsBalance()).toBe(true);
    expect(() => tx(K.Loss).ledgerDirectionFor()).toThrow(InvalidTransactionError);
  });

  test('direção do ledger', () => {
    expect(tx(K.Bet).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(tx(K.Win).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(tx(K.Refund, { ref: 'x' }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test('ROLLBACK inverte a direção da referência', () => {
    const rb = tx(K.Rollback, { ref: 'x', id: 'rb' });
    expect(rb.ledgerDirectionFor(tx(K.Bet))).toBe(LedgerDirection.Credit);
    expect(rb.ledgerDirectionFor(tx(K.Win))).toBe(LedgerDirection.Debit);
    expect(rb.ledgerDirectionFor(tx(K.Refund, { ref: 'y' }))).toBe(LedgerDirection.Debit);
    expect(() => rb.ledgerDirectionFor()).toThrow(InvalidTransactionError);
  });
});

describe('idempotência: payload hash', () => {
  const payload = {
    providerId: 'p',
    externalTransactionId: 'e',
    playerId: 'pl',
    walletId: 'w',
    roundId: 'r',
    gameId: 'g',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  };

  test('é determinístico e independe da ordem das chaves', () => {
    const reordered = {
      money: { currency: 'BRL', amount: '25.00' },
      kind: 'BET',
      gameId: 'g',
      roundId: 'r',
      walletId: 'w',
      playerId: 'pl',
      externalTransactionId: 'e',
      providerId: 'p',
    };
    expect(hashPayload(payload)).toBe(hashPayload(reordered));
    expect(hashPayload(payload)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('qualquer campo de negócio diferente muda o hash', () => {
    const base = hashPayload(payload);
    expect(hashPayload({ ...payload, money: { amount: '25.01', currency: 'BRL' } })).not.toBe(base);
    expect(hashPayload({ ...payload, roundId: 'r2' })).not.toBe(base);
    expect(hashPayload({ ...payload, referenceExternalTransactionId: 'x' })).not.toBe(base);
  });

  test('matchesPayload distingue replay de conflito', () => {
    const t = tx(K.Bet);
    expect(t.matchesPayload('h1')).toBe(true);
    expect(t.matchesPayload('outro')).toBe(false);
  });
});
