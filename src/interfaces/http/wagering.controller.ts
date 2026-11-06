import { Body, Controller, Get, Headers, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApplicationError } from '../../application/errors';
import { WalletQueries } from '../../application/queries';
import { SubmitWagerTransaction, type SubmitWagerResult } from '../../application/submit-wager-transaction';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction';
import { correlationIdOf, setLogContext } from './correlation';
import { parse, submitTransactionSchema, uuidParam } from './validation';

class MissingIdempotencyKeyError extends ApplicationError {
  readonly code = 'MISSING_IDEMPOTENCY_KEY';
}

// Um código por situação, o mesmo em todos os endpoints:
//   201 aplicada agora · 200 replay · 202 aceita, aguardando referência
//   422 rejeitada por regra de negócio · 409 conflito de idempotência
//   400 payload inválido · 503 falha transitória (reenviar)
function statusFor(result: SubmitWagerResult): number {
  switch (result.status) {
    case WagerTransactionStatus.Processed:
      return result.idempotentReplay ? 200 : 201;
    case WagerTransactionStatus.PendingReference:
      return 202;
    case WagerTransactionStatus.Rejected:
    case WagerTransactionStatus.Failed:
      // FAILED é terminal e auditável: reenviar não muda nada, então não pode parecer um 500
      return 422;
    default:
      return 500;
  }
}

@Controller()
export class WageringController {
  constructor(
    @Inject(SubmitWagerTransaction) private readonly submit: SubmitWagerTransaction,
    @Inject(WalletQueries) private readonly queries: WalletQueries,
  ) {}

  @Post('wagering/transactions')
  async submitTransaction(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!idempotencyKey || idempotencyKey.length > 255) {
      throw new MissingIdempotencyKeyError('header Idempotency-Key é obrigatório (até 255 caracteres)');
    }
    const input = parse(submitTransactionSchema, body);
    const result = await this.submit.execute({
      ...input,
      idempotencyKey,
      correlationId: correlationIdOf(req, res),
    });

    res.status(statusFor(result));
    setLogContext(res, {
      transactionId: result.transactionId,
      walletId: input.walletId,
      providerId: input.providerId,
      kind: input.kind,
      status: result.status,
      failureCode: result.failureCode,
    });
    const terminalFailure =
      result.status === WagerTransactionStatus.Rejected || result.status === WagerTransactionStatus.Failed;
    if (terminalFailure && result.failureCode) {
      return { ...result, error: { code: result.failureCode, message: 'transação rejeitada por regra de negócio' } };
    }
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  byId(@Param('transactionId') transactionId: string) {
    return this.queries.getTransactionById(parse(uuidParam, transactionId));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  byExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return this.queries.getTransactionByExternalId(providerId, externalTransactionId);
  }
}
