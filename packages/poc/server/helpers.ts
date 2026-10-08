import { stringToHex } from 'viem';

export async function hasContract(RPC_URI: string, address: `0x${string}`): Promise<boolean> {
  try {
    const response = await fetch(RPC_URI, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [address, 'latest'] }),
    });

    if (!response.ok) return false;
    const body = (await response.json()) as { result?: unknown; error?: unknown };
    return typeof body.result === 'string' && /^0x[0-9a-f]+$/i.test(body.result) && !/^0x0*$/i.test(body.result);
  } catch {
    return false;
  }
}

/*
h=0000000000000000000000000000000000000000000000000000000000000001
r=6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296
s=6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c297
qx=$r
qy=4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5
curl -s http://localhost:8545 -H 'Content-Type: application/json' --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_call\",\"params\":[{\"to\":\"0x0000000000000000000000000000000000000100\",\"data\":\"0x${h}${r}${s}${qx}${qy}\",\"gas\":\"0x186a0\"},\"latest\"]}"
*/
export async function hasP256Precompile(RPC_URI: string) {
  const h = '0000000000000000000000000000000000000000000000000000000000000001';
  const r = '6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296';
  const s = '6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c297';
  const qx = r;
  const qy = '4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5';
  const expected = `0x${'0'.repeat(63)}1`;

  const response = await fetch(RPC_URI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(5000),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to: '0x0000000000000000000000000000000000000100', data: `0x${h}${r}${s}${qx}${qy}`, gas: '0x186a0' }, 'latest'],
    }),
  });

  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(`RPC ${payload.error.code}: ${payload.error.message}`);
  if (payload.result !== expected) throw new Error(`Test P256 fallito: atteso ${expected}, ricevuto ${JSON.stringify(payload.result)}`);
  return true;
}

export function jsonBody<T>(value: unknown): T {
  if (!value || typeof value !== 'object') throw new Error('Request body must be a JSON object.');
  return value as T;
}

export function assertHexPublicKey(value: string): asserts value is `0x${string}` {
  if (!/^0x[0-9a-f]{128}$/i.test(value)) throw new Error('publicKey must contain 64 bytes encoded as hex.');
}

export function appKeyProofPayload(publicKey: string): `0x${string}` {
  return stringToHex(`ONAIG_PASSKEY_PUBLIC_KEY:${publicKey}`);
}

export function credentialForUser(user: { passkey_identifier: string; passkey_public_key: string }) {
  return { id: user.passkey_identifier, publicKey: user.passkey_public_key, algorithm: 'ES256' as const, transports: [] };
}

export function parseRelayTransaction(contract_address: string, value: unknown): { to: `0x${string}`; data: `0x${string}`; value: bigint } {
  if (!value || typeof value !== 'object') throw new Error('Transaction must be an object.');
  const transaction = value as Record<string, unknown>;
  if (transaction.to !== contract_address) throw new Error('Relay only accepts the configured contract.');
  if (typeof transaction.data !== 'string' || !/^0x[0-9a-f]*$/i.test(transaction.data)) throw new Error('Transaction data must be hex.');
  return { to: transaction.to as `0x${string}`, data: transaction.data as `0x${string}`, value: typeof transaction.value === 'string' ? BigInt(transaction.value) : 0n };
}
