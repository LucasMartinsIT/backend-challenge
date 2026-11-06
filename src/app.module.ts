import { Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { LoggerModule } from 'nestjs-pino';
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
import { buildHandledLog, pinoHttpOptions } from './infrastructure/observability/logging';
import { Metrics } from './infrastructure/observability/metrics';
import { safeErrorSummary } from './infrastructure/observability/safe-error';
import { SqsEventPublisher } from './infrastructure/sqs/sqs-event-publisher';
import { createSqsClient } from './infrastructure/sqs/sqs-client';
import { MikroOrmUnitOfWork } from './infrastructure/persistence/mikro-orm-unit-of-work';
import { CLOCK, EVENT_PUBLISHER, ID_GENERATOR, OUTBOX_GAUGES, UNIT_OF_WORK } from './tokens';
import { AuthGuard } from './interfaces/http/auth.guard';
import { HttpErrorFilter } from './interfaces/http/error.filter';
import { HealthController } from './interfaces/http/health.controller';
import { MetricsController } from './interfaces/http/metrics.controller';
import { WageringController } from './interfaces/http/wagering.controller';
import { WalletsController } from './interfaces/http/wallets.controller';
import { WagerConsumerService } from './interfaces/sqs/wager-consumer.service';
import { WorkersService } from './interfaces/workers/workers.service';

type Deps = [UnitOfWork, Clock, IdGenerator];
const deps = [UNIT_OF_WORK, CLOCK, ID_GENERATOR];

// Um scrape lê as três gauges da outbox; a mesma consulta atende as três.
function memoizedOutboxStats(uow: UnitOfWork, ttlMs = 1000) {
  let at = 0;
  let cached: ReturnType<typeof read> | undefined;
  const read = () => uow.run((r) => r.outbox.stats(new Date()));
  return () => {
    if (!cached || Date.now() - at > ttlMs) {
      cached = read();
      at = Date.now();
    }
    return cached;
  };
}

@Module({
  imports: [
    LoggerModule.forRootAsync({
      useFactory: () => ({ pinoHttp: pinoHttpOptions(loadConfig()) as never }),
    }),
  ],
  controllers: [HealthController, MetricsController, WalletsController, WageringController],
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadConfig() },
    { provide: Metrics, useFactory: () => new Metrics({ defaultMetrics: true }) },
    {
      provide: MikroORM,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => MikroORM.init(buildOrmConfig(config.DATABASE_URL)),
    },
    {
      provide: UNIT_OF_WORK,
      inject: [MikroORM, Metrics],
      useFactory: (orm: MikroORM, metrics: Metrics) =>
        new MikroOrmUnitOfWork(orm, { onLockConflict: (code) => metrics.lockConflicts.inc({ code }) }),
    },
    {
      provide: OUTBOX_GAUGES,
      inject: [Metrics, UNIT_OF_WORK],
      useFactory: (metrics: Metrics, uow: UnitOfWork) => {
        metrics.bindOutboxGauges(memoizedOutboxStats(uow));
        return true;
      },
    },
    { provide: CLOCK, useValue: systemClock },
    { provide: ID_GENERATOR, useValue: uuidV7Generator },
    {
      provide: SubmitWagerTransaction,
      inject: [...deps, Metrics],
      useFactory: (...[uow, clock, ids, metrics]: [...Deps, Metrics]) => {
        const logger = new Logger('Wagering');
        return new SubmitWagerTransaction({
          uow,
          clock,
          ids,
          observer: {
            handled: (e) => {
              // uma repetição não é uma transação nova: conta à parte
              if (e.idempotentReplay) metrics.idempotentReplays.inc();
              else metrics.transactions.inc({ status: e.status, kind: e.kind });
              metrics.processingSeconds.observe({ kind: e.kind }, e.durationMs / 1000);
              logger.log(buildHandledLog(e));
            },
            inboxDuplicate: () => metrics.inboxDuplicates.inc(),
            failed: (code) => metrics.requestErrors.inc({ code }),
          },
        });
      },
    },
    {
      provide: CreateWallet,
      inject: deps,
      useFactory: (...[uow, clock, ids]: Deps) => new CreateWallet({ uow, clock, ids }),
    },
    {
      provide: WalletQueries,
      inject: [UNIT_OF_WORK, Metrics],
      useFactory: (uow: UnitOfWork, metrics: Metrics) => {
        const logger = new Logger('Reconciliation');
        return new WalletQueries(uow, (info) => {
          metrics.reconciliationMismatches.inc();
          // o valor da diferença fica de fora do log; quem investiga consulta o endpoint
          logger.warn({ msg: 'saldo divergente do ledger', event: 'reconciliation.mismatch', walletId: info.walletId });
        });
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
      inject: [UNIT_OF_WORK, EVENT_PUBLISHER, CLOCK, APP_CONFIG, Metrics],
      useFactory: (uow: UnitOfWork, publisher: EventPublisher, clock: Clock, config: AppConfig, metrics: Metrics) => {
        const logger = new Logger('OutboxPublisher');
        return new PublishOutbox(
          { uow, publisher, clock },
          {
            ...DEFAULT_OUTBOX_OPTIONS,
            batchSize: config.OUTBOX_BATCH_SIZE,
            onPublished: () => metrics.outboxPublished.inc(),
            onPublishFailed: () => metrics.outboxPublishFailures.inc(),
            onAbandoned: (m) => {
              metrics.outboxAbandoned.inc();
              logger.error({
                msg: 'evento abandonado depois de esgotar as tentativas',
                event: 'outbox.abandoned',
                eventId: m.id,
                eventType: m.eventType,
                walletId: m.aggregateId,
                attempts: m.attempts,
              });
            },
          },
        );
      },
    },
    {
      provide: ReprocessPendingReferences,
      inject: [...deps, APP_CONFIG, Metrics],
      useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator, config: AppConfig, metrics: Metrics) => {
        const logger = new Logger('PendingReferenceWorker');
        return new ReprocessPendingReferences(
          {
            uow,
            clock,
            ids,
            onError: (c, err) =>
              logger.error({
                msg: 'falha ao reprocessar transação pendente',
                event: 'pending_reference.error',
                transactionId: c.id,
                walletId: c.walletId,
                error: safeErrorSummary(err),
              }),
            onResolved: (status) => metrics.pendingReferenceResolutions.inc({ status }),
          },
          {
            ...DEFAULT_PENDING_OPTIONS,
            maxAttempts: config.PENDING_MAX_ATTEMPTS,
            baseDelayMs: config.PENDING_BASE_DELAY_MS,
          },
        );
      },
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
