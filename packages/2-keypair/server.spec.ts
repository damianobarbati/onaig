import { unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const FACES_JSON_PATH = path.join(os.tmpdir(), 'onaig-faces-test.json');

const { default: app } = await import('./server.ts');

const request = (route: string, body: unknown) => app.request(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('ONAIG API', () => {
  beforeAll(async () => {
    await unlink(FACES_JSON_PATH).catch(() => false);
  });

  afterAll(async () => {
    await unlink(FACES_JSON_PATH).catch(() => false);
  });

  describe('enroll', () => {
    it('enrolls the face', async () => {
      const response = await request('/enroll', { embedding: [1, 0, 0] });
      const result = await response.json();
      expect(result).toMatchObject({ id: expect.any(String) });
    });
  });

  describe('auth', async () => {
    beforeAll(async () => {
      await request('/enroll', { embedding: [1, 0, 0] });
    });

    it('authenticates the face', async () => {
      const response = await request('/auth', { face: [1, 0, 0] });
      const result = await response.json();
      expect(result).toMatchObject({ id: expect.any(String), score: 1 });
    });

    it('rejects the face', async () => {
      const response = await request('/auth', { face: [0, 0, 1] });
      const result = await response.json();
      expect(response.status).toBe(404);
      expect(result).toMatchObject({ error: 'Face not recognized.', score: 0 });
    });
  });
});
