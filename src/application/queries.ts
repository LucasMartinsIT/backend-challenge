import type { MoneyProps } from '../domain/money/money';
import type { WagerTransactionKind, WagerTransactionStatus } from '../domain/wagering/wager-transaction';
import type { FailureCode } from '../domain/wagering/failure-code';
import type { LedgerDirection } from '../domain/wallet/wallet-ledger-entry';
import { InvalidCursorError, TransactionNotFoundError, WalletNotFoundError } from './errors';
import type { StoredWagerTransaction, UnitOfWork } from './ports';

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface LedgerPageView {
  entries: LedgerEntryView[];
  nextCursor: string | null;
}

export interface TransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  roundId: string;
  kind: WagerTransactionKind;
  status: WagerTransactionStatus;
  money: MoneyProps;
  balance: MoneyProps | null;
  failureCode: FailureCode | null;
  referenceTransactionId: string | null;
  createdAt: string;
  processedAt: string | null;
}

export interface ReconciliationView {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

// O cursor é opaco para o cliente: hoje carrega só o seq do último item visto.
export function encodeCursor(seq: string): string {
  return Buffer.from(`v1:${seq}`).toString('base64url');
}

export function decodeCursor(cursor: string): string {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const match = /^v1:(\d{1,18})$/.exec(decoded);
  if (!match) throw new InvalidCursorError('cursor inválido');
  return match[1]!;
}

export class WalletQueries {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly onMismatch: (info: { walletId: string; difference: string }) => void = () => {},
  ) {}

  async getWallet(walletId: string): Promise<WalletView> {
    const wallet = await this.uow.run((r) => r.wallets.findById(walletId));
    if (!wallet) throw new WalletNotFoundError(walletId);
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }

  async getLedger(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPageView> {
    const afterSeq = cursor ? decodeCursor(cursor) : undefined;
    const size = Math.min(Math.max(limit, 1), MAX_PAGE_SIZE);

    const { wallet, page } = await this.uow.run(async (r) => ({
      wallet: await r.wallets.findById(walletId),
      // uma linha a mais só para saber se existe próxima página
      page: await r.ledger.page(walletId, afterSeq, size + 1),
    }));
    if (!wallet) throw new WalletNotFoundError(walletId);

    const visible = page.entries.slice(0, size);
    const last = visible[visible.length - 1];
    return {
      entries: visible.map(({ entry }) => ({
        id: entry.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        createdAt: entry.createdAt.toISOString(),
      })),
      nextCursor: page.entries.length > size && last ? encodeCursor(last.seq) : null,
    };
  }

  async getTransactionById(id: string): Promise<TransactionView> {
    const stored = await this.uow.run((r) => r.transactions.findById(id));
    if (!stored) throw new TransactionNotFoundError(`transação ${id} não encontrada`);
    return toView(stored);
  }

  async getTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<TransactionView> {
    const stored = await this.uow.run((r) =>
      r.transactions.findByProviderAndExternalId(providerId, externalTransactionId),
    );
    if (!stored) {
      throw new TransactionNotFoundError(`transação ${providerId}/${externalTransactionId} não encontrada`);
    }
    return toView(stored);
  }

  /** Divergência não é corrigida: é logada, contada e devolvida na resposta. */
  async reconcile(walletId: string): Promise<ReconciliationView> {
    const snap = await this.uow.run((r) => r.ledger.reconciliationSnapshot(walletId));
    if (!snap) throw new WalletNotFoundError(walletId);

    const difference = snap.stored.subtract(snap.calculated);
    const consistent = difference.isZero();
    if (!consistent) this.onMismatch({ walletId, difference: difference.toString() });
    return {
      walletId,
      storedBalance: snap.stored.toJSON(),
      calculatedBalance: snap.calculated.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: snap.entries,
    };
  }
}

function toView({ transaction: t, balanceAfter }: StoredWagerTransaction): TransactionView {
  return {
    transactionId: t.id,
    providerId: t.providerId,
    externalTransactionId: t.externalTransactionId,
    walletId: t.walletId,
    roundId: t.roundId,
    kind: t.kind,
    status: t.status,
    money: t.money.toJSON(),
    balance: balanceAfter?.toJSON() ?? null,
    failureCode: t.failureCode ?? null,
    referenceTransactionId: t.referenceTransactionId ?? null,
    createdAt: t.createdAt.toISOString(),
    processedAt: t.processedAt?.toISOString() ?? null,
  };
}
