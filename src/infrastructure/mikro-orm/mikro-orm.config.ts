import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { entitySchemas } from './schemas';
import { migrationsList } from '../../../migrations';

export function buildOrmConfig(clientUrl: string) {
  return defineConfig({
    clientUrl,
    entities: entitySchemas,
    extensions: [Migrator],
    discovery: { warnWhenNoEntities: false },
    migrations: {
      migrationsList,
      tableName: 'mikro_orm_migrations',
      transactional: true,
      allOrNothing: true,
    },
    pool: { min: 2, max: 10 },
    // o domínio é reidratado manualmente; não quero o ORM decidindo flush implícito
    allowGlobalContext: false,
    debug: false,
  });
}
