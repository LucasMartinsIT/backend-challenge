import { EntitySchema } from '@mikro-orm/core';

export interface WagerTransactionRecord {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  status: string;
  failureCode: string | null;
  balanceAfter: string | null;
  attempts: number;
  nextAttemptAt: Date | null;
  createdAt: Date;
  processedAt: Date | null;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  name: 'WagerTransactionRecord',
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'string', columnType: 'uuid', primary: true },
    providerId: { type: 'string', fieldName: 'provider_id' },
    externalTransactionId: { type: 'string', fieldName: 'external_transaction_id' },
    idempotencyKey: { type: 'string', fieldName: 'idempotency_key' },
    payloadHash: { type: 'string', fieldName: 'payload_hash' },
    walletId: { type: 'string', columnType: 'uuid', fieldName: 'wallet_id' },
    playerId: { type: 'string', fieldName: 'player_id' },
    roundId: { type: 'string', fieldName: 'round_id' },
    gameId: { type: 'string', fieldName: 'game_id' },
    kind: { type: 'string' },
    amount: { type: 'string', columnType: 'numeric(20,2)' },
    currency: { type: 'string', columnType: 'char(3)' },
    referenceExternalTransactionId: {
      type: 'string',
      fieldName: 'reference_external_transaction_id',
      nullable: true,
    },
    referenceTransactionId: {
      type: 'string',
      columnType: 'uuid',
      fieldName: 'reference_transaction_id',
      nullable: true,
    },
    status: { type: 'string' },
    failureCode: { type: 'string', fieldName: 'failure_code', nullable: true },
    balanceAfter: {
      type: 'string',
      columnType: 'numeric(20,2)',
      fieldName: 'balance_after',
      nullable: true,
    },
    attempts: { type: 'number', columnType: 'integer' },
    nextAttemptAt: {
      type: 'Date',
      columnType: 'timestamptz',
      fieldName: 'next_attempt_at',
      nullable: true,
    },
    createdAt: { type: 'Date', columnType: 'timestamptz', fieldName: 'created_at' },
    processedAt: {
      type: 'Date',
      columnType: 'timestamptz',
      fieldName: 'processed_at',
      nullable: true,
    },
  },
});
