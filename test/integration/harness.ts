import type { MikroORM } from '@mikro-orm/postgresql';
import { CreateWallet } from '../../src/application/create-wallet';
import { WalletQueries } from '../../src/application/queries';
import {
  SubmitWagerTransaction,
  type SubmitWagerCommand,
} from '../../src/application/submit-wager-transaction';
import { systemClock, uuidV7Generator } from '../../src/application/support';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';

export function buildHarness(orm: MikroORM) {
  const uow = new MikroOrmUnitOfWork(orm);
  const deps = { uow, clock: systemClock, ids: uuidV7Generator };
  const submit = new SubmitWagerTransaction(deps);
  const createWallet = new CreateWallet(deps);
  const queries = new WalletQueries(uow);

  const raw = <T = any>(sql: string, params: unknown[] = []) =>
    orm.em.fork().execute(sql, params) as Promise<T[]>;

  async function wallet(balance = '100.00', playerId = Bun.randomUUIDv7()) {
    const w = await createWallet.execute({
      playerId,
      initialBalance: { amount: balance, currency: 'BRL' },
      correlationId: 'test',
    });
    return { walletId: w.id, playerId };
  }

  let counter = 0;
  /** Monta um comando válido; `over` sobrescreve qualquer campo. */
  function command(
    w: { walletId: string; playerId: string },
    over: Partial<SubmitWagerCommand> & { ext?: string } = {},
  ): SubmitWagerCommand {
    const ext = over.ext ?? `ext-${Bun.randomUUIDv7()}-${counter++}`;
    return {
      idempotencyKey: `prov:${ext}`,
      providerId: 'prov',
      externalTransactionId: ext,
      playerId: w.playerId,
      walletId: w.walletId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: { amount: '10.00', currency: 'BRL' },
      correlationId: 'test',
      ...over,
    };
  }

  /** Invariante central: o saldo gravado tem de ser igual ao saldo reconstruído pelo ledger. */
  async function ledgerMatchesBalance(walletId: string) {
    const rec = await queries.reconcile(walletId);
    return rec;
  }

  const events = (walletId: string, type?: string) =>
    raw<{ event_type: string }>(
      `select event_type from outbox_messages where aggregate_id = ? ${type ? 'and event_type = ?' : ''} order by occurred_at`,
      type ? [walletId, type] : [walletId],
    );

  const ledgerCount = async (walletId: string) =>
    (await raw<{ n: number }>('select count(*)::int as n from wallet_ledger_entries where wallet_id = ?', [walletId]))[0]!.n;

  return { uow, submit, createWallet, queries, raw, wallet, command, ledgerMatchesBalance, events, ledgerCount };
}

export type Harness = ReturnType<typeof buildHarness>;
