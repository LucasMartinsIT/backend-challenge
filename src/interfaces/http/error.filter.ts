import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { ApplicationError } from '../../application/errors';
import { DomainError } from '../../domain/errors/domain-errors';

const STATUS_BY_CODE: Record<string, number> = {
  VALIDATION_ERROR: 400,
  INVALID_MONEY: 400,
  INVALID_TRANSACTION: 400,
  INVALID_WALLET: 400,
  INVALID_CURSOR: 400,
  MISSING_IDEMPOTENCY_KEY: 400,
  WALLET_NOT_FOUND: 404,
  TRANSACTION_NOT_FOUND: 404,
  IDEMPOTENCY_CONFLICT: 409,
  EXTERNAL_TRANSACTION_CONFLICT: 409,
  INBOX_PAYLOAD_MISMATCH: 409,
  WALLET_ALREADY_EXISTS: 409,
};

// falhas que o provedor pode simplesmente repetir: deadlock, serialização, lock timeout,
// banco indisponível, pool esgotado
const TRANSIENT_PG_CODES = new Set(['40P01', '40001', '55P03', '57P01', '57P03', '53300', '08000', '08003', '08006']);
const TRANSIENT_NET_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE']);

export function isTransientInfraError(err: unknown): boolean {
  const e = err as { code?: string; name?: string; message?: string };
  if (e.code && (TRANSIENT_PG_CODES.has(e.code) || TRANSIENT_NET_CODES.has(e.code))) return true;
  return /timeout|Connection terminated|connection.*(closed|refused)/i.test(e.message ?? '');
}

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpErrorFilter');

  catch(err: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();

    if (err instanceof ApplicationError || err instanceof DomainError) {
      const status = STATUS_BY_CODE[err.code] ?? 400;
      return res.status(status).json({ error: { code: err.code, message: err.message } });
    }

    if (err instanceof HttpException) {
      const status = err.getStatus();
      return res.status(status).json({ error: { code: `HTTP_${status}`, message: err.message } });
    }

    if (isTransientInfraError(err)) {
      this.logger.warn(`falha transitória de infraestrutura: ${(err as Error).message}`);
      return res
        .status(503)
        .set('Retry-After', '1')
        .json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'indisponível no momento, tente novamente' } });
    }

    this.logger.error(err instanceof Error ? err.stack : String(err));
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'erro interno' } });
  }
}
