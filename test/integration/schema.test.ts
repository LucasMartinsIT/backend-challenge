import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createTestOrm, resetSchema, sqlError, uuid } from './support';

let orm: MikroORM;
const q = (sql: string, params: unknown[] = []): Promise<any[]> => orm.em.fork().execute(sql, params) as Promise<any[]>;
const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0];

beforeAll(async () => {
  orm = await createTestOrm();
  await resetSchema(orm);
});
afterAll(() => orm.close());

async function newWallet(balance = '100.00', currency = 'BRL') {
  const id = uuid();
  await q(
    `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
     values (?, ?, ?, ?, 1, now(), now())`,
    [id, uuid(), currency, balance],
  );
  return id;
}

interface TxOverrides {
  [col: string]: unknown;
}

async function newTx(walletId: string, o: TxOverrides = {}) {
  const row: Record<string, unknown> = {
    id: uuid(),
    provider_id: 'prov',
    external_transaction_id: uuid(),
    idempotency_key: uuid(),
    payload_hash: 'h',
    wallet_id: walletId,
    player_id: 'p',
    round_id: 'r',
    game_id: 'g',
    kind: 'BET',
    amount: '10.00',
    currency: 'BRL',
    status: 'PENDING',
    created_at: new Date(),
    ...o,
  };
  const cols = Object.keys(row);
  await q(
    `insert into wager_transactions (${cols.join(',')}) values (${cols.map(() => '?').join(',')})`,
    Object.values(row),
  );
  return row.id as string;
}

async function newLedger(walletId: string, txId: string, o: TxOverrides = {}) {
  const row: Record<string, unknown> = {
    id: uuid(),
    wallet_id: walletId,
    transaction_id: txId,
    direction: 'DEBIT',
    amount: '10.00',
    balance_before: '100.00',
    balance_after: '90.00',
    created_at: new Date(),
    ...o,
  };
  const cols = Object.keys(row);
  await q(
    `insert into wallet_ledger_entries (${cols.join(',')}) values (${cols.map(() => '?').join(',')})`,
    Object.values(row),
  );
  return row.id as string;
}

describe('migrations', () => {
  test('up -> down -> up é limpo', async () => {
    const migrator = orm.getMigrator();
    await migrator.down({ to: 0 });
    const { n } = await one(
      `select count(*)::int as n from information_schema.tables
        where table_schema = 'public' and table_name in ('wallets','wager_transactions','wallet_ledger_entries','inbox_messages','outbox_messages')`,
    );
    expect(n).toBe(0);
    await migrator.up();
    const { n: after } = await one(
      `select count(*)::int as n from information_schema.tables
        where table_schema = 'public' and table_name in ('wallets','wager_transactions','wallet_ledger_entries','inbox_messages','outbox_messages')`,
    );
    expect(after).toBe(5);
  });
});

describe('wallets', () => {
  test('saldo negativo é bloqueado pelo banco', async () => {
    const id = await newWallet('10.00');
    const err = await sqlError(() => q('update wallets set balance = -0.01 where id = ?', [id]));
    expect(err.code).toBe('23514');
    expect(err.constraint).toBe('wallets_balance_non_negative');
  });

  test('uma wallet por player + moeda', async () => {
    const player = uuid();
    const ins = () =>
      q(
        `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
         values (?, ?, 'BRL', 0, 1, now(), now())`,
        [uuid(), player],
      );
    await ins();
    const err = await sqlError(ins);
    expect(err.code).toBe('23505');
    expect(err.constraint).toBe('wallets_player_currency_unique');
  });

  test('version precisa ser >= 1', async () => {
    const id = await newWallet();
    const err = await sqlError(() => q('update wallets set version = 0 where id = ?', [id]));
    expect(err.constraint).toBe('wallets_version_positive');
  });
});

describe('wager_transactions', () => {
  test('idempotency_key é única', async () => {
    const w = await newWallet();
    const key = uuid();
    await newTx(w, { idempotency_key: key });
    const err = await sqlError(() => newTx(w, { idempotency_key: key }));
    expect(err.constraint).toBe('wager_tx_idempotency_unique');
  });

  test('(provider, external id) é único', async () => {
    const w = await newWallet();
    await newTx(w, { provider_id: 'a', external_transaction_id: 'x' });
    const err = await sqlError(() => newTx(w, { provider_id: 'a', external_transaction_id: 'x' }));
    expect(err.constraint).toBe('wager_tx_provider_external_unique');
    // outro provedor pode reusar o mesmo id externo
    await newTx(w, { provider_id: 'b', external_transaction_id: 'x' });
  });

  test('valor precisa ser positivo', async () => {
    const w = await newWallet();
    expect((await sqlError(() => newTx(w, { amount: '0.00' }))).constraint).toBe('wager_tx_amount_positive');
  });

  test('kind e status inválidos são rejeitados', async () => {
    const w = await newWallet();
    expect((await sqlError(() => newTx(w, { kind: 'TIP' }))).constraint).toBe('wager_tx_kind_valid');
    expect((await sqlError(() => newTx(w, { status: 'DONE' }))).constraint).toBe('wager_tx_status_valid');
  });

  test('REFUND e ROLLBACK exigem referência', async () => {
    const w = await newWallet();
    for (const kind of ['REFUND', 'ROLLBACK']) {
      expect((await sqlError(() => newTx(w, { kind }))).constraint).toBe('wager_tx_reference_required');
    }
  });

  test('REJECTED e FAILED exigem failure_code', async () => {
    const w = await newWallet();
    for (const status of ['REJECTED', 'FAILED']) {
      expect((await sqlError(() => newTx(w, { status }))).constraint).toBe('wager_tx_failure_code_required');
    }
  });

  test('PROCESSED exige processed_at', async () => {
    const w = await newWallet();
    expect((await sqlError(() => newTx(w, { status: 'PROCESSED' }))).constraint).toBe('wager_tx_processed_at_required');
  });

  test('uma transação só é revertida uma vez (REFUND ou ROLLBACK)', async () => {
    const w = await newWallet();
    const bet = await newTx(w, { status: 'PROCESSED', processed_at: new Date() });
    const reversal = (kind: string) =>
      newTx(w, {
        kind,
        status: 'PROCESSED',
        processed_at: new Date(),
        reference_external_transaction_id: 'bet',
        reference_transaction_id: bet,
      });

    await reversal('REFUND');
    for (const kind of ['REFUND', 'ROLLBACK']) {
      expect((await sqlError(() => reversal(kind))).constraint).toBe('wager_tx_single_reversal');
    }
  });

  test('reversões REJECTED não ocupam o slot da referência', async () => {
    const w = await newWallet();
    const bet = await newTx(w, { status: 'PROCESSED', processed_at: new Date() });
    await newTx(w, {
      kind: 'REFUND',
      status: 'REJECTED',
      failure_code: 'REFERENCE_AMOUNT_MISMATCH',
      reference_external_transaction_id: 'bet',
      reference_transaction_id: bet,
    });
    await newTx(w, {
      kind: 'REFUND',
      status: 'PROCESSED',
      processed_at: new Date(),
      reference_external_transaction_id: 'bet',
      reference_transaction_id: bet,
    });
  });

  test('reversão PROCESSED precisa apontar para a referência', async () => {
    const w = await newWallet();
    const err = await sqlError(() =>
      newTx(w, { kind: 'ROLLBACK', status: 'PROCESSED', processed_at: new Date(), reference_external_transaction_id: 'x' }),
    );
    expect(err.constraint).toBe('wager_tx_reversal_has_target');
  });
});

describe('wallet_ledger_entries', () => {
  test('aritmética incoerente é bloqueada', async () => {
    const w = await newWallet();
    const t = await newTx(w);
    const err = await sqlError(() => newLedger(w, t, { balance_after: '80.00' }));
    expect(err.constraint).toBe('ledger_arithmetic');
  });

  test('crédito e débito coerentes passam', async () => {
    const w = await newWallet();
    await newLedger(w, await newTx(w), { direction: 'DEBIT', balance_before: '100.00', balance_after: '90.00' });
    await newLedger(w, await newTx(w), {
      direction: 'CREDIT',
      balance_before: '90.00',
      balance_after: '100.00',
    });
  });

  test('um lançamento por (wallet, transação)', async () => {
    const w = await newWallet();
    const t = await newTx(w);
    await newLedger(w, t);
    expect((await sqlError(() => newLedger(w, t))).constraint).toBe('ledger_one_entry_per_wallet_tx');
  });

  test('saldo antes/depois não pode ser negativo', async () => {
    const w = await newWallet();
    const t = await newTx(w);
    const err = await sqlError(() => newLedger(w, t, { balance_before: '5.00', balance_after: '-5.00' }));
    expect(err.constraint).toBe('ledger_balances_non_negative');
  });

  test('UPDATE, DELETE e TRUNCATE são bloqueados pelo trigger', async () => {
    const w = await newWallet();
    const id = await newLedger(w, await newTx(w));
    for (const stmt of [
      () => q('update wallet_ledger_entries set amount = 1.00 where id = ?', [id]),
      () => q('delete from wallet_ledger_entries where id = ?', [id]),
      () => q('truncate wallet_ledger_entries'),
    ]) {
      const err = await sqlError(stmt);
      expect(err.code).toBe('55000');
      expect(err.message).toContain('imutável');
    }
    const { n } = await one('select count(*)::int as n from wallet_ledger_entries where id = ?', [id]);
    expect(n).toBe(1);
  });
});

describe('inbox e outbox', () => {
  test('inbox deduplica por (consumer, message_id)', async () => {
    const ins = (consumer: string) =>
      q(`insert into inbox_messages (consumer_name, message_id, payload_hash, received_at) values (?, 'm1', 'h', now())`, [
        consumer,
      ]);
    await ins('wager');
    expect((await sqlError(() => ins('wager'))).code).toBe('23505');
    await ins('outro-consumer');
  });
});
