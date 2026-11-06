import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { ApplicationError } from '../../application/errors';
import { DomainError } from '../../domain/errors/domain-errors';
import { safeErrorSummary } from '../../infrastructure/observability/safe-error';
import { isTransientInfraError } from '../../infrastructure/persistence/transient-errors';

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
      this.logger.warn({ msg: 'falha transitória de infraestrutura', event: 'http.transient_error', error: safeErrorSummary(err) });
      return res
        .status(503)
        .set('Retry-After', '1')
        .json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'indisponível no momento, tente novamente' } });
    }

    // não loga a mensagem crua: erros de banco trazem o SQL com os valores
    this.logger.error({ msg: 'erro inesperado', event: 'http.unexpected_error', error: safeErrorSummary(err) });
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'erro interno' } });
  }
}
