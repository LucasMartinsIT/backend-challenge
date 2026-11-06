import { describe, expect, test } from 'bun:test';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidWalletError,
  LedgerImbalanceError,
} from '../../src/domain/errors/domain-errors';
import { Money } from '../../src/domain/money/money';
import { Wallet } from '../../src/domain/wallet/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../../src/domain/wallet/wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-01-01T00:00:00Z');
const move = (amount: string, n = 1) => ({
  entryId: `e${n}`,
  transactionId: `t${n}`,
  money: brl(amount),
  at,
});
const openWallet = (initial = '100.00') =>
  Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl(initial), at });

describe('Wallet', () => {
  test('abre com version 1', () => {
    const w = openWallet();
    expect(w.version).toBe(1);
    expect(w.balance.toString()).toBe('100.00');
    expect(w.currency).toBe('BRL');
  });

  test('rejeita saldo inicial negativo', () => {
    expect(() =>
      Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl('1.00').negate() }),
    ).toThrow(InvalidWalletError);
  });

  test('débito gera lançamento coerente e incrementa version', () => {
    const w = openWallet();
    const entry = w.debit(move('80.00'));
    expect(w.balance.toString()).toBe('20.00');
    expect(w.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toString()).toBe('100.00');
    expect(entry.balanceAfter.toString()).toBe('20.00');
    expect(entry.isBalanced()).toBe(true);
  });

  test('crédito gera lançamento coerente', () => {
    const w = openWallet('0.00');
    const entry = w.credit(move('12.34'));
    expect(w.balance.toString()).toBe('12.34');
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });

  test('não permite saldo negativo e não altera nada na falha', () => {
    const w = openWallet('50.00');
    expect(() => w.debit(move('50.01'))).toThrow(InsufficientFundsError);
    expect(w.balance.toString()).toBe('50.00');
    expect(w.version).toBe(1);
  });

  test('permite debitar exatamente o saldo', () => {
    const w = openWallet('50.00');
    w.debit(move('50.00'));
    expect(w.balance.isZero()).toBe(true);
  });

  test('conflito de moeda', () => {
    const w = openWallet();
    const usd = { ...move('1.00'), money: Money.from({ amount: '1.00', currency: 'USD' }) };
    expect(() => w.debit(usd)).toThrow(CurrencyMismatchError);
    expect(() => w.credit(usd)).toThrow(CurrencyMismatchError);
    expect(w.version).toBe(1);
  });

  test('o saldo bate com a soma dos lançamentos', () => {
    const w = openWallet('100.00');
    const entries = [w.debit(move('30.00', 1)), w.credit(move('5.50', 2)), w.debit(move('10.25', 3))];
    const net = entries.reduce(
      (acc, e) => (e.direction === LedgerDirection.Credit ? acc.add(e.money) : acc.subtract(e.money)),
      brl('100.00'),
    );
    expect(net.equals(w.balance)).toBe(true);
  });

  test('rehydrate preserva o estado sem revalidar', () => {
    const w = Wallet.rehydrate({
      id: 'w',
      playerId: 'p',
      currency: 'BRL',
      balance: brl('9.00'),
      version: 7,
      createdAt: at,
      updatedAt: at,
    });
    expect(w.version).toBe(7);
  });
});

describe('WalletLedgerEntry', () => {
  const base = {
    id: 'e',
    walletId: 'w',
    transactionId: 't',
    createdAt: at,
  };

  test('create valida a aritmética', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('10.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('80.00'),
      }),
    ).toThrow(LedgerImbalanceError);
  });

  test('rejeita valor zero', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: brl('0.00'),
        balanceBefore: brl('1.00'),
        balanceAfter: brl('1.00'),
      }),
    ).toThrow(LedgerImbalanceError);
  });

  test('é estruturalmente imutável: sem métodos de transição', () => {
    const e = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      money: brl('10.00'),
      balanceBefore: brl('1.00'),
      balanceAfter: brl('11.00'),
    });
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(e)).filter((n) => n !== 'constructor');
    expect(methods).toEqual(['isBalanced']);
  });
});
