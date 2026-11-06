import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CreateWallet } from '../../application/create-wallet';
import { WalletQueries } from '../../application/queries';
import { correlationIdOf, setLogContext } from './correlation';
import { createWalletSchema, ledgerQuerySchema, parse, uuidParam } from './validation';

@Controller('wallets')
export class WalletsController {
  constructor(
    @Inject(CreateWallet) private readonly createWallet: CreateWallet,
    @Inject(WalletQueries) private readonly queries: WalletQueries,
  ) {}

  @Post()
  async create(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const input = parse(createWalletSchema, body);
    const created = await this.createWallet.execute({ ...input, correlationId: correlationIdOf(req, res) });
    res.status(201);
    setLogContext(res, { walletId: created.id });
    return created;
  }

  @Get(':walletId')
  get(@Param('walletId') walletId: string) {
    return this.queries.getWallet(parse(uuidParam, walletId));
  }

  @Get(':walletId/ledger')
  ledger(@Param('walletId') walletId: string, @Query() query: unknown) {
    const { cursor, limit } = parse(ledgerQuerySchema, query);
    return this.queries.getLedger(parse(uuidParam, walletId), cursor, limit);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconcile(@Param('walletId') walletId: string) {
    return this.queries.reconcile(parse(uuidParam, walletId));
  }
}
