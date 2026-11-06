import { Module, type OnApplicationShutdown } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { APP_CONFIG, loadConfig, type AppConfig } from './config';
import { buildOrmConfig } from './infrastructure/mikro-orm/mikro-orm.config';
import { HealthController } from './interfaces/http/health.controller';

@Module({
  controllers: [HealthController],
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadConfig() },
    {
      provide: MikroORM,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => MikroORM.init(buildOrmConfig(config.DATABASE_URL)),
    },
  ],
  exports: [MikroORM, APP_CONFIG],
})
export class AppModule implements OnApplicationShutdown {
  constructor(private readonly orm: MikroORM) {}

  async onApplicationShutdown() {
    await this.orm.close();
  }
}
