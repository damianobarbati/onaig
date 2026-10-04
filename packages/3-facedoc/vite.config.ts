import { defineConfig } from 'vite';

export default defineConfig({
  root: './',
  server: { host: '0.0.0.0', port: 3003, allowedHosts: true },
  preview: { host: '0.0.0.0', port: 3003, allowedHosts: true },
});
