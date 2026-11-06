import { WagerTransactionProcessed, WalletBalanceChanged } from '../domain/events/wager-events';
import { Money, type MoneyProps } from '../domain/money/money';
import { hashPayload } from '../domain/wagering/payload-hash';
import { WagerTransaction } from '../domain/wagering/wager-transaction';
import { Wallet } from '../domain/wallet/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../domain/wallet/wallet-ledger-entry';
import { WalletAlreadyExistsError } from './errors';
import type { UnitOfWork } from './ports';
import type { Clock, IdGenerator } from './support';
import { enqueueEvents } from './wager-processing';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}

export interface CreateWalletResult {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export class CreateWallet {
  constructor(private readonly deps: { uow: UnitOfWork; clock: Clock; ids: IdGenerator }) {}

  async execute(cmd: CreateWalletCommand): Promise<CreateWalletResult> {
    const initial = Money.from(cmd.initialBalance);
    const { uow, clock, ids } = this.deps;

    try {
      return await uow.run(async (repos) => {
        if (await repos.wallets.findByPlayerAndCurrency(cmd.playerId, initial.currency)) {
          throw new WalletAlreadyExistsError(
            `já existe wallet ${initial.currency} para o jogador ${cmd.playerId}`,
          );
        }

        const now = clock.now();
        // a wallet nasce com o saldo final e version 1; o OPENING só registra de onde ele veio
        const wallet = Wallet.open({ id: ids.next(), playerId: cmd.playerId, initialBalance: initial, at: now });
        await repos.wallets.insert(wallet);

        if (initial.isPositive()) {
          const key = `opening:${wallet.id}`;
          const opening = WagerTransaction.createOpening({
            id: ids.next(),
            providerId: 'internal',
            externalTransactionId: key,
            idempotencyKey: key,
            payloadHash: hashPayload({
              providerId: 'internal',
              externalTransactionId: key,
              playerId: wallet.playerId,
              walletId: wallet.id,
              roundId: 'opening',
              gameId: 'opening',
              kind: 'OPENING',
              money: initial.toJSON(),
            }),
            walletId: wallet.id,
            playerId: wallet.playerId,
            roundId: 'opening',
            gameId: 'opening',
            money: initial,
            createdAt: now,
          });
          opening.markProcessed(undefined, now);

          const entry = WalletLedgerEntry.create({
            id: ids.next(),
            walletId: wallet.id,
            transactionId: opening.id,
            direction: LedgerDirection.Credit,
            money: initial,
            balanceBefore: Money.zero(initial.currency),
            balanceAfter: initial,
            createdAt: now,
          });
          await repos.transactions.insert(opening, wallet.balance);
          await repos.ledger.append(entry);

          const ctx = () => ({
            eventId: ids.next(),
            correlationId: cmd.correlationId,
            causationId: opening.id,
            occurredAt: now,
          });
          await enqueueEvents(repos, [
            WagerTransactionProcessed.from(opening, ctx()),
            WalletBalanceChanged.from(wallet, entry, ctx()),
          ]);
        }

        return {
          id: wallet.id,
          playerId: wallet.playerId,
          balance: wallet.balance.toJSON(),
          version: wallet.version,
        };
      });
    } catch (err) {
      // duas criações simultâneas passam pelo find; a unique do banco decide quem fica
      const e = err as { code?: string; constraint?: string };
      if (e.code === '23505' && e.constraint === 'wallets_player_currency_unique') {
        throw new WalletAlreadyExistsError(
          `já existe wallet ${initial.currency} para o jogador ${cmd.playerId}`,
        );
      }
      throw err;
    }
  }
}
