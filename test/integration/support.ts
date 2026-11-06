import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { buildOrmConfig } from '../../src/infrastructure/mikro-orm/mikro-orm.config';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5433/wagering_test';

export async function createTestOrm(): Promise<MikroORM> {
  return MikroORM.init(buildOrmConfig(TEST_DATABASE_URL));
}

/** Deixa o banco de teste no schema mais recente, partindo do zero. */
export async function resetSchema(orm: MikroORM): Promise<void> {
  const migrator = orm.getMigrator();
  await migrator.down({ to: 0 });
  await migrator.up();
}

export const uuid = () => randomUUID();

export async function sqlError(run: () => Promise<unknown>): Promise<{ code?: string; constraint?: string; message: string }> {
  try {
    await run();
  } catch (err) {
    const e = err as { code?: string; constraint?: string; message: string };
    return { code: e.code, constraint: e.constraint, message: e.message };
  }
  throw new Error('esperava erro do banco, mas a operação passou');
}
