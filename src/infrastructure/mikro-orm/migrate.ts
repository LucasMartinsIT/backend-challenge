import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../../config';
import { buildOrmConfig } from './mikro-orm.config';

const direction = process.argv[2];
if (direction !== 'up' && direction !== 'down') {
  console.error('uso: bun src/infrastructure/mikro-orm/migrate.ts <up|down>');
  process.exit(1);
}

const orm = await MikroORM.init(buildOrmConfig(loadConfig().DATABASE_URL));
try {
  const migrator = orm.getMigrator();
  const executed = direction === 'up' ? await migrator.up() : await migrator.down();
  console.log(`${direction}: ${executed.map((m) => m.name).join(', ') || 'nada a fazer'}`);
} finally {
  await orm.close();
}
