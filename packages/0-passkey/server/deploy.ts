import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ENV } from './env.ts';

const artifact = JSON.parse(await readFile(new URL('./out/Ledger.sol/Ledger.json', import.meta.url), 'utf8'));

const anvil = defineChain({
  id: 31337,
  name: 'Anvil',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [ENV.RPC_URI] } },
});

const account = privateKeyToAccount(ENV.MASTER_PRIVATE_KEY);
const walletClient = createWalletClient({ chain: anvil, transport: http(ENV.RPC_URI), account });
const publicClient = createPublicClient({ chain: anvil, transport: http(ENV.RPC_URI) });

export async function deployContract(): Promise<`0x${string}` | null> {
  const hash = await walletClient.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, account });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log('Contract:', receipt.contractAddress);
  return receipt.contractAddress ?? null;
}

const isCli = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isCli) await deployContract();
