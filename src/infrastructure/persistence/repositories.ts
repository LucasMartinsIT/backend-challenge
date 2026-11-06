import { LockMode } from '@mikro-orm/core';
import type { SqlEntityManager } from '@mikro-orm/postgresql';
import {
  type InboxRepository,
  type LedgerPage,
  type LedgerRepository,
  type OutboxRepository,
  type PendingReferenceCandidate,
  type PendingReferenceRow,
  type ReconciliationSnapshot,
  type Repositories,
  type RetrySchedule,
  StaleWalletVersionError,
  type StoredWagerTransaction,
  type WagerTransactionRepository,
  type WalletRepository,
} from '../../application/ports';
import { InboxMessage } from '../../domain/messaging/inbox-message';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money } from '../../domain/money/money';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import {
  type WagerTransactionRecord,
  WagerTransactionSchema,
  WalletSchema,
} from '../mikro-orm/schemas';
import {
  moneyFromDb,
  transactionToDomain,
  transactionToRecord,
  walletToDomain,
  walletToRecord,
} from './mappers';

// Leituras sem identity map: as escritas são nativas e o Unit of Work não rastreia estas
// entidades, então um objeto em cache poderia ficar velho dentro da mesma transação.
const READ = { disableIdentityMap: true } as const;

class PgWalletRepository implements WalletRepository {
  constructor(private readonly em: SqlEntityManager) {}

  async findById(id: string) {
    const r = await this.em.findOne(WalletSchema, { id }, READ);
    return r ? walletToDomain(r) : undefined;
  }

  async findByIdForUpdate(id: string) {
    const r = await this.em.findOne(WalletSchema, { id }, { ...READ, lockMode: LockMode.PESSIMISTIC_WRITE });
    return r ? walletToDomain(r) : undefined;
  }

  async findByPlayerAndCurrency(playerId: string, currency: string) {
    const r = await this.em.findOne(WalletSchema, { playerId, currency }, READ);
    return r ? walletToDomain(r) : undefined;
  }

  async insert(wallet: Wallet) {
    await this.em.insert(WalletSchema, walletToRecord(wallet));
  }

  async saveBalance(wallet: Wallet, expectedVersion: number) {
    const updated = await this.em.nativeUpdate(
      WalletSchema,
      { id: wallet.id, version: expectedVersion },
      { balance: wallet.balance.toString(), version: wallet.version, updatedAt: wallet.updatedAt },
    );
    if (updated !== 1) throw new StaleWalletVersionError(wallet.id);
  }
}

class PgWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: SqlEntityManager) {}

  findById(id: string) {
    return this.findOneBy({ id });
  }

  findByIdempotencyKey(idempotencyKey: string) {
    return this.findOneBy({ idempotencyKey });
  }

  findByProviderAndExternalId(providerId: string, externalTransactionId: string) {
    return this.findOneBy({ providerId, externalTransactionId });
  }

  async insert(tx: WagerTransaction, balanceAfter?: Money, schedule?: RetrySchedule) {
    await this.em.insert(
      WagerTransactionSchema,
      transactionToRecord(tx, balanceAfter, schedule?.attempts ?? 0, schedule?.nextAttemptAt ?? null),
    );
  }

  async findDuePendingReference(now: Date, limit: number): Promise<PendingReferenceCandidate[]> {
    const rows: Array<{ id: string; wallet_id: string }> = await this.em.execute(
      `select id, wallet_id from wager_transactions
        where status = 'PENDING_REFERENCE' and next_attempt_at <= ?
        order by next_attempt_at
        limit ?`,
      [now, limit],
    );
    return rows.map((r) => ({ id: r.id, walletId: r.wallet_id }));
  }

  async findPendingReferenceForUpdate(id: string, dueBefore?: Date): Promise<PendingReferenceRow | undefined> {
    // Com várias instâncias, todas leem a mesma lista de vencidas. Quem espera o lock da wallet
    // e relê depois do commit de outra precisa ver que a linha já foi reagendada.
    const r = await this.em.findOne(
      WagerTransactionSchema,
      dueBefore
        ? { id, status: 'PENDING_REFERENCE', nextAttemptAt: { $lte: dueBefore } }
        : { id, status: 'PENDING_REFERENCE' },
      { ...READ, lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    if (!r) return undefined;
    return {
      transaction: transactionToDomain(r),
      balanceAfter: r.balanceAfter ? moneyFromDb(r.balanceAfter, r.currency) : undefined,
      attempts: r.attempts,
    };
  }

  async rescheduleReference(id: string, attempts: number, nextAttemptAt: Date) {
    await this.em.nativeUpdate(WagerTransactionSchema, { id }, { attempts, nextAttemptAt });
  }

  async hasProcessedReversalOf(referenceTransactionId: string) {
    const rows: unknown[] = await this.em.execute(
      `select 1 from wager_transactions
        where reference_transaction_id = ? and status = 'PROCESSED' and kind in ('REFUND','ROLLBACK')
        limit 1`,
      [referenceTransactionId],
    );
    return rows.length > 0;
  }

  async update(tx: WagerTransaction, balanceAfter?: Money) {
    const { id: _id, attempts: _a, nextAttemptAt: _n, balanceAfter: after, ...changes } =
      transactionToRecord(tx, balanceAfter);
    // sem saldo novo, mantém o que já estava gravado: é ele que o replay devolve
    await this.em.nativeUpdate(WagerTransactionSchema, { id: tx.id }, after === null ? changes : { ...changes, balanceAfter: after });
  }

  private async findOneBy(where: Partial<WagerTransactionRecord>): Promise<StoredWagerTransaction | undefined> {
    const r = await this.em.findOne(WagerTransactionSchema, where, READ);
    if (!r) return undefined;
    return {
      transaction: transactionToDomain(r),
      balanceAfter: r.balanceAfter ? moneyFromDb(r.balanceAfter, r.currency) : undefined,
    };
  }
}

interface LedgerRow {
  seq: string;
  id: string;
  wallet_id: string;
  transaction_id: string;
  direction: string;
  amount: string;
  balance_before: string;
  balance_after: string;
  currency: string;
  created_at: Date;
}

class PgLedgerRepository implements LedgerRepository {
  constructor(private readonly em: SqlEntityManager) {}

  async append(e: WalletLedgerEntry) {
    await this.em.execute(
      `insert into wallet_ledger_entries
         (id, wallet_id, transaction_id, direction, amount, balance_before, balance_after, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        e.id,
        e.walletId,
        e.transactionId,
        e.direction,
        e.money.toString(),
        e.balanceBefore.toString(),
        e.balanceAfter.toString(),
        e.createdAt,
      ],
    );
  }

  async page(walletId: string, afterSeq: string | undefined, limit: number): Promise<LedgerPage> {
    const rows: LedgerRow[] = await this.em.execute(
      `select l.seq::text as seq, l.id, l.wallet_id, l.transaction_id, l.direction,
              l.amount::text as amount, l.balance_before::text as balance_before,
              l.balance_after::text as balance_after, w.currency, l.created_at
         from wallet_ledger_entries l
         join wallets w on w.id = l.wallet_id
        where l.wallet_id = ? and l.seq > ?
        order by l.seq
        limit ?`,
      [walletId, afterSeq ?? '0', limit],
    );
    return {
      entries: rows.map((r) => ({
        seq: r.seq,
        entry: WalletLedgerEntry.rehydrate({
          id: r.id,
          walletId: r.wallet_id,
          transactionId: r.transaction_id,
          direction: r.direction as LedgerDirection,
          money: moneyFromDb(r.amount, r.currency.trim()),
          balanceBefore: moneyFromDb(r.balance_before, r.currency.trim()),
          balanceAfter: moneyFromDb(r.balance_after, r.currency.trim()),
          // execute() cru não converte timestamptz; garantir Date aqui
          createdAt: new Date(r.created_at),
        }),
      })),
    };
  }

  async rebuildBalance(walletId: string, currency: string) {
    const [row]: Array<{ total: string; entries: number }> = await this.em.execute(
      `select coalesce(sum(case when direction = 'CREDIT' then amount else -amount end), 0)::text as total,
              count(*)::int as entries
         from wallet_ledger_entries where wallet_id = ?`,
      [walletId],
    );
    return { balance: moneyFromDb(row?.total ?? '0.00', currency), entries: row?.entries ?? 0 };
  }

  async reconciliationSnapshot(walletId: string): Promise<ReconciliationSnapshot | undefined> {
    const [row]: Array<{ currency: string; stored: string; calculated: string; entries: number }> =
      await this.em.execute(
        `select w.currency, w.balance::text as stored,
                coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)::text as calculated,
                count(l.id)::int as entries
           from wallets w
           left join wallet_ledger_entries l on l.wallet_id = w.id
          where w.id = ?
          group by w.id`,
        [walletId],
      );
    if (!row) return undefined;
    const currency = row.currency.trim();
    return {
      stored: moneyFromDb(row.stored, currency),
      calculated: moneyFromDb(row.calculated, currency),
      entries: row.entries,
    };
  }
}

class PgInboxRepository implements InboxRepository {
  constructor(private readonly em: SqlEntityManager) {}

  async tryReceive(m: InboxMessage) {
    const rows: unknown[] = await this.em.execute(
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at)
       values (?, ?, ?, ?)
       on conflict (consumer_name, message_id) do nothing
       returning message_id`,
      [m.consumerName, m.messageId, m.payloadHash, m.receivedAt],
    );
    return rows.length === 1;
  }

  async find(consumerName: string, messageId: string) {
    const [r]: Array<{
      consumer_name: string;
      message_id: string;
      payload_hash: string;
      received_at: Date;
      processed_at: Date | null;
    }> = await this.em.execute(
      'select * from inbox_messages where consumer_name = ? and message_id = ?',
      [consumerName, messageId],
    );
    if (!r) return undefined;
    return InboxMessage.rehydrate({
      messageId: r.message_id,
      consumerName: r.consumer_name,
      payloadHash: r.payload_hash,
      receivedAt: new Date(r.received_at),
      processedAt: r.processed_at ? new Date(r.processed_at) : undefined,
    });
  }

  async markProcessed(consumerName: string, messageId: string, at: Date) {
    await this.em.execute(
      `update inbox_messages set processed_at = coalesce(processed_at, ?)
        where consumer_name = ? and message_id = ?`,
      [at, consumerName, messageId],
    );
  }
}

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  attempts: number;
  next_attempt_at: Date | null;
  published_at: Date | null;
  failed_at: Date | null;
}

class PgOutboxRepository implements OutboxRepository {
  constructor(private readonly em: SqlEntityManager) {}

  async lockDue(now: Date, limit: number) {
    const rows: OutboxRow[] = await this.em.execute(
      `select id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at, failed_at
         from outbox_messages
        where published_at is null and failed_at is null and (next_attempt_at is null or next_attempt_at <= ?)
        order by occurred_at, id
        limit ?
        for update skip locked`,
      [now, limit],
    );
    return rows.map((r) =>
      OutboxMessage.rehydrate({
        id: r.id,
        aggregateId: r.aggregate_id,
        eventType: r.event_type,
        payload: r.payload,
        occurredAt: new Date(r.occurred_at),
        attempts: r.attempts,
        nextAttemptAt: r.next_attempt_at ? new Date(r.next_attempt_at) : undefined,
        publishedAt: r.published_at ? new Date(r.published_at) : undefined,
        failedAt: r.failed_at ? new Date(r.failed_at) : undefined,
      }),
    );
  }

  async save(m: OutboxMessage) {
    await this.em.execute(
      `update outbox_messages set attempts = ?, next_attempt_at = ?, published_at = ?, failed_at = ? where id = ?`,
      [m.attempts, m.nextAttemptAt ?? null, m.publishedAt ?? null, m.failedAt ?? null, m.id],
    );
  }

  async stats(now: Date) {
    // abandonadas ficam de fora do lag (senão o alerta dispara para sempre); contam à parte
    const [row]: Array<{ pending: number; age: number; failed: number }> = await this.em.execute(
      `select count(*) filter (where failed_at is null)::int as pending,
              coalesce(extract(epoch from (?::timestamptz - min(occurred_at) filter (where failed_at is null))), 0)::float as age,
              count(*) filter (where failed_at is not null)::int as failed
         from outbox_messages where published_at is null`,
      [now],
    );
    return {
      pending: row?.pending ?? 0,
      oldestAgeSeconds: Math.max(row?.age ?? 0, 0),
      failed: row?.failed ?? 0,
    };
  }

  async add(m: OutboxMessage) {
    await this.em.execute(
      `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
       values (?, ?, ?, ?::jsonb, ?, ?, ?)`,
      [
        m.id,
        m.aggregateId,
        m.eventType,
        JSON.stringify(m.payload),
        m.occurredAt,
        m.attempts,
        m.nextAttemptAt ?? null,
      ],
    );
  }
}

export function buildRepositories(em: SqlEntityManager): Repositories {
  return {
    wallets: new PgWalletRepository(em),
    transactions: new PgWagerTransactionRepository(em),
    ledger: new PgLedgerRepository(em),
    inbox: new PgInboxRepository(em),
    outbox: new PgOutboxRepository(em),
  };
}
