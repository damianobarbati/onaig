import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

export type PersonData = { firstName?: string; lastName?: string; birthDate?: string };
export type DocumentAnalysis = { faceEmbedding: number[]; person: PersonData; warnings?: string[] };
export type DocumentAnalyzer = (imageBase64: string) => Promise<DocumentAnalysis>;
export type FaceDocRecord = { id: string; score: number; person: PersonData };

const THRESHOLD = 0.9;
const MAX_IMAGE_BASE64_LENGTH = 8_000_000;
const app = new Hono();
app.use('*', cors());

let analyzer: DocumentAnalyzer | null = null;
export function setDocumentAnalyzer(next: DocumentAnalyzer | null): void { analyzer = next; }

function parseFaces(value: unknown): number[][] | null {
  if (!Array.isArray(value) || value.length === 0 || !value.every((face) => Array.isArray(face) && face.length > 0 && face.every((part) => typeof part === 'number' && Number.isFinite(part)))) return null;
  return value as number[][];
}
function isImageBase64(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_IMAGE_BASE64_LENGTH && /^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/i.test(value);
}
function cosine(left: number[], right: number[]): number {
  if (left.length !== right.length) return -1;
  let dot = 0, leftNorm = 0, rightNorm = 0;
  for (let i = 0; i < left.length; i += 1) { dot += left[i] * right[i]; leftNorm += left[i] ** 2; rightNorm += right[i] ** 2; }
  const denominator = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  return denominator === 0 ? -1 : dot / denominator;
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

app.post('/enroll', async (c) => {
  let body: { faces?: unknown; documentImageBase64?: unknown };
  try { body = await c.req.json(); } catch { return c.json({ error: 'Request body must be JSON.' }, 400); }
  const faces = parseFaces(body.faces);
  if (!faces) return c.json({ error: 'faces must be a non-empty array of numeric embeddings.' }, 400);
  if (!isImageBase64(body.documentImageBase64)) return c.json({ error: 'documentImageBase64 must be a supported Base64 image.' }, 400);
  if (!analyzer) return c.json({ error: 'Document analyzer is not configured.' }, 503);
  let analysis: DocumentAnalysis;
  try { analysis = await analyzer(body.documentImageBase64); } catch (error) { return c.json({ error: `Document analysis failed: ${errorMessage(error)}` }, 422); }
  if (!Array.isArray(analysis.faceEmbedding) || !analysis.faceEmbedding.every((part) => typeof part === 'number' && Number.isFinite(part))) return c.json({ error: 'Document analyzer returned an invalid face embedding.' }, 422);
  const score = Math.max(...faces.map((face) => cosine(face, analysis.faceEmbedding)));
  if (score < THRESHOLD) return c.json({ error: 'Document face does not match.', matched: false, score, person: analysis.person, warnings: analysis.warnings ?? [] }, 422);
  return c.json({ id: randomUUID(), matched: true, score, person: analysis.person, warnings: analysis.warnings ?? [] }, 201);
});

app.notFound((c) => c.json({ error: 'Not found.' }, 404));
const port = Number(process.env.PORT ?? 3004);
if (process.argv[1] === fileURLToPath(import.meta.url)) { serve({ fetch: app.fetch, port }); console.log(`ONAIG FaceDoc API listening on http://localhost:${port}`); }
export default app;
