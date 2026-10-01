import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { startTestServer } from './test-server.ts';

let host: Awaited<ReturnType<typeof startTestServer>>;
beforeAll(async () => {
  host = await startTestServer();
});
afterAll(async () => {
  await host?.server.close();
});

describe('ONAIG app', () => {
  it('opens the registration flow without browser errors', async () => {
    const headless = process.env.HEADLESS !== 'false';
    const browser = await chromium.launch({
      headless,
      ...(headless ? { channel: 'chromium-headless-shell' as const } : {}),
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    });

    const page = await browser.newPage({ permissions: ['camera'] });

    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      const text = message.text();
      if (message.type() === 'error' && !text.startsWith('INFO: Created TensorFlow Lite XNNPACK delegate for CPU.')) {
        errors.push(`console: ${text}`);
      }
    });
    page.on('requestfailed', (request) => {
      errors.push(`requestfailed: ${request.url()} — ${request.failure()?.errorText || 'unknown error'}`);
    });

    try {
      await page.goto(host.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      const register = page.locator('#registerBtn');
      await register.waitFor({ state: 'visible', timeout: 30_000 });
      await register.waitFor({ state: 'attached' });
      await page.waitForFunction(() => !(document.querySelector('#registerBtn') as HTMLButtonElement)?.disabled, null, { timeout: 60_000 });
      await register.click();
      await page.locator('[data-ui="log"]').waitFor({ state: 'attached' });
      await page.waitForFunction(() => document.querySelector('[data-ui="log"]')?.textContent === 'Liveness check started.', null, { timeout: 5_000 });
      await page.locator('[data-ui="challenge"]:not(.hidden)').waitFor({ state: 'visible', timeout: 5_000 });

      if (errors.length > 0) throw new Error(errors.join('\n'));
      console.log('Register flow opened without page, console, or network errors.');
    } finally {
      if (headless) await browser.close();
    }
  }, 120_000);
});
