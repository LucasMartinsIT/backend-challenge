import { describe, expect, test } from 'bun:test';
import { isTransientInfraError } from '../../src/infrastructure/persistence/transient-errors';

const withCode = (code: string, name = 'Error') => Object.assign(new Error('x'), { code, name });

describe('isTransientInfraError', () => {
  test.each([
    '40P01', '40001', '55P03', '57P01', '57P03', '53300', '08006', '25P03',
    'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH',
    'EAI_AGAIN', 'ENOTFOUND',
  ])('%s é transitório (o provedor pode reenviar)', (code) => {
    expect(isTransientInfraError(withCode(code))).toBe(true);
  });

  test('DNS fora do ar (o caso do contêiner do banco parado) é transitório', () => {
    expect(isTransientInfraError(withCode('EAI_AGAIN', 'DNSException'))).toBe(true);
  });

  test('timeouts e conexão encerrada são reconhecidos pela mensagem', () => {
    expect(isTransientInfraError(new Error('Knex: Timeout acquiring a connection'))).toBe(true);
    expect(isTransientInfraError(new Error('Connection terminated unexpectedly'))).toBe(true);
  });

  test.each(['23505', '23514', '22P02', '42P01'])('erro de dados/SQL %s NÃO é transitório', (code) => {
    expect(isTransientInfraError(withCode(code))).toBe(false);
  });

  test('erro comum de programação não é transitório', () => {
    expect(isTransientInfraError(new TypeError('undefined is not a function'))).toBe(false);
  });
});
