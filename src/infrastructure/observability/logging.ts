import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WagerHandledEvent } from '../../application/observability';
import type { AppConfig } from '../../config';

const VALID_CORRELATION_ID = /^[\w.:-]{1,128}$/;

/** Usa o id enviado pelo chamador, se for razoável, ou gera um novo. */
export function resolveCorrelationId(incoming: string | string[] | undefined): string {
  const value = Array.isArray(incoming) ? incoming[0] : incoming;
  return value && VALID_CORRELATION_ID.test(value) ? value : Bun.randomUUIDv7();
}

/**
 * Linha de log de uma transação tratada. Só identificadores e resultado: sem valores, sem
 * saldo e sem o corpo da requisição.
 */
export function buildHandledLog(e: WagerHandledEvent) {
  return {
    msg: 'transação tratada',
    event: 'wager.handled',
    correlationId: e.correlationId,
    messageId: e.messageId,
    transactionId: e.transactionId,
    walletId: e.walletId,
    providerId: e.providerId,
    kind: e.kind,
    status: e.status,
    failureCode: e.failureCode,
    idempotentReplay: e.idempotentReplay,
    durationMs: Math.round(e.durationMs * 10) / 10,
  };
}

/** Contexto que os controllers anexam à linha de log da requisição. */
export interface LogContext {
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  kind?: string;
  status?: string;
  failureCode?: string;
}

export function pinoHttpOptions(config: Pick<AppConfig, 'LOG_LEVEL' | 'INSTANCE_ID'>) {
  // O pino-http chama customProps duas vezes por requisição: ao abrir (o resultado vira
  // binding do logger da requisição) e ao terminar (o resultado é mesclado de novo). Devolver
  // correlationId nas duas deixaria a chave duplicada na linha final.
  const opened = new WeakSet<object>();

  return {
    level: config.LOG_LEVEL,
    base: { instance: config.INSTANCE_ID },
    genReqId: (req: IncomingMessage, res: ServerResponse) => {
      const id = resolveCorrelationId(req.headers['x-correlation-id']);
      res.setHeader('x-correlation-id', id);
      return id;
    },
    autoLogging: {
      // sondas e scrapes a cada poucos segundos só fazem barulho
      ignore: (req: IncomingMessage) => req.url?.startsWith('/health') === true || req.url === '/metrics',
    },
    customProps: (req: IncomingMessage, res: ServerResponse) => {
      if (!opened.has(res)) {
        opened.add(res);
        return {};
      }
      return {
        correlationId: (req as IncomingMessage & { id?: string }).id,
        ...((res as ServerResponse & { locals?: { logContext?: LogContext } }).locals?.logContext ?? {}),
      };
    },
    // Só o necessário: sem cabeçalhos (Authorization, cookies) e sem corpo.
    serializers: {
      req: (req: { id?: string; method?: string; url?: string }) => ({
        id: req.id,
        method: req.method,
        url: req.url,
      }),
      res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
    },
    redact: { paths: ['req.headers', 'req.body', 'res.headers'], remove: true },
  };
}
