import { defineConfig } from 'vite';

const isKubernetes = Boolean(process.env.KUBERNETES_SERVICE_HOST);

const proxy = {
  '/api': {
    target: isKubernetes ? 'http://api:80' : 'http://127.0.0.1:8080',
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/api/, ''),
  },
  '/rpc': {
    target: isKubernetes ? 'http://anvil:8545' : 'http://127.0.0.1:8545',
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/rpc/, '') || '/',
    ws: true,
  },
};

export default defineConfig({
  root: './client',
  server: {
    host: '0.0.0.0',
    port: 3000,
    allowedHosts: true,
    proxy,
  },
  preview: {
    host: '0.0.0.0',
    port: 3000,
    allowedHosts: true,
    proxy,
  },
});
