import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../../src/domain/errors/domain-errors';
import { Money } from '../../src/domain/money/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  test('normaliza para 2 casas', () => {
    expect(brl('25').toString()).toBe('25.00');
    expect(brl('25.5').toString()).toBe('25.50');
    expect(brl('0.05').toString()).toBe('0.05');
  });

  test('soma e subtração são exatas (sem erro de ponto flutuante)', () => {
    expect(brl('0.10').add(brl('0.20')).toString()).toBe('0.30');
    expect(brl('1000000000000.01').add(brl('0.01')).toString()).toBe('1000000000000.02');
  });

  test('subtração pode ficar negativa e negate inverte o sinal', () => {
    const r = brl('10.00').subtract(brl('25.50'));
    expect(r.isNegative()).toBe(true);
    expect(r.toString()).toBe('-15.50');
    expect(r.negate().toString()).toBe('15.50');
  });

  test('é imutável', () => {
    const a = brl('10.00');
    a.add(brl('5.00'));
    expect(a.toString()).toBe('10.00');
  });

  test.each(['', 'abc', 'NaN', 'Infinity', '1e3', '1E3', '-5.00', '+5.00', '1.234', '1,00', ' 1.00', '.5', '5.'])(
    'rejeita entrada inválida %p',
    (amount) => {
      expect(() => brl(amount)).toThrow(InvalidMoneyError);
    },
  );

  test('rejeita moeda inválida', () => {
    expect(() => Money.from({ amount: '1.00', currency: 'brl' })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: '1.00', currency: '' })).toThrow(InvalidMoneyError);
  });

  test('moedas diferentes lançam erro de domínio', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
  });

  test('equals considera valor e moeda', () => {
    expect(brl('1.00').equals(brl('1'))).toBe(true);
    expect(brl('1.00').equals(Money.from({ amount: '1.00', currency: 'USD' }))).toBe(false);
  });

  test('predicados e zero', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
  });

  test('toJSON devolve string decimal, nunca número', () => {
    expect(brl('7').toJSON()).toEqual({ amount: '7.00', currency: 'BRL' });
  });
});
