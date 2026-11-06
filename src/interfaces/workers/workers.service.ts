import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { PublishOutbox } from '../../application/publish-outbox';
import { ReprocessPendingReferences } from '../../application/reprocess-pending-references';
import { APP_CONFIG, type AppConfig } from '../../config';
import { PeriodicRunner } from '../../infrastructure/workers/periodic-runner';

@Injectable()
export class WorkersService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private runners: PeriodicRunner[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PublishOutbox) private readonly outbox: PublishOutbox,
    @Inject(ReprocessPendingReferences) private readonly pending: ReprocessPendingReferences,
  ) {}

  onApplicationBootstrap() {
    if (!this.config.ENABLE_WORKERS) return;
    this.runners = [
      new PeriodicRunner('OutboxPublisher', () => this.outbox.runOnce(), this.config.OUTBOX_POLL_MS),
      new PeriodicRunner('PendingReferenceWorker', () => this.pending.runOnce(), this.config.PENDING_POLL_MS),
    ];
    for (const runner of this.runners) runner.start();
  }

  async beforeApplicationShutdown() {
    await Promise.all(this.runners.map((r) => r.stop()));
  }
}
