import { Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { CreateWallet } from './application/create-wallet';
import { DEFAULT_OUTBOX_OPTIONS, PublishOutbox } from './application/publish-outbox';
import { DEFAULT_PENDING_OPTIONS, ReprocessPendingReferences } from './application/reprocess-pending-references';
import { WalletQueries } from './application/queries';
import { SubmitWagerTransaction } from './application/submit-wager-transaction';
import { type Clock, type IdGenerator, systemClock, uuidV7Generator } from './application/support';
import type { EventPublisher, UnitOfWork } from './application/ports';
import { APP_CONFIG, type AppConfig, loadConfig } from './config';
import { buildOrmConfig } from './infrastructure/mikro-orm/mikro-orm.config';
import { ReadinessChecker } from './infrastructure/health/readiness-checker';
import { SqsEventPublisher } from './infrastructure/sqs/sqs-event-publisher';
import { createSqsClient } from './infrastructure/sqs/sqs-client';
import { MikroOrmUnitOfWork } from './infrastructure/persistence/mikro-orm-unit-of-work';
import { CLOCK, EVENT_PUBLISHER, ID_GENERATOR, UNIT_OF_WORK } from './tokens';
import { AuthGuard } from './interfaces/http/auth.guard';
import { HttpErrorFilter } from './interfaces/http/error.filter';
import { HealthController } from './interfaces/http/health.controller';
import { WageringController } from './interfaces/http/wagering.controller';
import { WalletsController } from './interfaces/http/wallets.controller';
import { WagerConsumerService } from './interfaces/sqs/wager-consumer.service';
import { WorkersService } from './interfaces/workers/workers.service';

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
    {
      provide: ReadinessChecker,
      inject: [MikroORM, APP_CONFIG],
      useFactory: (orm: MikroORM, config: AppConfig) =>
        new ReadinessChecker(orm, createSqsClient(config), [config.WAGER_QUEUE_URL, config.EVENTS_QUEUE_URL]),
    },
    {
      provide: EVENT_PUBLISHER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): EventPublisher =>
        new SqsEventPublisher(createSqsClient(config), config.EVENTS_QUEUE_URL),
    },
    {
      provide: PublishOutbox,
      inject: [UNIT_OF_WORK, EVENT_PUBLISHER, CLOCK, APP_CONFIG],
      useFactory: (uow: UnitOfWork, publisher: EventPublisher, clock: Clock, config: AppConfig) =>
        new PublishOutbox(
          { uow, publisher, clock },
          { ...DEFAULT_OUTBOX_OPTIONS, batchSize: config.OUTBOX_BATCH_SIZE },
        ),
    },
    {
      provide: ReprocessPendingReferences,
      inject: [...deps, APP_CONFIG],
      useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator, config: AppConfig) =>
        new ReprocessPendingReferences(
          {
            uow,
            clock,
            ids,
            onError: (c, err) =>
              new Logger('PendingReferenceWorker').error(
                `transação ${c.id}: ${err instanceof Error ? err.message : String(err)}`,
              ),
          },
          {
            ...DEFAULT_PENDING_OPTIONS,
            maxAttempts: config.PENDING_MAX_ATTEMPTS,
            baseDelayMs: config.PENDING_BASE_DELAY_MS,
          },
        ),
    },
    WagerConsumerService,
    WorkersService,
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
