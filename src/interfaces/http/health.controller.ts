import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ReadinessChecker } from '../../infrastructure/health/readiness-checker';
import { Public } from './auth.guard';

@Public()
@Controller('health')
export class HealthController {
  constructor(@Inject(ReadinessChecker) private readonly readiness: ReadinessChecker) {}

  // processo vivo: não consulta dependências, senão uma queda do banco derrubaria o pod à toa
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  // pronto para receber tráfego: Postgres e SQS alcançáveis
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const result = await this.readiness.check();
    res.status(result.ready ? 200 : 503);
    return { status: result.ready ? 'ok' : 'unavailable', checks: result.checks };
  }
}
