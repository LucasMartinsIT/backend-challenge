// Falhas que o provedor pode simplesmente repetir: deadlock, serialização, lock timeout,
// banco indisponível, pool esgotado, rede ou DNS fora do ar.
const TRANSIENT_PG_CODES = new Set([
  '40P01', // deadlock
  '40001', // falha de serialização
  '55P03', // lock timeout
  '57P01', // banco derrubado pelo administrador
  '57P03', // banco ainda subindo
  '53300', // conexões demais
  '08000',
  '08003',
  '08006',
  '25P03', // idle_in_transaction_session_timeout
]);

const TRANSIENT_NET_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  // sem resolver o nome do host: acontece, por exemplo, quando o contêiner do banco é parado
  // e o Docker remove o nome da rede
  'EAI_AGAIN',
  'ENOTFOUND',
]);

export function isTransientInfraError(err: unknown): boolean {
  const e = err as { code?: string; name?: string; message?: string };
  if (e.code && (TRANSIENT_PG_CODES.has(e.code) || TRANSIENT_NET_CODES.has(e.code))) return true;
  return /timeout|Connection terminated|connection.*(closed|refused)/i.test(e.message ?? '');
}
