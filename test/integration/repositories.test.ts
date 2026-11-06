import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { StaleWalletVersionError } from '../../src/application/ports';
import { OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { InboxMessage } from '../../src/domain/messaging/inbox-message';
import { WalletBalanceChanged } from '../../src/domain/events/wager-events';
import { Money } from '../../src/domain/money/money';
import { FailureCode } from '../../src/domain/wagering/failure-code';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction';
import { Wallet } from '../../src/domain/wallet/wallet';
import { LedgerDirection } from '../../src/domain/wallet/wallet-ledger-entry';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createTestOrm, resetSchema, uuid } from './support';

let orm: MikroORM;
let uow: MikroOrmUnitOfWork;
const brl = (a: string) => Money.from({ amount: a, currency: 'BRL' });
const now = () => new Date();

beforeAll(async () => {
  orm = await createTestOrm();
  await resetSchema(orm);
  uow = new MikroOrmUnitOfWork(orm);
});
afterAll(() => orm.close());

function bet(walletId: string, playerId: string, amount: string) {
  return WagerTransaction.create({
    id: uuid(),
    providerId: 'prov',
    externalTransactionId: uuid(),
    idempotencyKey: uuid(),
    payloadHash: 'h',
    walletId,
    playerId,
    roundId: 'r',
    gameId: 'g',
    kind: WagerTransactionKind.Bet,
    money: brl(amount),
    createdAt: now(),
  });
}

describe('repositórios', () => {
  test('wallet, transação, ledger e outbox fazem round-trip como objetos de domínio', async () => {
    const wallet = Wallet.open({ id: uuid(), playerId: uuid(), initialBalance: brl('100.00') });
    const tx = bet(wallet.id, wallet.playerId, '30.00');

    await uow.run(async (r) => {
      await r.wallets.insert(wallet);
      await r.transactions.insert(tx);
      const locked = (await r.wallets.findByIdForUpdate(wallet.id))!;
      const before = locked.version;
      const entry = locked.debit({ entryId: uuid(), transactionId: tx.id, money: tx.money, at: now() });
      tx.markProcessed(undefined, now());
      await r.ledger.append(entry);
      await r.wallets.saveBalance(locked, before);
      await r.transactions.update(tx, locked.balance);
      await r.outbox.add(
        OutboxMessage.enqueue(
          WalletBalanceChanged.from(locked, entry, { eventId: uuid(), correlationId: 'c', occurredAt: now() }),
        ),
      );
    });

    await uow.run(async (r) => {
      const w = (await r.wallets.findById(wallet.id))!;
      expect(w.balance.toString()).toBe('70.00');
      expect(w.version).toBe(2);

      const stored = (await r.transactions.findByIdempotencyKey(tx.idempotencyKey))!;
      expect(stored.transaction.status).toBe(WagerTransactionStatus.Processed);
      expect(stored.balanceAfter?.toString()).toBe('70.00');
      expect(stored.transaction.money.toString()).toBe('30.00');

      const page = await r.ledger.page(wallet.id, undefined, 10);
      expect(page.entries).toHaveLength(1);
      expect(page.entries[0]!.entry.direction).toBe(LedgerDirection.Debit);

      const rebuilt = await r.ledger.rebuildBalance(wallet.id, 'BRL');
      expect(rebuilt.entries).toBe(1);
      // ledger só tem o débito (sem OPENING neste teste): soma = -30.00
      expect(rebuilt.balance.toString()).toBe('-30.00');
    });

    const rows = (await orm.em
      .fork()
      .execute(`select count(*)::int as n from outbox_messages where aggregate_id = ?`, [wallet.id])) as Array<{ n: number }>;
    expect(rows[0]?.n).toBe(1);
  });

  test('transação que falha dá rollback de tudo', async () => {
    const wallet = Wallet.open({ id: uuid(), playerId: uuid(), initialBalance: brl('10.00') });
    await expect(
      uow.run(async (r) => {
        await r.wallets.insert(wallet);
        throw new Error('queda no meio');
      }),
    ).rejects.toThrow('queda no meio');
    const found = await uow.run((r) => r.wallets.findById(wallet.id));
    expect(found).toBeUndefined();
  });

  test('saveBalance com version velha falha', async () => {
    const wallet = Wallet.open({ id: uuid(), playerId: uuid(), initialBalance: brl('10.00') });
    await uow.run((r) => r.wallets.insert(wallet));
    await expect(
      uow.run(async (r) => {
        const w = (await r.wallets.findById(wallet.id))!;
        w.credit({ entryId: uuid(), transactionId: uuid(), money: brl('1.00'), at: now() });
        await r.wallets.saveBalance(w, 99);
      }),
    ).rejects.toBeInstanceOf(StaleWalletVersionError);
  });

  test('findByIdForUpdate bloqueia uma segunda transação até o commit', async () => {
    const wallet = Wallet.open({ id: uuid(), playerId: uuid(), initialBalance: brl('10.00') });
    await uow.run((r) => r.wallets.insert(wallet));

    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    let holding!: () => void;
    const holdingLock = new Promise<void>((res) => (holding = res));

    const first = uow.run(async (r) => {
      await r.wallets.findByIdForUpdate(wallet.id);
      holding();
      await gate;
      order.push('first-commit');
    });
    await holdingLock;
    const second = uow.run(async (r) => {
      await r.wallets.findByIdForUpdate(wallet.id);
      order.push('second-got-lock');
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(order).toEqual([]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-commit', 'second-got-lock']);
  });

  test('inbox: segunda recepção da mesma mensagem é detectada', async () => {
    const msg = InboxMessage.receive({ messageId: uuid(), consumerName: 'wager', payloadHash: 'h', receivedAt: now() });
    expect(await uow.run((r) => r.inbox.tryReceive(msg))).toBe(true);
    expect(await uow.run((r) => r.inbox.tryReceive(msg))).toBe(false);
    await uow.run((r) => r.inbox.markProcessed('wager', msg.messageId, now()));
    const stored = await uow.run((r) => r.inbox.find('wager', msg.messageId));
    expect(stored?.isProcessed()).toBe(true);
  });

  test('transação REJECTED guarda o failure_code', async () => {
    const wallet = Wallet.open({ id: uuid(), playerId: uuid(), initialBalance: brl('5.00') });
    const tx = bet(wallet.id, wallet.playerId, '50.00');
    tx.reject(FailureCode.InsufficientFunds);
    await uow.run(async (r) => {
      await r.wallets.insert(wallet);
      await r.transactions.insert(tx, wallet.balance);
    });
    const stored = await uow.run((r) => r.transactions.findById(tx.id));
    expect(stored?.transaction.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(stored?.balanceAfter?.toString()).toBe('5.00');
  });
});
