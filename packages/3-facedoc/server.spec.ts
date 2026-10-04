import { beforeEach, describe, expect, it } from 'vitest';
import app, { setDocumentAnalyzer } from './server.ts';

const image = `data:image/jpeg;base64,${Buffer.from('fixture').toString('base64')}`;
const request = (body: unknown) => app.request('/enroll', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('FaceDoc API', () => {
  beforeEach(() => setDocumentAnalyzer(null));
  it('rejects malformed Base64 images', async () => {
    const response = await request({ faces: [[1, 0, 0]], documentImageBase64: 'not-an-image' });
    expect(response.status).toBe(400);
  });
  it('requires a configured analyzer without persisting data', async () => {
    const response = await request({ faces: [[1, 0, 0]], documentImageBase64: image });
    expect(response.status).toBe(503);
  });
  it('matches the document face and returns OCR data', async () => {
    setDocumentAnalyzer(async () => ({ faceEmbedding: [1, 0, 0], person: { firstName: 'Mario', lastName: 'Rossi', birthDate: '1980-01-01' } }));
    const response = await request({ faces: [[1, 0, 0]], documentImageBase64: image });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ matched: true, score: 1, person: { firstName: 'Mario', lastName: 'Rossi' } });
  });
  it('rejects a different document face', async () => {
    setDocumentAnalyzer(async () => ({ faceEmbedding: [0, 0, 1], person: {} }));
    const response = await request({ faces: [[1, 0, 0]], documentImageBase64: image });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ matched: false, score: 0 });
  });
});
