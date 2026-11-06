import { describe, expect, test } from 'bun:test';
import { WalletBalanceChanged, WagerTransactionRejected } from '../../src/domain/events/wager-events';
import { InboxMessage } from '../../src/domain/messaging/inbox-message';
import { OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { Money } from '../../src/domain/money/money';
import { FailureCode } from '../../src/domain/wagering/failure-code';
import { WagerTransaction, WagerTransactionKind } from '../../src/domain/wagering/wager-transaction';
import { Wallet } from '../../src/domain/wallet/wallet';

const brl = (a: string) => Money.from({ amount: a, currency: 'BRL' });
const t0 = new Date('2026-01-01T00:00:00Z');
const ctx = { eventId: 'ev1', correlationId: 'c1', occurredAt: t0 };

describe('eventos de integração', () => {
  test('WalletBalanceChanged serializa dinheiro como string decimal', () => {
    const w = Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl('100.00'), at: t0 });
    const entry = w.debit({ entryId: 'e1', transactionId: 't1', money: brl('25.00'), at: t0 });
    const json = WalletBalanceChanged.from(w, entry, ctx).toJSON();
    expect(json.eventType).toBe('WalletBalanceChanged');
    expect(json.version).toBe(1);
    expect(json.occurredAt).toBe('2026-01-01T00:00:00.000Z');
    expect(json.data.balanceAfter).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(json.data.walletVersion).toBe(2);
    expect(() => JSON.stringify(json)).not.toThrow();
  });

  test('WagerTransactionRejected carrega o failureCode', () => {
    const tx = WagerTransaction.create({
      id: 't1',
      providerId: 'p',
      externalTransactionId: 'e',
      idempotencyKey: 'p:e',
      payloadHash: 'h',
      walletId: 'w1',
      playerId: 'pl',
      roundId: 'r',
      gameId: 'g',
      kind: WagerTransactionKind.Bet,
      money: brl('10.00'),
      createdAt: t0,
    });
    const ev = WagerTransactionRejected.from(tx, FailureCode.InsufficientFunds, ctx);
    expect(ev.aggregateId).toBe('w1');
    expect(ev.toJSON().data.failureCode).toBe(FailureCode.InsufficientFunds);
  });
});

describe('OutboxMessage', () => {
  const event = () => {
    const w = Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl('10.00'), at: t0 });
    const entry = w.credit({ entryId: 'e', transactionId: 't', money: brl('1.00'), at: t0 });
    return WalletBalanceChanged.from(w, entry, ctx);
  };

  test('enqueue nasce pendente e vencida', () => {
    const m = OutboxMessage.enqueue(event());
    expect(m.id).toBe('ev1');
    expect(m.isPending()).toBe(true);
    expect(m.isDue(t0)).toBe(true);
    expect((m.payload as { eventType: string }).eventType).toBe('WalletBalanceChanged');
  });

  test('scheduleRetry aplica backoff exponencial com teto de 60s', () => {
    const m = OutboxMessage.enqueue(event());
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      m.scheduleRetry(t0);
      delays.push(m.nextAttemptAt!.getTime() - t0.getTime());
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
    expect(m.attempts).toBe(8);
  });

  test('não está vencida antes do nextAttemptAt', () => {
    const m = OutboxMessage.enqueue(event());
    m.scheduleRetry(t0);
    expect(m.isDue(new Date(t0.getTime() + 500))).toBe(false);
    expect(m.isDue(new Date(t0.getTime() + 1000))).toBe(true);
  });

  test('publicada deixa de ser pendente', () => {
    const m = OutboxMessage.enqueue(event());
    m.markPublished(t0);
    expect(m.isPending()).toBe(false);
    expect(m.isDue(t0)).toBe(false);
  });
});

describe('InboxMessage', () => {
  test('receive nasce não processada e markProcessed é idempotente', () => {
    const m = InboxMessage.receive({ messageId: 'm1', consumerName: 'wager', payloadHash: 'h', receivedAt: t0 });
    expect(m.isProcessed()).toBe(false);
    m.markProcessed(t0);
    m.markProcessed(new Date(t0.getTime() + 5000));
    expect(m.isProcessed()).toBe(true);
    expect(m.processedAt).toEqual(t0);
  });
});
