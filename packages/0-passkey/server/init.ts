import { readFile } from 'node:fs/promises';
import type { Knex } from 'knex';

export async function initDatabase(database: Knex): Promise<void> {
  if (await database.schema.hasTable('users')) return;
  const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  await database.raw(schema);
}
