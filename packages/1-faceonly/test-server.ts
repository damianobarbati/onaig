import { createServer, type ViteDevServer } from 'vite';

export async function startTestServer(): Promise<{ server: ViteDevServer; url: string }> {
  const server = await createServer({ configFile: new URL('./vite.config.ts', import.meta.url).pathname, root: new URL('.', import.meta.url).pathname, server: { open: false } });
  await server.listen();
  const url = server.resolvedUrls?.local[0];
  if (!url) {
    await server.close();
    throw new Error('Test server has no local URL.');
  }
  return { server, url };
}
