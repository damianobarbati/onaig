const isKubernetes = Boolean(process.env.KUBERNETES_SERVICE_HOST);

export const ENV = {
  DB_URI: isKubernetes ? 'postgresql://user:password@postgres:5432/onaig' : 'postgresql://user:password@localhost:5432/onaig',
  RPC_URI: isKubernetes ? 'http://anvil:8545' : 'http://localhost:8545',
  MASTER_PUBLIC_KEY: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  MASTER_PRIVATE_KEY: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  CONTRACT_ADDRESS: '0x5fbdb2315678afecb367f032d93f642f64180aa3',
} satisfies {
  DB_URI: string;
  RPC_URI: string;
  MASTER_PUBLIC_KEY: `0x${string}`;
  MASTER_PRIVATE_KEY: `0x${string}`;
  CONTRACT_ADDRESS: `0x${string}`;
};

export const ENV_PUBLIC = {
  CONTRACT_ADDRESS: ENV.CONTRACT_ADDRESS,
};
