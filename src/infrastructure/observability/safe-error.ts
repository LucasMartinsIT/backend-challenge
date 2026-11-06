const SQLSTATE = /^[0-9A-Z]{5}$/;

/**
 * Resume um erro para log sem vazar dados. Mensagens de erro de banco costumam trazer o SQL
 * com os valores dos parâmetros (inclusive montantes), então para elas só saem nome, código
 * SQLSTATE e constraint. Para os demais erros a mensagem é segura.
 */
export function safeErrorSummary(err: unknown): string {
  if (!(err instanceof Error)) return String(err).slice(0, 120);
  const e = err as Error & { code?: unknown; constraint?: unknown };
  const code = typeof e.code === 'string' ? e.code : undefined;
  const fromDatabase = e.name.endsWith('Exception') || (code !== undefined && SQLSTATE.test(code));

  const parts = [e.name];
  if (code) parts.push(`code=${code}`);
  if (typeof e.constraint === 'string') parts.push(`constraint=${e.constraint}`);
  if (!fromDatabase) parts.push(e.message.slice(0, 200));
  return parts.join(' ');
}
