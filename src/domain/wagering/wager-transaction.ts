import { InvalidTransactionError, InvalidTransactionStateError } from '../errors/domain-errors';
import type { Money } from '../money/money';
import { LedgerDirection } from '../wallet/wallet-ledger-entry';
import type { FailureCode } from './failure-code';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

const S = WagerTransactionStatus;

// PENDING pode ir para qualquer estado; PENDING_REFERENCE só sai para um terminal
// (ou continua esperando). Terminais não têm saída.
const ALLOWED: Record<WagerTransactionStatus, readonly WagerTransactionStatus[]> = {
  [S.Pending]: [S.PendingReference, S.Processed, S.Rejected, S.Failed],
  [S.PendingReference]: [S.PendingReference, S.Processed, S.Rejected, S.Failed],
  [S.Processed]: [],
  [S.Rejected]: [],
  [S.Failed]: [],
};

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string | undefined;
  failureCode?: FailureCode | undefined;
  processedAt?: Date | undefined;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
  ) {}

  /** Entrada externa (HTTP ou fila). OPENING é interno e não passa por aqui. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidTransactionError('OPENING é interno e não pode ser submetido');
    }
    return WagerTransaction.build(props);
  }

  static createOpening(props: Omit<CreateWagerTransactionProps, 'kind'>): WagerTransaction {
    return WagerTransaction.build({ ...props, kind: WagerTransactionKind.Opening });
  }

  /** Não revalida transições: só reconstrói o que já foi persistido. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
    );
  }

  private static build(props: CreateWagerTransactionProps): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvalidTransactionError('valor da transação precisa ser positivo');
    }
    const needsRef =
      props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
    if (needsRef && !props.referenceExternalTransactionId) {
      throw new InvalidTransactionError(`${props.kind} exige referenceExternalTransactionId`);
    }
    if (props.kind === WagerTransactionKind.Bet && props.referenceExternalTransactionId) {
      throw new InvalidTransactionError('BET não referencia outra transação');
    }
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt,
      S.Pending,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.transitionTo(S.Processed);
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
  }

  markPendingReference(): void {
    this.transitionTo(S.PendingReference);
  }

  reject(code: FailureCode): void {
    this.transitionTo(S.Rejected);
    this._failureCode = code;
  }

  fail(code: FailureCode): void {
    this.transitionTo(S.Failed);
    this._failureCode = code;
  }

  isTerminal(): boolean {
    return ALLOWED[this._status].length === 0;
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** ROLLBACK é o inverso do lançamento da referência, então precisa dela. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) throw new InvalidTransactionError('ROLLBACK precisa da referência');
        const original = reference.ledgerDirectionFor();
        return original === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionError('LOSS não movimenta saldo');
    }
  }

  private transitionTo(next: WagerTransactionStatus): void {
    if (!ALLOWED[this._status].includes(next)) {
      throw new InvalidTransactionStateError(`transição inválida: ${this._status} -> ${next}`);
    }
    this._status = next;
  }
}
