import { Migration } from '@mikro-orm/migrations';

// Toda garantia do desafio que dá para expressar no schema está aqui, não no código da aplicação.
export class Migration20260101000000_initial_schema extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id text not null,
        currency char(3) not null,
        balance numeric(20,2) not null,
        version integer not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint wallets_balance_non_negative check (balance >= 0),
        constraint wallets_version_positive check (version >= 1),
        constraint wallets_player_currency_unique unique (player_id, currency)
      )`);

    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id text not null,
        external_transaction_id text not null,
        idempotency_key text not null,
        payload_hash text not null,
        wallet_id uuid not null references wallets (id),
        player_id text not null,
        round_id text not null,
        game_id text not null,
        kind text not null,
        amount numeric(20,2) not null,
        currency char(3) not null,
        reference_external_transaction_id text,
        reference_transaction_id uuid references wager_transactions (id),
        status text not null,
        failure_code text,
        balance_after numeric(20,2),
        attempts integer not null default 0,
        next_attempt_at timestamptz,
        created_at timestamptz not null,
        processed_at timestamptz,
        constraint wager_tx_idempotency_unique unique (idempotency_key),
        constraint wager_tx_provider_external_unique unique (provider_id, external_transaction_id),
        constraint wager_tx_amount_positive check (amount > 0),
        constraint wager_tx_balance_after_non_negative check (balance_after is null or balance_after >= 0),
        constraint wager_tx_kind_valid check (kind in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        constraint wager_tx_status_valid check (status in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        constraint wager_tx_reference_required check (
          kind not in ('REFUND','ROLLBACK') or reference_external_transaction_id is not null
        ),
        constraint wager_tx_failure_code_required check (
          status not in ('REJECTED','FAILED') or failure_code is not null
        ),
        constraint wager_tx_processed_at_required check (
          status <> 'PROCESSED' or processed_at is not null
        ),
        constraint wager_tx_reversal_has_target check (
          not (status = 'PROCESSED' and kind in ('REFUND','ROLLBACK')) or reference_transaction_id is not null
        )
      )`);

    // Cada transação só pode ser revertida uma vez, por REFUND ou por ROLLBACK.
    // É mais estrito que a regra 4 do enunciado: sem isso, BET + REFUND + ROLLBACK
    // devolveria o valor da aposta duas vezes.
    this.addSql(`
      create unique index wager_tx_single_reversal
        on wager_transactions (reference_transaction_id)
        where status = 'PROCESSED' and kind in ('REFUND','ROLLBACK')`);

    this.addSql(`
      create index wager_tx_pending_reference_due
        on wager_transactions (next_attempt_at)
        where status = 'PENDING_REFERENCE'`);

    this.addSql(`create index wager_tx_wallet on wager_transactions (wallet_id)`);

    this.addSql(`
      create table wallet_ledger_entries (
        seq bigserial not null unique,
        id uuid primary key,
        wallet_id uuid not null references wallets (id),
        transaction_id uuid not null references wager_transactions (id),
        direction text not null,
        amount numeric(20,2) not null,
        balance_before numeric(20,2) not null,
        balance_after numeric(20,2) not null,
        created_at timestamptz not null,
        constraint ledger_one_entry_per_wallet_tx unique (wallet_id, transaction_id),
        constraint ledger_direction_valid check (direction in ('DEBIT','CREDIT')),
        constraint ledger_amount_positive check (amount > 0),
        constraint ledger_balances_non_negative check (balance_before >= 0 and balance_after >= 0),
        constraint ledger_arithmetic check (
          (direction = 'CREDIT' and balance_before + amount = balance_after)
          or (direction = 'DEBIT' and balance_before - amount = balance_after)
        )
      )`);

    this.addSql(`create index ledger_wallet_seq on wallet_ledger_entries (wallet_id, seq)`);

    this.addSql(`
      create function forbid_ledger_mutation() returns trigger
      language plpgsql as $$
      begin
        raise exception 'wallet_ledger_entries é imutável (% bloqueado)', tg_op
          using errcode = '55000';
      end
      $$`);
    this.addSql(`
      create trigger ledger_no_update_delete
        before update or delete on wallet_ledger_entries
        for each row execute function forbid_ledger_mutation()`);
    this.addSql(`
      create trigger ledger_no_truncate
        before truncate on wallet_ledger_entries
        for each statement execute function forbid_ledger_mutation()`);

    this.addSql(`
      create table inbox_messages (
        consumer_name text not null,
        message_id text not null,
        payload_hash text not null,
        received_at timestamptz not null,
        processed_at timestamptz,
        primary key (consumer_name, message_id)
      )`);

    this.addSql(`
      create table outbox_messages (
        id uuid primary key,
        aggregate_id text not null,
        event_type text not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0,
        next_attempt_at timestamptz,
        published_at timestamptz,
        constraint outbox_attempts_non_negative check (attempts >= 0)
      )`);

    this.addSql(`
      create index outbox_unpublished
        on outbox_messages (occurred_at)
        where published_at is null`);
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists outbox_messages');
    this.addSql('drop table if exists inbox_messages');
    this.addSql('drop table if exists wallet_ledger_entries');
    this.addSql('drop function if exists forbid_ledger_mutation()');
    this.addSql('drop table if exists wager_transactions');
    this.addSql('drop table if exists wallets');
  }
}
