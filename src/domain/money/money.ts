import { CurrencyMismatchError, InvalidMoneyError } from '../errors/domain-errors';

export interface MoneyProps {
  amount: string;
  currency: string;
}

const AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

// Valor guardado em centavos como bigint: nenhuma etapa passa por number/float.
export class Money {
  private constructor(
    private readonly cents: bigint,
    public readonly currency: string,
  ) {}

  /** Entrada externa: só decimal positivo com até 2 casas, sem sinal nem notação científica. */
  static from(props: MoneyProps): Money {
    const { amount, currency } = props;
    if (typeof amount !== 'string' || !AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(`valor inválido: "${String(amount)}"`);
    }
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`moeda inválida: "${String(currency)}"`);
    }
    const [whole, fraction = ''] = amount.split('.') as [string, string?];
    const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
    return new Money(cents, currency);
  }

  /** Reidratação a partir de NUMERIC(20,2) do Postgres, que pode vir negativo em cálculos intermediários. */
  static fromCents(cents: bigint, currency: string): Money {
    if (!CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`moeda inválida: "${currency}"`);
    }
    return new Money(cents, currency);
  }

  static zero(currency: string): Money {
    return Money.fromCents(0n, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents - other.cents, this.currency);
  }

  negate(): Money {
    return new Money(-this.cents, this.currency);
  }

  isZero(): boolean {
    return this.cents === 0n;
  }

  isPositive(): boolean {
    return this.cents > 0n;
  }

  isNegative(): boolean {
    return this.cents < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.cents === other.cents;
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  /** Sempre com 2 casas, ex.: "25.00". */
  toString(): string {
    const negative = this.cents < 0n;
    const abs = negative ? -this.cents : this.cents;
    const whole = abs / 100n;
    const fraction = (abs % 100n).toString().padStart(2, '0');
    return `${negative ? '-' : ''}${whole}.${fraction}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(`moedas diferentes: ${this.currency} e ${other.currency}`);
    }
  }
}
