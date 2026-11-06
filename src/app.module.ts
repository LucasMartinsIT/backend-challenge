import { Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { CreateWallet } from './application/create-wallet';
import { WalletQueries } from './application/queries';
import { SubmitWagerTransaction } from './application/submit-wager-transaction';
import { type Clock, type IdGenerator, systemClock, uuidV7Generator } from './application/support';
import type { UnitOfWork } from './application/ports';
import { APP_CONFIG, type AppConfig, loadConfig } from './config';
import { buildOrmConfig } from './infrastructure/mikro-orm/mikro-orm.config';
import { MikroOrmUnitOfWork } from './infrastructure/persistence/mikro-orm-unit-of-work';
import { CLOCK, ID_GENERATOR, UNIT_OF_WORK } from './tokens';
import { AuthGuard } from './interfaces/http/auth.guard';
import { HttpErrorFilter } from './interfaces/http/error.filter';
import { HealthController } from './interfaces/http/health.controller';
import { WageringController } from './interfaces/http/wagering.controller';
import { WalletsController } from './interfaces/http/wallets.controller';
import { WagerConsumerService } from './interfaces/sqs/wager-consumer.service';

type Deps = [UnitOfWork, Clock, IdGenerator];
const deps = [UNIT_OF_WORK, CLOCK, ID_GENERATOR];

@Module({
  controllers: [HealthController, WalletsController, WageringController],
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadConfig() },
    {
      provide: MikroORM,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => MikroORM.init(buildOrmConfig(config.DATABASE_URL)),
    },
    { provide: UNIT_OF_WORK, inject: [MikroORM], useFactory: (orm: MikroORM) => new MikroOrmUnitOfWork(orm) },
    { provide: CLOCK, useValue: systemClock },
    { provide: ID_GENERATOR, useValue: uuidV7Generator },
    {
      provide: SubmitWagerTransaction,
      inject: deps,
      useFactory: (...[uow, clock, ids]: Deps) => new SubmitWagerTransaction({ uow, clock, ids }),
    },
    {
      provide: CreateWallet,
      inject: deps,
      useFactory: (...[uow, clock, ids]: Deps) => new CreateWallet({ uow, clock, ids }),
    },
    {
      provide: WalletQueries,
      inject: [UNIT_OF_WORK],
      useFactory: (uow: UnitOfWork) => {
        const logger = new Logger('Reconciliation');
        return new WalletQueries(uow, (info) =>
          logger.warn(`divergência na wallet ${info.walletId}: diferença ${info.difference}`),
        );
      },
    },
    WagerConsumerService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: HttpErrorFilter },
  ],
  exports: [MikroORM, APP_CONFIG],
})
export class AppModule implements OnApplicationShutdown {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async onApplicationShutdown() {
    await this.orm.close();
  }
}
