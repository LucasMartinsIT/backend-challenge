import type { InboxMessage } from '../domain/messaging/inbox-message';
import type { OutboxMessage } from '../domain/messaging/outbox-message';
import type { Money } from '../domain/money/money';
import type { WagerTransaction } from '../domain/wagering/wager-transaction';
import type { Wallet } from '../domain/wallet/wallet';
import type { WalletLedgerEntry } from '../domain/wallet/wallet-ledger-entry';

export interface StoredWagerTransaction {
  transaction: WagerTransaction;
  /** Saldo observado quando a transação foi decidida; é o que um replay devolve. */
  balanceAfter: Money | undefined;
}

export interface WalletRepository {
  findById(id: string): Promise<Wallet | undefined>;
  /** SELECT ... FOR UPDATE: serializa tudo o que toca essa wallet. Só dentro de transação. */
  findByIdForUpdate(id: string): Promise<Wallet | undefined>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined>;
  insert(wallet: Wallet): Promise<void>;
  /** Falha com StaleWalletVersionError se a version no banco não for expectedVersion. */
  saveBalance(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<StoredWagerTransaction | undefined>;
  findByIdempotencyKey(key: string): Promise<StoredWagerTransaction | undefined>;
  findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<StoredWagerTransaction | undefined>;
  insert(tx: WagerTransaction, balanceAfter?: Money, schedule?: RetrySchedule): Promise<void>;
  update(tx: WagerTransaction, balanceAfter?: Money): Promise<void>;
  /** Já existe REFUND/ROLLBACK processado apontando para esta transação? */
  hasProcessedReversalOf(referenceTransactionId: string): Promise<boolean>;
  /** Candidatas ao reprocessamento (sem lock; quem processa trava a wallet e relê). */
  findDuePendingReference(now: Date, limit: number): Promise<PendingReferenceCandidate[]>;
  /**
   * Relê a pendente com lock de linha. undefined se outro worker já a resolveu ou, quando
   * `dueBefore` é informado, se ela já foi reagendada para o futuro por outra instância.
   */
  findPendingReferenceForUpdate(id: string, dueBefore?: Date): Promise<PendingReferenceRow | undefined>;
  rescheduleReference(id: string, attempts: number, nextAttemptAt: Date): Promise<void>;
}

export interface PendingReferenceCandidate {
  id: string;
  walletId: string;
}

export interface PendingReferenceRow {
  transaction: WagerTransaction;
  balanceAfter: Money | undefined;
  attempts: number;
}

export interface RetrySchedule {
  attempts: number;
  nextAttemptAt: Date;
}

export interface LedgerPage {
  entries: Array<{ seq: string; entry: WalletLedgerEntry }>;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  /** Paginação por seq (estável, monotônica). */
  page(walletId: string, afterSeq: string | undefined, limit: number): Promise<LedgerPage>;
  /** Saldo reconstruído: soma de créditos menos débitos. */
  rebuildBalance(walletId: string, currency: string): Promise<{ balance: Money; entries: number }>;
  /** Saldo gravado e saldo reconstruído lidos num único statement (mesmo snapshot, sem lock). */
  reconciliationSnapshot(walletId: string): Promise<ReconciliationSnapshot | undefined>;
}

export interface ReconciliationSnapshot {
  stored: Money;
  calculated: Money;
  entries: number;
}

export interface InboxRepository {
  /** false se (consumerName, messageId) já existia. */
  tryReceive(message: InboxMessage): Promise<boolean>;
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
  markProcessed(consumerName: string, messageId: string, at: Date): Promise<void>;
}

export interface OutboxRepository {
  add(message: OutboxMessage): Promise<void>;
  /** Pendentes e vencidas, com FOR UPDATE SKIP LOCKED: publicadores concorrentes não se pisam. */
  lockDue(now: Date, limit: number): Promise<OutboxMessage[]>;
  save(message: OutboxMessage): Promise<void>;
  stats(now: Date): Promise<{ pending: number; oldestAgeSeconds: number; failed: number }>;
}

/** Destino dos eventos da outbox (SQS em produção; nos testes, um fake). */
export interface EventPublisher {
  publish(message: OutboxMessage): Promise<void>;
}

export interface Repositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

/** Tudo o que roda dentro de run() compartilha a mesma transação SQL. */
export interface UnitOfWork {
  run<T>(work: (repos: Repositories) => Promise<T>, options?: UnitOfWorkOptions): Promise<T>;
}

export interface UnitOfWorkOptions {
  /** Derruba a sessão se a transação ficar parada (ex.: conexão sumiu no meio do I/O externo). */
  idleInTransactionTimeoutMs?: number;
}

export class StaleWalletVersionError extends Error {
  constructor(walletId: string) {
    super(`version da wallet ${walletId} mudou durante a operação`);
    this.name = 'StaleWalletVersionError';
  }
}
