import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidWalletError,
} from '../errors/domain-errors';
import { Money } from '../money/money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MovementProps {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /** O crédito de abertura (OPENING) é registrado pelo use case, na mesma transação. */
  static open(props: { id: string; playerId: string; initialBalance: Money; at?: Date }): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletError('saldo inicial não pode ser negativo');
    }
    const at = props.at ?? new Date();
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      at,
      at,
    );
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(props: MovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);
    if (this._balance.isLessThan(props.money)) {
      throw new InsufficientFundsError(
        `saldo ${this._balance} menor que o débito de ${props.money}`,
      );
    }
    return this.apply(LedgerDirection.Debit, this._balance.subtract(props.money), props);
  }

  credit(props: MovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);
    return this.apply(LedgerDirection.Credit, this._balance.add(props.money), props);
  }

  // saldo e lançamento nascem juntos: não existe caminho para mudar um sem o outro
  private apply(direction: LedgerDirection, next: Money, props: MovementProps): WalletLedgerEntry {
    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore: this._balance,
      balanceAfter: next,
      createdAt: props.at,
    });
    this._balance = next;
    this._version += 1;
    this._updatedAt = props.at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(
        `wallet ${this.currency} não aceita operação em ${money.currency}`,
      );
    }
  }
}
