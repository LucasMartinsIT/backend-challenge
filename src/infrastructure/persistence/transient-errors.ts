// falhas que o provedor pode simplesmente repetir: deadlock, serialização, lock timeout,
// banco indisponível, pool esgotado
const TRANSIENT_PG_CODES = new Set(['40P01', '40001', '55P03', '57P01', '57P03', '53300', '08000', '08003', '08006']);
const TRANSIENT_NET_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE']);

export function isTransientInfraError(err: unknown): boolean {
  const e = err as { code?: string; name?: string; message?: string };
  if (e.code && (TRANSIENT_PG_CODES.has(e.code) || TRANSIENT_NET_CODES.has(e.code))) return true;
  return /timeout|Connection terminated|connection.*(closed|refused)/i.test(e.message ?? '');
}
