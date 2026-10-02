import { client as webauthn } from '@passwordless-id/webauthn';
import { P256 } from 'ox';
import { type Abi, createPublicClient, encodeAbiParameters, encodeFunctionData, http, stringToHex, toHex, webSocket } from 'viem';
import { watchContractEvent } from 'viem/actions';

const API_URL = `/api`;

const envResponse = await fetch(`${API_URL}/env`);
if (!envResponse.ok) throw new Error(`Unable to load the environment (${envResponse.status}).`);
const { CONTRACT_ADDRESS } = (await envResponse.json()) as { CONTRACT_ADDRESS: `0x${string}` };
const RP_ID = window.location.hostname;

const abiResponse = await fetch(`${API_URL}/abi`);
if (!abiResponse.ok) throw new Error(`Unable to load the contract ABI (${abiResponse.status}).`);
const ledgerAbi = (await abiResponse.json()) as Abi;

// Keep the RPC behind the Vite dev proxy so the browser never connects to Anvil directly.
const chainClient = createPublicClient({ transport: http('/rpc') });
const wsChainClient = createPublicClient({
  transport: webSocket('/rpc', {
    reconnect: { attempts: Infinity, delay: 1000 },
  }),
});
type AppKey = { privateKey: `0x${string}`; x: `0x${string}`; y: `0x${string}`; encoded: `0x${string}` };
let currentUser: { identifier: string; key: AppKey; registeredOnChain: boolean } | undefined;

const root = document.querySelector<HTMLDivElement>('#root');
if (!root) throw new Error('Missing #root element.');

root.innerHTML = `
  <div class="min-h-screen bg-slate-950 px-4 py-8 text-slate-100 sm:px-8">
    <div class="mx-auto max-w-6xl space-y-6">
      <header class="flex items-center justify-between gap-3">
        <div class="min-w-0"><p class="text-sm font-semibold uppercase tracking-[0.25em] text-cyan-400">ONAIG</p><h1 class="truncate text-3xl font-semibold">Passkey ledger</h1><p class="mt-1 truncate text-slate-400">WebAuthn + PRF + P-256, with direct contract reads.</p></div>
        <button id="status" class="inline-flex max-w-[55%] min-w-0 shrink-0 items-center rounded-full bg-slate-900 px-4 py-2 text-left text-sm text-slate-300" type="button" role="status" aria-live="polite" title=""><span id="status-spinner" class="mr-2 hidden h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true"></span><span id="status-message" class="min-w-0 truncate">Ready</span></button>
      </header>
      <section class="grid gap-4 lg:grid-cols-3">
        <div class="rounded-2xl bg-slate-900 p-5 ring-1 ring-white/10"><h2 class="text-lg font-semibold">Authentication</h2><label class="mt-4 block text-sm text-slate-400">Account name<input id="identifier" class="mt-2 w-full rounded-xl border-0 bg-slate-800 px-3 py-2 text-slate-100 ring-1 ring-white/10 outline-none focus:ring-cyan-400" placeholder="Used only when registering" /><span class="mt-2 block text-xs text-slate-500">Login discovers your passkey automatically on this or another device.</span></label><div class="mt-4 grid grid-cols-2 gap-2"><button id="register" class="rounded-xl bg-cyan-400 px-3 py-2 font-semibold text-slate-950 hover:bg-cyan-300">Register</button><button id="login" class="rounded-xl bg-slate-700 px-3 py-2 font-semibold hover:bg-slate-600">Log in</button></div></div>
        <div class="rounded-2xl bg-slate-900 p-5 ring-1 ring-white/10 lg:col-span-2"><div class="flex items-start justify-between gap-4"><div><h2 class="text-lg font-semibold">Current user</h2><p id="current-user" class="mt-1 text-sm text-slate-400">No authenticated user.</p></div><button id="register-contract" class="hidden rounded-xl bg-emerald-400 px-3 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-300">Register on-chain</button></div><div class="mt-6 grid gap-4 sm:grid-cols-3"><div class="rounded-xl bg-slate-800 p-4"><p class="text-xs uppercase tracking-wide text-slate-400">Balance</p><p id="balance" class="mt-2 text-2xl font-semibold">—</p></div><div class="rounded-xl bg-slate-800 p-4"><p class="text-xs uppercase tracking-wide text-slate-400">Nonce</p><p id="nonce" class="mt-2 text-2xl font-semibold">—</p></div><div class="rounded-xl bg-slate-800 p-4"><p class="text-xs uppercase tracking-wide text-slate-400">Public key</p><p id="public-key" class="mt-2 truncate font-mono text-xs text-slate-300">—</p></div></div></div>
      </section>
      <section class="rounded-2xl bg-slate-900 p-5 ring-1 ring-white/10"><div><h2 class="text-lg font-semibold">Ledger</h2><p class="mt-1 text-sm text-slate-400">Data read directly from the public RPC.</p></div><div class="mt-4 overflow-x-auto"><table class="w-full min-w-[840px] text-left text-sm"><thead class="border-b border-white/10 text-xs uppercase tracking-wide text-slate-500"><tr><th class="px-3 py-3">Public key</th><th class="px-3 py-3">Hash</th><th class="px-3 py-3">Created</th><th class="px-3 py-3">Balance</th><th class="px-3 py-3">Nonce</th><th class="px-3 py-3 text-right">Action</th></tr></thead><tbody id="users" class="divide-y divide-white/5"></tbody></table></div></section>
    </div>
  </div>`;

function $<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing UI element: ${selector}`);
  return element;
}
const setStatus = (message: string, error = false, loading = false) => {
  $('#status-message').textContent = message;
  $('#status').setAttribute('aria-busy', String(loading));
  $('#status').dataset.errorMessage = error ? message : '';
  $('#status').title = error ? 'Click to copy the error' : '';
  $('#status-spinner').classList.toggle('hidden', !loading);
  $('#status').className =
    `inline-flex max-w-[55%] min-w-0 shrink-0 items-center rounded-full px-4 py-2 text-left text-sm ${error ? 'cursor-copy bg-rose-950 text-rose-300' : 'bg-slate-900 text-slate-300'}`;
};
function setButtonBusy(button: HTMLButtonElement, busy: boolean) {
  button.disabled = busy;
  button.setAttribute('aria-busy', String(busy));
  button.classList.toggle('cursor-wait', busy);
  button.classList.toggle('opacity-60', busy);
}
const fromBase64 = (value: string) =>
  Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4)), (char) => char.charCodeAt(0));
const asBytes = (value: unknown): Uint8Array =>
  value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : value instanceof Uint8Array
      ? value
      : typeof value === 'string'
        ? fromBase64(value)
        : (() => {
            throw new Error('The authenticator did not return a PRF result.');
          })();
const keyPart = (value: bigint | `0x${string}`): `0x${string}` =>
  typeof value === 'string' ? (`0x${value.slice(2).padStart(64, '0')}` as `0x${string}`) : toHex(value, { size: 32 });
const appProofPayload = (publicKey: string) => stringToHex(`ONAIG_PASSKEY_PUBLIC_KEY:${publicKey}`);

async function deterministicPrfSalt(): Promise<ArrayBuffer> {
  const context = new TextEncoder().encode(`ONAIG/PRF/v1/${RP_ID}`);
  return crypto.subtle.digest('SHA-256', context);
}

function extractPrfResult(result: unknown): Uint8Array {
  const extensions = result as { clientExtensionResults?: { prf?: { results?: { first?: unknown } } } };
  const first = extensions.clientExtensionResults?.prf?.results?.first;
  if (!first) throw new Error('This passkey does not support the PRF extension.');
  return asBytes(first);
}

async function assertPrfSupport() {
  if (!window.PublicKeyCredential?.getClientCapabilities) return;

  const capabilities = await PublicKeyCredential.getClientCapabilities();
  if (capabilities['extension:prf'] !== true) {
    throw new Error('This browser or passkey provider does not support PRF. Use an authenticator compatible with WebAuthn PRF.');
  }
}

async function deriveApplicationKey(prf: Uint8Array): Promise<AppKey> {
  const privateKey = P256.fromSeed(prf, { as: 'Hex' });
  const publicKey = P256.getPublicKey({ privateKey });
  const x = keyPart(publicKey.x);
  const y = keyPart(publicKey.y);
  return { privateKey, x, y, encoded: `0x${x.slice(2)}${y.slice(2)}` as `0x${string}` };
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, { headers: { 'content-type': 'application/json' }, ...options });
  const body = (await response.json()) as { error?: string } & T;
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status}).`);
  return body;
}

async function relay(data: `0x${string}`) {
  const result = await api<{ hash: `0x${string}` }>('/relay', { method: 'POST', body: JSON.stringify({ transaction: { to: CONTRACT_ADDRESS, data, value: '0' } }) });
  const receipt = await chainClient.waitForTransactionReceipt({ hash: result.hash });
  if (receipt.status !== 'success') throw new Error(`Transaction reverted (${result.hash}).`);
  return result.hash;
}

const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

async function register() {
  await assertPrfSupport();

  const hasPlatformAuthenticator = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  if (!hasPlatformAuthenticator) return window.alert('This device does not have Face ID, Touch ID, or compatible local authentication.');

  const identifier = $<HTMLInputElement>('#identifier').value.trim();
  if (!identifier) throw new Error('Enter a passkey identifier.');
  const options = await api<{ challenge: string; userId: string }>('/auth/register/options', { method: 'POST', body: JSON.stringify({ identifier }) });
  const salt = await deterministicPrfSalt();
  const registration = await webauthn.register({
    challenge: options.challenge,
    user: { id: options.userId, name: identifier, displayName: identifier },
    userVerification: 'required',
    discoverable: 'required',
    attestation: false,
    hints: isMobile ? ['client-device'] : ['hybrid'],
    // hints: ['client-device', 'hybrid'],
    customProperties: {
      // authenticatorSelection: {
      //   authenticatorAttachment: 'platform',
      //   residentKey: 'required',
      //   userVerification: 'required',
      // },
      extensions: { prf: { eval: { first: salt } } },
    },
  });
  const key = await deriveApplicationKey(extractPrfResult(registration));
  const proof = P256.sign({ payload: appProofPayload(key.encoded), privateKey: key.privateKey, hash: true });
  await api('/auth/register/verify', {
    method: 'POST',
    body: JSON.stringify({ registration, publicKey: key.encoded, proof: `${keyPart(proof.r).slice(2)}${keyPart(proof.s).slice(2)}` }),
  });
  currentUser = { identifier: registration.id, key, registeredOnChain: false };
  setStatus('Registration completed');
  await refreshCurrentUser();
  await refreshUsers();
}

async function login() {
  await assertPrfSupport();

  const options = await api<{ challenge: string }>('/auth/login/options', { method: 'POST', body: JSON.stringify({}) });
  const authentication = await webauthn.authenticate({
    challenge: options.challenge,
    allowCredentials: [],
    userVerification: 'required',
    customProperties: { extensions: { prf: { eval: { first: await deterministicPrfSalt() } } } },
  });
  const key = await deriveApplicationKey(extractPrfResult(authentication));
  const result = await api<{ identifier: string; publicKey: string }>('/auth/login/verify', { method: 'POST', body: JSON.stringify({ authentication, publicKey: key.encoded }) });
  currentUser = { identifier: result.identifier, key, registeredOnChain: false };
  setStatus('Authentication completed');
  await refreshCurrentUser();
  await refreshUsers();
}

async function registerOnChain() {
  if (!currentUser) throw new Error('Authenticate first.');
  const button = $<HTMLButtonElement>('#register-contract');
  setButtonBusy(button, true);
  setStatus('Creating user on-chain…', false, true);
  try {
    const encoded = encodeAbiParameters(
      [{ type: 'string' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'bytes32' }],
      ['PASSKEY_REGISTER', CONTRACT_ADDRESS, 31337n, currentUser.key.x, currentUser.key.y],
    );
    const signature = P256.sign({ payload: encoded, privateKey: currentUser.key.privateKey, hash: true });
    await relay(encodeFunctionData({ abi: ledgerAbi, functionName: 'registerUser', args: [currentUser.key.x, currentUser.key.y, keyPart(signature.r), keyPart(signature.s)] }));
    setStatus('User registered on-chain');
    await refreshCurrentUser();
    await refreshUsers();
  } finally {
    setButtonBusy(button, false);
  }
}

async function refreshCurrentUser() {
  if (!currentUser) return;
  const result = await chainClient.readContract({ address: CONTRACT_ADDRESS, abi: ledgerAbi, functionName: 'getUser', args: [currentUser.key.x, currentUser.key.y] });
  const [exists, balance, nonce] = result as readonly [boolean, bigint, bigint];
  currentUser.registeredOnChain = exists;
  $('#current-user').textContent = `${currentUser.identifier} · ${exists ? 'registered on-chain' : 'not registered on-chain yet'}`;
  $('#balance').textContent = exists ? balance.toString() : '—';
  $('#nonce').textContent = exists ? nonce.toString() : '—';
  $('#public-key').textContent = shortPublicKey(currentUser.key.x, currentUser.key.y);
  $('#register-contract').classList.toggle('hidden', exists);
}

function shortPublicKey(x: `0x${string}`, y: `0x${string}`) {
  return `0x${x.slice(2, 6)}....${y.slice(-4)}`;
}

function formatCreationDate(createdAt: bigint) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(Number(createdAt) * 1000);
}

async function refreshUsers() {
  const result = await chainClient.readContract({ address: CONTRACT_ADDRESS, abi: ledgerAbi, functionName: 'getUsers' });
  const [hashes, xs, ys, balances, nonces, createdAts] = result as readonly [`0x${string}`[], `0x${string}`[], `0x${string}`[], bigint[], bigint[], bigint[]];
  const currentKey = currentUser ? `${currentUser.key.x}:${currentUser.key.y}`.toLowerCase() : undefined;
  const users = hashes
    .map((hash, index) => ({
      hash,
      x: xs[index],
      y: ys[index],
      balance: balances[index],
      nonce: nonces[index],
      createdAt: createdAts[index],
      isCurrentUser: currentKey === `${xs[index]}:${ys[index]}`.toLowerCase(),
      index,
    }))
    .sort(
      (left, right) =>
        Number(right.isCurrentUser) - Number(left.isCurrentUser) || (right.createdAt > left.createdAt ? 1 : right.createdAt < left.createdAt ? -1 : left.index - right.index),
    );
  $('#users').innerHTML =
    users
      .map(
        ({ hash, x, y, balance, nonce, createdAt, isCurrentUser }) =>
          `<tr${isCurrentUser ? ' aria-current="true"' : ''} class="${isCurrentUser ? 'bg-cyan-400/10 ring-1 ring-inset ring-cyan-400/40' : ''}"><td class="px-3 py-3 font-mono text-xs text-slate-300"><div class="flex items-center gap-2">${shortPublicKey(x, y)}${isCurrentUser ? '<span class="rounded-full bg-cyan-400/20 px-2 py-0.5 font-sans text-[10px] font-semibold uppercase tracking-wide text-cyan-300">You</span>' : ''}</div></td><td class="px-3 py-3 font-mono text-xs text-slate-400">${hash.slice(0, 10)}…</td><td class="px-3 py-3 text-slate-300">${formatCreationDate(createdAt)}</td><td class="px-3 py-3">${balance}</td><td class="px-3 py-3">${nonce}</td><td class="px-3 py-3 text-right"><button data-recipient-x="${x}" data-recipient-y="${y}" class="send rounded-lg bg-slate-700 px-3 py-1.5 text-xs font-semibold hover:bg-slate-600">Send funds</button></td></tr>`,
      )
      .join('') || '<tr><td colspan="6" class="px-3 py-8 text-center text-slate-500">No registered users.</td></tr>';
}

async function sendFunds(button: HTMLButtonElement) {
  if (!currentUser) throw new Error('Authenticate first.');
  const amountText = window.prompt('Amount to send');
  if (!amountText) return;
  setButtonBusy(button, true);
  setStatus('Sending funds…', false, true);
  try {
    const amount = BigInt(amountText);
    const recipientX = button.dataset.recipientX as `0x${string}`;
    const recipientY = button.dataset.recipientY as `0x${string}`;
    const user = await chainClient.readContract({ address: CONTRACT_ADDRESS, abi: ledgerAbi, functionName: 'getUser', args: [currentUser.key.x, currentUser.key.y] });
    const [, , nonce] = user as readonly [boolean, bigint, bigint];
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
    const encoded = encodeAbiParameters(
      [
        { type: 'string' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
      ],
      ['PASSKEY_TRANSFER', CONTRACT_ADDRESS, 31337n, currentUser.key.x, currentUser.key.y, recipientX, recipientY, amount, nonce, deadline],
    );
    const signature = P256.sign({ payload: encoded, privateKey: currentUser.key.privateKey, hash: true });
    await relay(
      encodeFunctionData({
        abi: ledgerAbi,
        functionName: 'transfer',
        args: [currentUser.key.x, currentUser.key.y, recipientX, recipientY, amount, nonce, deadline, keyPart(signature.r), keyPart(signature.s)],
      }),
    );
    setStatus('Transfer completed');
    await refreshCurrentUser();
    await refreshUsers();
  } finally {
    setButtonBusy(button, false);
  }
}

let refreshInFlight = false;
async function refresh() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
    await Promise.all([refreshUsers(), refreshCurrentUser()]);
  } finally {
    refreshInFlight = false;
  }
}

$('#register').addEventListener('click', () => register().catch((error) => setStatus(error.message, true)));
$('#login').addEventListener('click', () => login().catch((error) => setStatus(error.message, true)));
$('#register-contract').addEventListener('click', () => registerOnChain().catch((error) => setStatus(error.message, true)));
$('#status').addEventListener('click', () => {
  const message = $('#status').dataset.errorMessage;
  const clipboard = navigator.clipboard;
  if (message && clipboard) void clipboard.writeText(message).catch(() => undefined);
});
$('#users').addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>('.send');
  if (target) sendFunds(target).catch((error) => setStatus(error.message, true));
});
refresh().catch((error) => setStatus(error.message, true));

const watchLedgerEvent = (eventName: 'UserRegistered' | 'FundsTransferred') =>
  watchContractEvent(wsChainClient, {
    address: CONTRACT_ADDRESS,
    abi: ledgerAbi,
    eventName,
    onLogs: () => refresh().catch((error) => setStatus(error.message, true)),
    onError: (error) => setStatus(`Blockchain WebSocket error: ${error.message}`, true),
  });

watchLedgerEvent('UserRegistered');
watchLedgerEvent('FundsTransferred');
