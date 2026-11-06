import type { MigrationObject } from '@mikro-orm/core';
import { Migration20260101000000_initial_schema } from './Migration20260101000000_initial_schema';
import { Migration20260102000000_outbox_dead_letter } from './Migration20260102000000_outbox_dead_letter';

// Lista explícita em vez de glob: o Bun não precisa de descoberta via filesystem
// e a ordem fica visível no code review.
export const migrationsList: MigrationObject[] = [
  { name: 'Migration20260101000000_initial_schema', class: Migration20260101000000_initial_schema },
  { name: 'Migration20260102000000_outbox_dead_letter', class: Migration20260102000000_outbox_dead_letter },
];
