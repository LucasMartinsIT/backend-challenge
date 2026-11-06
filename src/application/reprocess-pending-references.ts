import { FailureCode } from '../domain/wagering/failure-code';
import { WagerTransactionStatus } from '../domain/wagering/wager-transaction';
import type { PendingReferenceCandidate, UnitOfWork } from './ports';
import type { Clock, IdGenerator } from './support';
import { applyTransaction, enqueueEvents, eventsFor } from './wager-processing';

export interface PendingReferenceOptions {
  /** Depois de tantas tentativas sem encontrar a referência, a transação é rejeitada. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  batchSize: number;
}

export const DEFAULT_PENDING_OPTIONS: PendingReferenceOptions = {
  maxAttempts: 12,
  baseDelayMs: 1000,
  maxDelayMs: 60_000,
  batchSize: 20,
};

/** Backoff exponencial: base, 2x, 4x... limitado a maxDelayMs. */
export function pendingBackoffMs(attempts: number, o: PendingReferenceOptions): number {
  return Math.min(o.baseDelayMs * 2 ** attempts, o.maxDelayMs);
}

export class ReprocessPendingReferences {
  constructor(
    private readonly deps: {
      uow: UnitOfWork;
      clock: Clock;
      ids: IdGenerator;
      /** Para log e métrica de erros por candidata. */
      onError?: (candidate: PendingReferenceCandidate, err: unknown) => void;
    },
    private readonly options: PendingReferenceOptions = DEFAULT_PENDING_OPTIONS,
  ) {}

  /** Devolve quantas candidatas foram examinadas (0 = nada vencido). */
  async runOnce(): Promise<number> {
    const { uow, clock } = this.deps;
    const candidates = await uow.run((r) =>
      r.transactions.findDuePendingReference(clock.now(), this.options.batchSize),
    );

    for (const candidate of candidates) {
      try {
        await this.reprocess(candidate);
      } catch (err) {
        // uma candidata com defeito não pode travar as outras, nem ficar sendo a primeira da fila
        // para sempre: o erro conta como tentativa e ela é reagendada
        this.deps.onError?.(candidate, err);
        await this.deferAfterError(candidate).catch((e) => this.deps.onError?.(candidate, e));
      }
    }
    return candidates.length;
  }

  private reprocess(candidate: PendingReferenceCandidate) {
    const { uow, clock, ids } = this.deps;

    return uow.run(async (repos) => {
      const now = clock.now();

      // mesma ordem de locks do fluxo de submissão: wallet primeiro, depois a transação
      const wallet = await repos.wallets.findByIdForUpdate(candidate.walletId);
      if (!wallet) return;
      // Relê só se ainda estiver vencida. Com várias instâncias, quem esperava o lock da wallet
      // encontra a linha já reagendada pela que chegou primeiro e não gasta outra tentativa.
      const row = await repos.transactions.findPendingReferenceForUpdate(candidate.id, now);
      if (!row) return;

      const { transaction: tx, attempts } = row;
      const versionBefore = wallet.version;
      const entry = await applyTransaction(repos, ids, wallet, tx, now);

      if (tx.status === WagerTransactionStatus.PendingReference) {
        const next = attempts + 1;
        if (next < this.options.maxAttempts) {
          const delay = pendingBackoffMs(next, this.options);
          await repos.transactions.rescheduleReference(tx.id, next, new Date(now.getTime() + delay));
          return;
        }
        // acabou o prazo: a referência não apareceu
        tx.reject(FailureCode.ReferenceNotFound);
      }

      if (entry) {
        await repos.ledger.append(entry);
        await repos.wallets.saveBalance(wallet, versionBefore);
      }
      await repos.transactions.update(tx, wallet.balance);
      await enqueueEvents(repos, eventsFor(tx, wallet, entry, ids, { correlationId: tx.id, now }));
    });
  }

  // Em transação separada: a anterior deu rollback. Esgotado o limite, vira FAILED (erro
  // permanente nosso, auditável) em vez de ficar pendente para sempre.
  private deferAfterError(candidate: PendingReferenceCandidate) {
    const { uow, clock } = this.deps;

    return uow.run(async (repos) => {
      const now = clock.now();
      const row = await repos.transactions.findPendingReferenceForUpdate(candidate.id);
      if (!row) return;

      const next = row.attempts + 1;
      if (next < this.options.maxAttempts) {
        const delay = pendingBackoffMs(next, this.options);
        await repos.transactions.rescheduleReference(candidate.id, next, new Date(now.getTime() + delay));
        return;
      }
      row.transaction.fail(FailureCode.InternalPermanentError);
      await repos.transactions.update(row.transaction, row.balanceAfter);
    });
  }
}
