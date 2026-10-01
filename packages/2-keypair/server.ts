import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

type Face = number[];
type FaceRecord = { id: string; face: Face; createdAt: string };

const storePath = path.join(os.tmpdir(), 'onaig-faces.json');
const app = new Hono();

app.use('*', cors());

function isFace(value: unknown): value is Face {
  return Array.isArray(value) && value.length > 0 && value.every((component) => typeof component === 'number' && Number.isFinite(component));
}

function extractFaces(body: unknown): Face[] {
  if (isFace(body)) return [body];
  if (!body || typeof body !== 'object') return [];

  const payload = body as Record<string, unknown>;
  const value = payload.faces ?? payload.face ?? payload.embedding ?? payload.vector;
  if (isFace(value)) return [value];
  if (Array.isArray(value) && value.every(isFace)) return value;
  return [];
}

function cosineSimilarity(left: Face, right: Face): number {
  if (left.length !== right.length) return -1;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  const denominator = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  return denominator === 0 ? -1 : dot / denominator;
}

async function readFaces(): Promise<FaceRecord[]> {
  try {
    const records: unknown = JSON.parse(await readFile(storePath, 'utf8'));
    if (!Array.isArray(records)) return [];
    return records.filter(
      (record): record is FaceRecord => !!record && typeof record === 'object' && typeof (record as FaceRecord).id === 'string' && isFace((record as FaceRecord).face),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function writeFaces(records: FaceRecord[]): Promise<void> {
  await mkdir(path.dirname(storePath), { recursive: true });
  const temporaryPath = `${storePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, storePath);
}

async function requestFaces(c: Context): Promise<Face[]> {
  try {
    return extractFaces(await c.req.json());
  } catch {
    return [];
  }
}

app.post('/enroll', async (c) => {
  const faces = await requestFaces(c);
  if (faces.length === 0) return c.json({ error: 'Request must contain a non-empty numeric face embedding.' }, 400);

  const records = await readFaces();
  const createdAt = new Date().toISOString();
  const enrolled = faces.map((face) => ({ id: randomUUID(), face, createdAt }));
  await writeFaces([...records, ...enrolled]);
  return c.json(enrolled.length === 1 ? { id: enrolled[0].id } : { ids: enrolled.map((record) => record.id) }, 201);
});

const authenticate = async (c: Context) => {
  const [face] = await requestFaces(c);
  if (!face) return c.json({ error: 'Request must contain a non-empty numeric face embedding.' }, 400);

  const records = await readFaces();
  let bestMatch: { id: string; score: number } | undefined;
  for (const record of records) {
    const score = cosineSimilarity(face, record.face);
    if (!bestMatch || score > bestMatch.score) bestMatch = { id: record.id, score };
  }
  if (!bestMatch || bestMatch.score < 0.9) return c.json({ error: 'Face not recognized.', score: bestMatch?.score }, 404);
  return c.json({ id: bestMatch.id, score: bestMatch.score });
};

app.post('/auth', authenticate);

app.notFound((c) => c.json({ error: 'Not found.' }, 404));

const port = Number(process.env.PORT ?? 3001);
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  serve({ fetch: app.fetch, port });
  console.log(`ONAIG API listening on http://localhost:${port}`);
}

export default app;
