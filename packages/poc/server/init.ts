import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import knex from 'knex';
import { deployContract } from './deploy.ts';
import { ENV } from './env.ts';
import { hasContract } from './helpers.ts';

const database = knex({ client: 'pg', connection: ENV.DB_URI });

export async function init(): Promise<void> {
  const schemaExists = await database.schema.hasTable('users');

  if (!schemaExists) {
    const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
    await database.raw(schema);
  }

  const contractExists = await hasContract(ENV.RPC_URI, ENV.CONTRACT_ADDRESS);
  if (!contractExists) {
    await deployContract();
  }
}

const isCli = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isCli) await init();
