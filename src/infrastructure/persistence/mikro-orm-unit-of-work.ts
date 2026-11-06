import type { MikroORM, SqlEntityManager } from '@mikro-orm/postgresql';
import type { Repositories, UnitOfWork, UnitOfWorkOptions } from '../../application/ports';
import { buildRepositories } from './repositories';

// 40P01 deadlock, 40001 serialization failure, 55P03 lock_timeout estourado
const RETRYABLE = new Set(['40P01', '40001', '55P03']);
const MAX_ATTEMPTS = 3;
const LOCK_TIMEOUT_MS = 2000;

export interface UnitOfWorkHooks {
  onLockConflict?: (code: string) => void;
}

export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly hooks: UnitOfWorkHooks = {},
  ) {}

  async run<T>(work: (repos: Repositories) => Promise<T>, options: UnitOfWorkOptions = {}): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        // fork por tentativa: cada transação começa com um EntityManager limpo
        return await this.orm.em.fork().transactional(async (em) => {
          const sql = em as SqlEntityManager;
          await sql.execute(`set local lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
          if (options.idleInTransactionTimeoutMs) {
            await sql.execute(
              `set local idle_in_transaction_session_timeout = '${Math.floor(options.idleInTransactionTimeoutMs)}ms'`,
            );
          }
          return work(buildRepositories(sql));
        });
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (!code || !RETRYABLE.has(code)) throw err;
        this.hooks.onLockConflict?.(code);
        if (attempt >= MAX_ATTEMPTS) throw err;
        await new Promise((r) => setTimeout(r, 20 * attempt + Math.random() * 30));
      }
    }
  }
}
