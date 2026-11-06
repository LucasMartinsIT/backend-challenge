import type { Request, Response } from 'express';
import type { LogContext } from '../../infrastructure/observability/logging';
import { resolveCorrelationId } from '../../infrastructure/observability/logging';

/**
 * O id é decidido uma vez, pelo logger HTTP, ao entrar a requisição (req.id). Aqui só o lemos
 * e, se o logger não estiver presente, caímos na mesma regra.
 */
export function correlationIdOf(req: Request, res: Response): string {
  const fromLogger = (req as Request & { id?: unknown }).id;
  const id = typeof fromLogger === 'string' ? fromLogger : resolveCorrelationId(req.header('x-correlation-id'));
  res.setHeader('x-correlation-id', id);
  return id;
}

/** Campos que entram na linha de log da requisição quando ela termina. */
export function setLogContext(res: Response, context: LogContext): void {
  res.locals.logContext = { ...(res.locals.logContext as LogContext | undefined), ...context };
}
