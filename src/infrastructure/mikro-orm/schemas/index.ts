import type { EntitySchema } from '@mikro-orm/core';
import { WagerTransactionSchema } from './wager-transaction.schema';
import { WalletSchema } from './wallet.schema';

export { WagerTransactionSchema, WalletSchema };
export type { WagerTransactionRecord } from './wager-transaction.schema';
export type { WalletRecord } from './wallet.schema';

export const entitySchemas: EntitySchema<any>[] = [WalletSchema, WagerTransactionSchema];
