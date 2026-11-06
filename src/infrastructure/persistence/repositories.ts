import { LockMode } from '@mikro-orm/core';
import type { SqlEntityManager } from '@mikro-orm/postgresql';
import {
  type InboxRepository,
  type LedgerPage,
  type LedgerRepository,
  type OutboxRepository,
  type Repositories,
  StaleWalletVersionError,
  type StoredWagerTransaction,
  type WagerTransactionRepository,
  type WalletRepository,
} from '../../application/ports';
import { InboxMessage } from '../../domain/messaging/inbox-message';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
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

  async insert(tx: WagerTransaction, balanceAfter?: Money) {
    await this.em.insert(WagerTransactionSchema, transactionToRecord(tx, balanceAfter));
  }

  async update(tx: WagerTransaction, balanceAfter?: Money) {
    const { id: _id, attempts: _a, nextAttemptAt: _n, ...changes } = transactionToRecord(tx, balanceAfter);
    await this.em.nativeUpdate(WagerTransactionSchema, { id: tx.id }, changes);
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
          createdAt: r.created_at,
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
      receivedAt: r.received_at,
      processedAt: r.processed_at ?? undefined,
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

class PgOutboxRepository implements OutboxRepository {
  constructor(private readonly em: SqlEntityManager) {}

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
