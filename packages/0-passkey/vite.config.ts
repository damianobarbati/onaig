import { defineConfig } from 'vite';

const proxy = {
  '/api': {
    target: 'http://localhost:8080',
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/api/, ''),
  },
  '/rpc': {
    target: 'http://127.0.0.1:8545',
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
