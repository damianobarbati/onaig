import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { server as webauthn } from '@passwordless-id/webauthn';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import knex from 'knex';
import { P256 } from 'ox';
import { createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ENV, ENV_PUBLIC } from './env.ts';
import { appKeyProofPayload, assertHexPublicKey, credentialForUser, hasContract, hasP256Precompile, jsonBody, parseRelayTransaction } from './helpers.ts';
import { init } from './init.ts';

const app = new Hono();
const database = knex({ client: 'pg', connection: ENV.DB_URI });

await init();

if (!(await hasP256Precompile(ENV.RPC_URI))) throw new Error('P256 precompile not found');
if (!(await hasContract(ENV.RPC_URI, ENV.CONTRACT_ADDRESS))) throw new Error('Ledger contract not found');

let reconciliationInFlight = false;

async function reconcileBlockchain(): Promise<void> {
  if (reconciliationInFlight) return;
  reconciliationInFlight = true;

  try {
    if (await hasContract(ENV.RPC_URI, ENV.CONTRACT_ADDRESS)) return;

    console.warn('Ledger contract not found; redeploying it on Besu.');
    await init();

    if (!(await hasContract(ENV.RPC_URI, ENV.CONTRACT_ADDRESS))) {
      throw new Error('Ledger contract was not deployed at the configured address');
    }
  } catch (error) {
    console.error('Blockchain reconciliation failed:', error);
  } finally {
    reconciliationInFlight = false;
  }
}

setInterval(() => void reconcileBlockchain(), 10_000).unref();

const artifact = JSON.parse(await readFile(new URL('./out/Ledger.sol/Ledger.json', import.meta.url), 'utf8')) as { abi: unknown };
// Development-only wildcard. In production, restrict this to the deployed origin(s).
const isAllowedOrigin = () => true;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

const besu = defineChain({ id: 31337, name: 'Onaig Besu', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [ENV.RPC_URI] } } });
const masterAccount = privateKeyToAccount(ENV.MASTER_PRIVATE_KEY);
const walletClient = createWalletClient({ account: masterAccount, chain: besu, transport: http(ENV.RPC_URI) });

type RegistrationRequest = {
  registration: Parameters<typeof webauthn.verifyRegistration>[0];
  publicKey: string;
  proof: string;
};
type AuthenticationRequest = {
  authentication: Parameters<typeof webauthn.verifyAuthentication>[0];
  publicKey: string;
};

app.use('*', cors({ origin: '*' }));

app.get('/healthcheck', (c) => c.json(true));

app.get('/env', (c) => c.json(ENV_PUBLIC));

app.get('/abi', (c) => c.json(artifact.abi));

app.post('/auth/register/options', async (c) => {
  try {
    const { identifier } = jsonBody<{ identifier?: string }>(await c.req.json());
    const username = identifier?.trim();
    if (!username) return c.json({ error: 'Choose a username.' }, 400);
    if (Buffer.byteLength(username, 'utf8') > 64) return c.json({ error: 'Username must be at most 64 UTF-8 bytes.' }, 400);
    const existing = await database('users').select('id').where('username', username).first();
    if (existing) return c.json({ error: 'This username is already registered.' }, 409);
    const challenge = webauthn.randomChallenge();
    const userHandle = randomUUID();
    const expires_at = new Date(Date.now() + CHALLENGE_TTL_MS);
    await database('webauthn_challenges').insert({ challenge, kind: 'registration', identifier: username, user_handle: userHandle, expires_at });
    return c.json({ challenge, userId: userHandle });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Unable to start registration.' }, 400);
  }
});

app.post('/auth/register/verify', async (c) => {
  try {
    const body = jsonBody<RegistrationRequest>(await c.req.json());
    const pending = await database('webauthn_challenges')
      .select('challenge', 'identifier', 'user_handle')
      .where('kind', 'registration')
      .where('expires_at', '>', database.fn.now())
      .orderBy('created_at', 'desc');
    let verified: Awaited<ReturnType<typeof webauthn.verifyRegistration>> | undefined;
    let pendingRow: { challenge: string; identifier: string; user_handle: string } | undefined;
    let lastError: unknown;
    for (const row of pending) {
      try {
        verified = await webauthn.verifyRegistration(body.registration, { challenge: row.challenge, origin: isAllowedOrigin, userVerified: true });
        pendingRow = row;
        break;
      } catch (error) {
        lastError = error;
        // The response belongs to another pending challenge or is invalid.
      }
    }
    if (!verified || !pendingRow) {
      console.error('Registration verification failed:', lastError);
      return c.json({ error: lastError instanceof Error ? `Registration verification failed: ${lastError.message}` : 'Registration verification failed.' }, 400);
    }

    assertHexPublicKey(body.publicKey);
    const proof = body.proof.replace(/^0x/, '');
    if (!/^[0-9a-f]{128}$/i.test(proof)) return c.json({ error: 'Invalid application key proof.' }, 400);
    const proofValid = P256.verify({
      payload: appKeyProofPayload(body.publicKey),
      publicKey: { prefix: 4, x: `0x${body.publicKey.slice(2, 66)}`, y: `0x${body.publicKey.slice(66)}` },
      signature: { r: `0x${proof.slice(0, 64)}`, s: `0x${proof.slice(64)}` },
      hash: true,
    });
    if (!proofValid) return c.json({ error: 'Application key proof is invalid.' }, 400);

    await database.transaction(async (transaction) => {
      const user = {
        id: pendingRow.user_handle,
        username: pendingRow.identifier,
        passkey_identifier: verified.credential.id,
        passkey_public_key: verified.credential.publicKey,
        public_key: body.publicKey,
      };
      await transaction('users').insert(user);
      await transaction('webauthn_challenges').where('challenge', pendingRow.challenge).del();
    });
    return c.json({ identifier: verified.credential.id, username: pendingRow.identifier, publicKey: body.publicKey }, 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Unable to verify registration.' }, 400);
  }
});

app.post('/auth/login/options', async (c) => {
  try {
    const challenge = webauthn.randomChallenge();
    const expires_at = new Date(Date.now() + CHALLENGE_TTL_MS);
    await database('webauthn_challenges').insert({ challenge, kind: 'authentication', identifier: '', user_handle: randomUUID(), expires_at });
    return c.json({ challenge });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Unable to start authentication.' }, 400);
  }
});

app.post('/auth/login/verify', async (c) => {
  try {
    const body = jsonBody<AuthenticationRequest>(await c.req.json());
    assertHexPublicKey(body.publicKey);
    const user = await database('users')
      .select('id', 'username', 'passkey_identifier', 'passkey_public_key', 'public_key')
      .where('passkey_identifier', body.authentication.id)
      .first();
    if (!user) return c.json({ error: 'Passkey credential not found.' }, 404);
    if (user.public_key !== body.publicKey) return c.json({ error: 'Derived application key does not match.' }, 401);
    const pending = await database('webauthn_challenges')
      .select('challenge')
      .where({ kind: 'authentication', identifier: '' })
      .where('expires_at', '>', database.fn.now())
      .orderBy('created_at', 'desc')
      .first();
    if (!pending) return c.json({ error: 'Authentication challenge expired.' }, 400);
    await webauthn.verifyAuthentication(body.authentication, credentialForUser(user), {
      challenge: pending.challenge,
      origin: isAllowedOrigin,
      userVerified: true,
    });
    await database('webauthn_challenges').where('challenge', pending.challenge).del();
    return c.json({ authenticated: true, identifier: user.passkey_identifier, username: user.username, publicKey: user.public_key });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Unable to verify authentication.' }, 401);
  }
});

app.post('/relay', async (c) => {
  try {
    const { transaction } = jsonBody<{ transaction?: unknown }>(await c.req.json());
    const request = parseRelayTransaction(ENV.CONTRACT_ADDRESS, transaction);
    const hash = await walletClient.sendTransaction({ ...request, account: masterAccount, chain: besu });
    return c.json({ hash });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Unable to relay transaction.' }, 400);
  }
});

app.notFound((c) => c.json({ error: 'Not found.' }, 404));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  serve({ fetch: app.fetch, port: 8080 });
  console.log(`Listening on http://127.0.0.1:8080`);
}

export default app;
