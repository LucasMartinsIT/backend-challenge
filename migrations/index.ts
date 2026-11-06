import type { MigrationObject } from '@mikro-orm/core';

// Lista explícita em vez de glob: o Bun não precisa de descoberta via filesystem
// e a ordem fica visível no code review.
export const migrationsList: MigrationObject[] = [];
