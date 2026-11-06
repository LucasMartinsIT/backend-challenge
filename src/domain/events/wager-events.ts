import type { MoneyProps } from '../money/money';
import type { FailureCode } from '../wagering/failure-code';
import type { WagerTransaction } from '../wagering/wager-transaction';
import type { Wallet } from '../wallet/wallet';
import type { LedgerDirection, WalletLedgerEntry } from '../wallet/wallet-ledger-entry';
import { type EventContext, IntegrationEvent } from './integration-event';

interface TransactionData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  roundId: string;
  kind: string;
  money: MoneyProps;
}

function transactionData(tx: WagerTransaction): TransactionData {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    roundId: tx.roundId,
    kind: tx.kind,
    money: tx.money.toJSON(),
  };
}

export class WagerTransactionProcessed extends IntegrationEvent<TransactionData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({ ...ctx, aggregateId: tx.walletId, data: transactionData(tx) });
  }
}

interface RejectedData extends TransactionData {
  failureCode: FailureCode;
}

export class WagerTransactionRejected extends IntegrationEvent<RejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, failureCode: FailureCode, ctx: EventContext) {
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: tx.walletId,
      data: { ...transactionData(tx), failureCode },
    });
  }
}

export class WagerTransactionPendingReference extends IntegrationEvent<
  TransactionData & { referenceExternalTransactionId: string }
> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext) {
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: tx.walletId,
      data: {
        ...transactionData(tx),
        referenceExternalTransactionId: tx.referenceExternalTransactionId ?? '',
      },
    });
  }
}

interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext) {
    return new WalletBalanceChanged({
      ...ctx,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}
