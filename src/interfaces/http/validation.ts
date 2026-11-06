import { z } from 'zod';
import { ValidationError } from '../../application/errors';
import { WagerTransactionKind } from '../../domain/wagering/wager-transaction';

// amount precisa chegar como string: número JSON é rejeitado aqui, antes de virar dinheiro
const moneySchema = z.object({ amount: z.string(), currency: z.string() });

const text = (max = 128) => z.string().min(1).max(max);

export const createWalletSchema = z.object({
  playerId: text(),
  initialBalance: moneySchema,
});

export const submitTransactionSchema = z.object({
  providerId: text(),
  externalTransactionId: text(),
  playerId: text(),
  walletId: z.guid(),
  roundId: text(),
  gameId: text(),
  // OPENING é aceito pelo enum de propósito: quem o rejeita é o domínio, com a mesma resposta 400
  kind: z.enum(WagerTransactionKind),
  money: moneySchema,
  referenceExternalTransactionId: text().optional(),
});

export const ledgerQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const uuidParam = z.guid();

export function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const message = result.error.issues
    .map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`)
    .join('; ');
  throw new ValidationError(message);
}
