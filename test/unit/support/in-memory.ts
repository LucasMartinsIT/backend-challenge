import {
  type LedgerPage,
  type PendingReferenceRow,
  type ReconciliationSnapshot,
  type Repositories,
  StaleWalletVersionError,
  type StoredWagerTransaction,
  type UnitOfWork,
} from '../../../src/application/ports';
import type { InboxMessage } from '../../../src/domain/messaging/inbox-message';
import type { OutboxMessage } from '../../../src/domain/messaging/outbox-message';
import { Money } from '../../../src/domain/money/money';
import { type WagerTransaction, WagerTransactionStatus } from '../../../src/domain/wagering/wager-transaction';
import { Wallet } from '../../../src/domain/wallet/wallet';
import { LedgerDirection, type WalletLedgerEntry } from '../../../src/domain/wallet/wallet-ledger-entry';

/**
 * Repositórios em memória só para testar REGRAS (sem Postgres). Os testes que provam as
 * garantias do banco e a concorrência de verdade continuam sendo os de integração.
 */
export class InMemoryStore {
  wallets = new Map<string, ReturnType<typeof snapshot>>();
  transactions = new Map<string, { transaction: WagerTransaction; balanceAfter?: Money; attempts: number }>();
  ledger: WalletLedgerEntry[] = [];
  inbox = new Map<string, InboxMessage>();
  outbox: OutboxMessage[] = [];
}

const snapshot = (w: Wallet) => ({
  id: w.id,
  playerId: w.playerId,
  currency: w.currency,
  balance: w.balance,
  version: w.version,
  createdAt: w.createdAt,
  updatedAt: w.updatedAt,
});

function build(store: InMemoryStore): Repositories {
  const stored = (id?: string): StoredWagerTransaction | undefined => {
    const row = id ? store.transactions.get(id) : undefined;
    return row ? { transaction: row.transaction, balanceAfter: row.balanceAfter } : undefined;
  };
  const findTx = (pred: (t: WagerTransaction) => boolean) =>
    stored([...store.transactions.values()].find((r) => pred(r.transaction))?.transaction.id);

  return {
    wallets: {
      async findById(id) {
        const s = store.wallets.get(id);
        return s ? Wallet.rehydrate(s) : undefined;
      },
      async findByIdForUpdate(id) {
        const s = store.wallets.get(id);
        return s ? Wallet.rehydrate(s) : undefined;
      },
      async findByPlayerAndCurrency(playerId, currency) {
        const s = [...store.wallets.values()].find((w) => w.playerId === playerId && w.currency === currency);
        return s ? Wallet.rehydrate(s) : undefined;
      },
      async insert(wallet) {
        store.wallets.set(wallet.id, snapshot(wallet));
      },
      async saveBalance(wallet, expectedVersion) {
        const current = store.wallets.get(wallet.id);
        if (!current || current.version !== expectedVersion) throw new StaleWalletVersionError(wallet.id);
        store.wallets.set(wallet.id, snapshot(wallet));
      },
    },
    transactions: {
      async findById(id) {
        return stored(id);
      },
      async findByIdempotencyKey(key) {
        return findTx((t) => t.idempotencyKey === key);
      },
      async findByProviderAndExternalId(providerId, externalTransactionId) {
        return findTx((t) => t.providerId === providerId && t.externalTransactionId === externalTransactionId);
      },
      async insert(tx, balanceAfter, schedule) {
        store.transactions.set(tx.id, { transaction: tx, balanceAfter, attempts: schedule?.attempts ?? 0 });
      },
      async update(tx, balanceAfter) {
        const row = store.transactions.get(tx.id)!;
        store.transactions.set(tx.id, { ...row, transaction: tx, balanceAfter: balanceAfter ?? row.balanceAfter });
      },
      async hasProcessedReversalOf(referenceTransactionId) {
        return [...store.transactions.values()].some(
          ({ transaction: t }) =>
            t.referenceTransactionId === referenceTransactionId &&
            t.status === WagerTransactionStatus.Processed &&
            (t.kind === 'REFUND' || t.kind === 'ROLLBACK'),
        );
      },
      async findDuePendingReference() {
        return [...store.transactions.values()]
          .filter((r) => r.transaction.status === WagerTransactionStatus.PendingReference)
          .map((r) => ({ id: r.transaction.id, walletId: r.transaction.walletId }));
      },
      async findPendingReferenceForUpdate(id): Promise<PendingReferenceRow | undefined> {
        const r = store.transactions.get(id);
        if (!r || r.transaction.status !== WagerTransactionStatus.PendingReference) return undefined;
        return { transaction: r.transaction, balanceAfter: r.balanceAfter, attempts: r.attempts };
      },
      async rescheduleReference(id, attempts) {
        const r = store.transactions.get(id)!;
        store.transactions.set(id, { ...r, attempts });
      },
    },
    ledger: {
      async append(entry) {
        store.ledger.push(entry);
      },
      async page(walletId, afterSeq, limit): Promise<LedgerPage> {
        const rows = store.ledger
          .map((entry, i) => ({ seq: String(i + 1), entry }))
          .filter((r) => r.entry.walletId === walletId && Number(r.seq) > Number(afterSeq ?? 0));
        return { entries: rows.slice(0, limit) };
      },
      async rebuildBalance(walletId, currency) {
        const mine = store.ledger.filter((e) => e.walletId === walletId);
        const balance = mine.reduce(
          (acc, e) => (e.direction === LedgerDirection.Credit ? acc.add(e.money) : acc.subtract(e.money)),
          Money.zero(currency),
        );
        return { balance, entries: mine.length };
      },
      async reconciliationSnapshot(walletId): Promise<ReconciliationSnapshot | undefined> {
        const w = store.wallets.get(walletId);
        if (!w) return undefined;
        const mine = store.ledger.filter((e) => e.walletId === walletId);
        const calculated = mine.reduce(
          (acc, e) => (e.direction === LedgerDirection.Credit ? acc.add(e.money) : acc.subtract(e.money)),
          Money.zero(w.currency),
        );
        return { stored: w.balance, calculated, entries: mine.length };
      },
    },
    inbox: {
      async tryReceive(message) {
        const key = `${message.consumerName}/${message.messageId}`;
        if (store.inbox.has(key)) return false;
        store.inbox.set(key, message);
        return true;
      },
      async find(consumerName, messageId) {
        return store.inbox.get(`${consumerName}/${messageId}`);
      },
      async markProcessed(consumerName, messageId, at) {
        store.inbox.get(`${consumerName}/${messageId}`)?.markProcessed(at);
      },
    },
    outbox: {
      async add(message) {
        store.outbox.push(message);
      },
      async lockDue(now, limit) {
        return store.outbox.filter((m) => m.isDue(now)).slice(0, limit);
      },
      async save() {},
      async stats() {
        const pending = store.outbox.filter((m) => m.isPending());
        return { pending: pending.length, oldestAgeSeconds: 0, failed: 0 };
      },
    },
  };
}

/** Executa um trabalho por vez, como o lock da wallet faria, e dá os mesmos repositórios. */
export class InMemoryUnitOfWork implements UnitOfWork {
  private tail: Promise<unknown> = Promise.resolve();
  readonly repos: Repositories;

  constructor(readonly store: InMemoryStore) {
    this.repos = build(store);
  }

  run<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    const result = this.tail.then(() => work(this.repos));
    this.tail = result.catch(() => {});
    return result;
  }
}
