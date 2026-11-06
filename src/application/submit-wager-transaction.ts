import { InboxMessage } from '../domain/messaging/inbox-message';
import { Money, type MoneyProps } from '../domain/money/money';
import type { FailureCode } from '../domain/wagering/failure-code';
import { hashPayload } from '../domain/wagering/payload-hash';
import {
  WagerTransaction,
  type WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wagering/wager-transaction';
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  InboxPayloadMismatchError,
  WalletNotFoundError,
} from './errors';
import type { StoredWagerTransaction, UnitOfWork } from './ports';
import type { Clock, IdGenerator } from './support';
import { applyTransaction, enqueueEvents, eventsFor } from './wager-processing';

export interface SubmitWagerCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
  correlationId: string;
  /** Preenchido quando a entrada é SQS: o registro de inbox entra na mesma transação. */
  inbox?: { consumerName: string; messageId: string; payloadHash: string } | undefined;
}

export interface SubmitWagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  failureCode?: FailureCode | undefined;
  idempotentReplay: boolean;
}

const IDEMPOTENCY_CONSTRAINTS = new Set([
  'wager_tx_idempotency_unique',
  'wager_tx_provider_external_unique',
  // backstop do lock da wallet: na segunda rodada a reversão já existe e a regra rejeita
  'wager_tx_single_reversal',
]);

function isIdempotencyRace(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string };
  return e.code === '23505' && IDEMPOTENCY_CONSTRAINTS.has(e.constraint ?? '');
}

export class SubmitWagerTransaction {
  constructor(
    private readonly deps: { uow: UnitOfWork; clock: Clock; ids: IdGenerator },
  ) {}

  async execute(cmd: SubmitWagerCommand): Promise<SubmitWagerResult> {
    const money = Money.from(cmd.money);
    const payloadHash = hashPayload({ ...cmd, money: money.toJSON() });

    // Duas requisições com a mesma chave em wallets diferentes não se enxergam pelo lock da
    // wallet; a unique do banco derruba uma delas. Na segunda rodada ela já encontra a outra.
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.executeOnce(cmd, money, payloadHash);
      } catch (err) {
        if (attempt === 1 && isIdempotencyRace(err)) continue;
        throw err;
      }
    }
  }

  private executeOnce(cmd: SubmitWagerCommand, money: Money, payloadHash: string) {
    const { uow, clock, ids } = this.deps;

    return uow.run(async (repos): Promise<SubmitWagerResult> => {
      const now = clock.now();
      if (cmd.inbox) {
        const first = await repos.inbox.tryReceive(InboxMessage.receive({ ...cmd.inbox, receivedAt: now }));
        if (!first) {
          // redelivery: a mensagem tem de ser a mesma. Se o conteúdo mudou, é erro permanente.
          const seen = await repos.inbox.find(cmd.inbox.consumerName, cmd.inbox.messageId);
          if (seen && seen.payloadHash !== cmd.inbox.payloadHash) {
            throw new InboxPayloadMismatchError(`messageId ${cmd.inbox.messageId} reapareceu com outro conteúdo`);
          }
        }
      }

      // O lock da wallet vem antes de qualquer decisão: é ele que serializa duplicatas e
      // apostas concorrentes sobre o mesmo saldo.
      const wallet = await repos.wallets.findByIdForUpdate(cmd.walletId);
      if (!wallet) {
        // a chave já existir com outra wallet significa payload diferente: é conflito, não 404
        if (await repos.transactions.findByIdempotencyKey(cmd.idempotencyKey)) {
          throw new IdempotencyConflictError(`a chave ${cmd.idempotencyKey} já foi usada com outro payload`);
        }
        throw new WalletNotFoundError(cmd.walletId);
      }

      const existing = await repos.transactions.findByIdempotencyKey(cmd.idempotencyKey);
      if (existing) {
        if (!existing.transaction.matchesPayload(payloadHash)) {
          throw new IdempotencyConflictError(
            `a chave ${cmd.idempotencyKey} já foi usada com outro payload`,
          );
        }
        if (cmd.inbox) await repos.inbox.markProcessed(cmd.inbox.consumerName, cmd.inbox.messageId, now);
        return toResult(existing, wallet.balance.toJSON(), true);
      }

      const sameExternal = await repos.transactions.findByProviderAndExternalId(
        cmd.providerId,
        cmd.externalTransactionId,
      );
      if (sameExternal) {
        throw new ExternalTransactionConflictError(
          `${cmd.providerId}/${cmd.externalTransactionId} já existe com outra Idempotency-Key`,
        );
      }

      const tx = WagerTransaction.create({
        id: ids.next(),
        providerId: cmd.providerId,
        externalTransactionId: cmd.externalTransactionId,
        idempotencyKey: cmd.idempotencyKey,
        payloadHash,
        walletId: cmd.walletId,
        playerId: cmd.playerId,
        roundId: cmd.roundId,
        gameId: cmd.gameId,
        kind: cmd.kind,
        money,
        referenceExternalTransactionId: cmd.referenceExternalTransactionId,
        createdAt: now,
      });

      const versionBefore = wallet.version;
      const entry = await applyTransaction(repos, ids, wallet, tx, now);

      // transação antes do lançamento: o ledger tem FK para ela
      const retry =
        tx.status === WagerTransactionStatus.PendingReference
          ? { attempts: 0, nextAttemptAt: new Date(now.getTime() + 1000) }
          : undefined;
      await repos.transactions.insert(tx, wallet.balance, retry);
      if (entry) {
        await repos.ledger.append(entry);
        await repos.wallets.saveBalance(wallet, versionBefore);
      }
      await enqueueEvents(
        repos,
        eventsFor(tx, wallet, entry, ids, { correlationId: cmd.correlationId, now }),
      );
      if (cmd.inbox) await repos.inbox.markProcessed(cmd.inbox.consumerName, cmd.inbox.messageId, now);

      return toResult({ transaction: tx, balanceAfter: wallet.balance }, wallet.balance.toJSON(), false);
    });
  }
}

function toResult(
  stored: StoredWagerTransaction,
  fallbackBalance: MoneyProps,
  idempotentReplay: boolean,
): SubmitWagerResult {
  return {
    transactionId: stored.transaction.id,
    status: stored.transaction.status,
    // replay devolve o saldo observado na época, não o saldo de agora
    balance: stored.balanceAfter?.toJSON() ?? fallbackBalance,
    failureCode: stored.transaction.failureCode,
    idempotentReplay,
  };
}
