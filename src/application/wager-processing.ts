import type { IntegrationEvent } from '../domain/events/integration-event';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../domain/events/wager-events';
import { OutboxMessage } from '../domain/messaging/outbox-message';
import { FailureCode } from '../domain/wagering/failure-code';
import {
  type WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../domain/wagering/wager-transaction';
import type { Wallet } from '../domain/wallet/wallet';
import { LedgerDirection, type WalletLedgerEntry } from '../domain/wallet/wallet-ledger-entry';
import type { Repositories } from './ports';
import type { IdGenerator } from './support';

const REFERENCE_RULES: Partial<Record<Kind, readonly Kind[]>> = {
  [Kind.Refund]: [Kind.Bet],
  [Kind.Rollback]: [Kind.Bet, Kind.Win, Kind.Refund],
  [Kind.Win]: [Kind.Bet],
  [Kind.Loss]: [Kind.Bet],
};

type ReferenceVerdict = FailureCode | 'WAIT' | undefined;

function checkReference(tx: WagerTransaction, ref: WagerTransaction): ReferenceVerdict {
  const sameContext =
    ref.walletId === tx.walletId &&
    ref.playerId === tx.playerId &&
    ref.roundId === tx.roundId &&
    ref.money.currency === tx.money.currency;
  if (!sameContext) return FailureCode.ReferenceMismatch;

  if (!REFERENCE_RULES[tx.kind]?.includes(ref.kind)) return FailureCode.ReferenceKindNotAllowed;

  if (ref.status === Status.Pending || ref.status === Status.PendingReference) return 'WAIT';
  if (ref.status !== Status.Processed) return FailureCode.ReferenceNotProcessed;

  if (tx.requiresReference() && !ref.money.equals(tx.money)) return FailureCode.ReferenceAmountMismatch;
  return undefined;
}

/**
 * Aplica as regras de negócio a uma transação já criada. Muda `tx` (estado) e `wallet`
 * (saldo) em memória e devolve o lançamento do ledger, se houve. Quem chama precisa estar
 * dentro de uma transação SQL e com a wallet travada (FOR UPDATE).
 */
export async function applyTransaction(
  repos: Repositories,
  ids: IdGenerator,
  wallet: Wallet,
  tx: WagerTransaction,
  now: Date,
): Promise<WalletLedgerEntry | undefined> {
  if (tx.playerId !== wallet.playerId) {
    tx.reject(FailureCode.WalletPlayerMismatch);
    return undefined;
  }
  if (tx.money.currency !== wallet.currency) {
    tx.reject(FailureCode.CurrencyMismatch);
    return undefined;
  }

  let reference: WagerTransaction | undefined;
  if (tx.referenceExternalTransactionId) {
    const found = await repos.transactions.findByProviderAndExternalId(
      tx.providerId,
      tx.referenceExternalTransactionId,
    );
    if (!found) {
      tx.markPendingReference();
      return undefined;
    }
    reference = found.transaction;

    const verdict = checkReference(tx, reference);
    if (verdict === 'WAIT') {
      tx.markPendingReference();
      return undefined;
    }
    if (verdict) {
      tx.reject(verdict);
      return undefined;
    }
    // vale para qualquer tipo: um WIN sobre uma BET já devolvida também seria crédito indevido
    if (await repos.transactions.hasProcessedReversalOf(reference.id)) {
      tx.reject(FailureCode.ReferenceAlreadyReversed);
      return undefined;
    }
  }

  if (!tx.affectsBalance()) {
    tx.markProcessed(reference?.id, now);
    return undefined;
  }

  const movement = { entryId: ids.next(), transactionId: tx.id, money: tx.money, at: now };
  let entry: WalletLedgerEntry;
  if (tx.ledgerDirectionFor(reference) === LedgerDirection.Debit) {
    if (wallet.balance.isLessThan(tx.money)) {
      // aposta sem saldo e reversão sem saldo são situações operacionais diferentes
      tx.reject(tx.kind === Kind.Bet ? FailureCode.InsufficientFunds : FailureCode.ReversalInsufficientFunds);
      return undefined;
    }
    entry = wallet.debit(movement);
  } else {
    entry = wallet.credit(movement);
  }
  tx.markProcessed(reference?.id, now);
  return entry;
}

export interface EventSource {
  correlationId: string;
  now: Date;
}

/** Eventos que o resultado de uma transação gera. Vão para a outbox na mesma transação SQL. */
export function eventsFor(
  tx: WagerTransaction,
  wallet: Wallet,
  entry: WalletLedgerEntry | undefined,
  ids: IdGenerator,
  source: EventSource,
): IntegrationEvent<unknown>[] {
  const ctx = () => ({
    eventId: ids.next(),
    correlationId: source.correlationId,
    causationId: tx.id,
    occurredAt: source.now,
  });
  switch (tx.status) {
    case Status.Processed: {
      const events: IntegrationEvent<unknown>[] = [WagerTransactionProcessed.from(tx, ctx())];
      if (entry) events.push(WalletBalanceChanged.from(wallet, entry, ctx()));
      return events;
    }
    case Status.Rejected:
      return [WagerTransactionRejected.from(tx, tx.failureCode!, ctx())];
    case Status.PendingReference:
      return [WagerTransactionPendingReference.from(tx, ctx())];
    default:
      return [];
  }
}

export async function enqueueEvents(repos: Repositories, events: IntegrationEvent<unknown>[]) {
  for (const event of events) await repos.outbox.add(OutboxMessage.enqueue(event));
}
