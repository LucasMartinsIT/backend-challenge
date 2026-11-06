import { createHash } from 'node:crypto';

// Serialização canônica: chaves ordenadas recursivamente, sem espaços, undefined descartado.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}

export interface HashablePayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string | undefined;
}

// Só campos de negócio entram: header Idempotency-Key e metadados de transporte ficam de fora.
export function hashPayload(p: HashablePayload): string {
  const business = {
    providerId: p.providerId,
    externalTransactionId: p.externalTransactionId,
    playerId: p.playerId,
    walletId: p.walletId,
    roundId: p.roundId,
    gameId: p.gameId,
    kind: p.kind,
    money: { amount: p.money.amount, currency: p.money.currency },
    referenceExternalTransactionId: p.referenceExternalTransactionId,
  };
  return createHash('sha256').update(canonicalJson(business)).digest('hex');
}
