import { describe, expect, it, vi } from 'vitest';

vi.mock('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/+esm', () => ({ FaceLandmarker: {}, FilesetResolver: {} }));
vi.mock('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/+esm', () => ({}));

import {
  averageVector,
  createHttpAuthProvider,
  createLocalAuthProvider,
  faceDiagnostics,
  faceMask,
  normalizeFacePixels,
  type Point,
  selectAuthResult,
  solveSimilarity,
  type XY,
} from './onaig.ts';

function required<T>(value: T | null): T {
  expect(value).not.toBeNull();
  if (value === null) throw new Error('Expected a valid preprocessing result.');
  return value;
}

describe('face preprocessing', () => {
  it('undoes translation, distance and rotation without shearing the face', () => {
    const target: XY[] = [
      [38, 52],
      [74, 52],
      [56, 72],
      [42, 92],
      [71, 92],
    ];
    for (const angle of [-0.3, 0, 0.3])
      for (const scale of [0.5, 1, 2]) {
        const source: XY[] = target.map(([x, y]) => [scale * (x * Math.cos(angle) - y * Math.sin(angle)) + 180, scale * (x * Math.sin(angle) + y * Math.cos(angle)) + 70]);
        const a = required(solveSimilarity(source, target));
        source.forEach(([x, y], i) => {
          expect(a[0] * x + a[1] * y + a[2]).toBeCloseTo(target[i][0], 6);
          expect(a[3] * x + a[4] * y + a[5]).toBeCloseTo(target[i][1], 6);
        });
      }
    expect(
      solveSimilarity(
        [
          [1, 1],
          [1, 1],
        ],
        [
          [2, 2],
          [3, 3],
        ],
      ),
    ).toBeNull();
    expect(
      solveSimilarity(
        [
          [NaN, 1],
          [2, 2],
        ],
        [
          [2, 2],
          [3, 3],
        ],
      ),
    ).toBeNull();
  });

  it('measures the same pixel geometry consistently across camera aspect ratios', () => {
    const diagnostics = (width: number, height: number) => {
      const points: Point[] = new Array(468).fill(null).map(() => ({ x: 0.5, y: 0.5 }));
      points[33] = { x: 100 / width, y: 100 / height };
      points[263] = { x: 160 / width, y: 120 / height };
      points[1] = { x: 130 / width, y: 145 / height };
      return faceDiagnostics(points, width, height);
    };
    for (const key of ['yaw', 'pitch', 'roll'] as const) expect(diagnostics(640, 480)[key]).toBeCloseTo(diagnostics(640, 360)[key], 10);
    expect(diagnostics(640, 480).roll).toBeCloseTo(18.43495);
  });

  const weights = required(
    faceMask([
      [20, 10],
      [92, 10],
      [92, 105],
      [20, 105],
    ]),
  );
  const image = (background: number[], exposure = 1) => {
    const pixels = new Uint8ClampedArray(112 * 112 * 4);
    for (let i = 0; i < weights.length; i++) {
      const l = 65 + (i % 112) * 0.8;
      const color = weights[i] ? [l, l * 0.85, l * 0.7].map((v) => v * exposure) : background;
      pixels.set([...color, 255], i * 4);
    }
    return pixels;
  };

  it('excludes background colors from both statistics and normalized output', () => {
    expect(normalizeFacePixels(image([255, 0, 0]), weights)).toEqual(normalizeFacePixels(image([0, 0, 255]), weights));
    expect(weights[0]).toBe(0);
    expect(weights[56 * 112 + 56]).toBe(1);
    expect(
      faceMask([
        [1, 1],
        [1, 1],
        [1, 1],
      ]),
    ).toBeNull();
  });

  it('keeps the feather inside the contour and clips polygons to the crop', () => {
    const polygon: XY[] = [
      [20, 10],
      [92, 10],
      [92, 105],
      [20, 105],
    ];
    const forward = required(faceMask(polygon));
    expect(required(faceMask([...polygon].reverse()))).toEqual(forward);
    expect(forward[56 * 112 + 19]).toBe(0);
    expect(forward[56 * 112 + 20]).toBeCloseTo(0.125);
    expect(forward[56 * 112 + 24]).toBe(1);
    expect(forward[56 * 112 + 92]).toBe(0);
    expect(
      required(
        faceMask([
          [-20, -20],
          [132, -20],
          [132, 132],
          [-20, 132],
        ]),
      ).every((w) => w === 1),
    ).toBe(true);
    expect(
      required(
        faceMask([
          [120, 10],
          [160, 10],
          [160, 105],
          [120, 105],
        ]),
      ).every((w) => w === 0),
    ).toBe(true);
    expect(
      faceMask([
        [NaN, 10],
        [92, 10],
        [92, 105],
      ]),
    ).toBeNull();
  });

  it('reduces exposure differences and retains RGB ratios in the face interior', () => {
    const bright = required(normalizeFacePixels(image([0, 0, 0], 1.2), weights));
    const dark = required(normalizeFacePixels(image([255, 255, 255], 0.8), weights));
    let error = 0,
      count = 0;
    for (let i = 0; i < weights.length; i++)
      if (weights[i] === 1) {
        for (let c = 0; c < 3; c++) {
          error += Math.abs(bright[i * 4 + c] - dark[i * 4 + c]);
          count++;
        }
      }
    expect(error / count).toBeLessThan(8);
    const j = (56 * 112 + 56) * 4;
    expect(bright[j + 1] / bright[j]).toBeCloseTo(0.85, 1);
    const gray = required(normalizeFacePixels(image([0, 0, 0]), weights, true));
    expect(gray[j]).toBe(gray[j + 1]);
    expect(gray[j]).toBe(gray[j + 2]);
  });

  it('normalizes moderate underexposure without changing the grayscale face detail', () => {
    const reference = required(normalizeFacePixels(image([0, 0, 0]), weights, true));
    const dimmed = required(normalizeFacePixels(image([255, 255, 255], 0.65), weights, true));
    let error = 0,
      count = 0;
    for (let i = 0; i < weights.length; i++)
      if (weights[i] === 1) {
        error += Math.abs(reference[i * 4] - dimmed[i * 4]);
        count++;
      }
    expect(error / count).toBeLessThan(3);
  });

  it('rejects lost exposure and incomplete crops instead of inventing face detail', () => {
    for (const level of [0, 255]) {
      const pixels = new Uint8ClampedArray(112 * 112 * 4).fill(level);
      for (let i = 0; i < weights.length; i++) pixels[i * 4 + 3] = 255;
      expect(normalizeFacePixels(pixels, weights)).toBeNull();
    }
    const pixels = image([0, 0, 0]);
    pixels[(56 * 112 + 56) * 4 + 3] = 0;
    expect(normalizeFacePixels(pixels, weights)).toBeNull();
  });
});

describe('face authentication', () => {
  const vector = (x: number, y: number) => [x, y, ...new Array(510).fill(0)];
  it('normalizes template averages and keeps the 0.90 threshold', async () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => {
        data.set(k, v);
      },
      removeItem: (k: string) => {
        data.delete(k);
      },
    } as Storage;
    const auth = createLocalAuthProvider({ storage });
    expect(Math.hypot(...averageVector([vector(1, 0), vector(0, 1)]))).toBeCloseTo(1);
    expect(() => averageVector([vector(0, 0)])).toThrow('Invalid face embedding');
    await auth.enroll([vector(1, 0)]);
    expect((await auth.authenticate(vector(0.91, Math.sqrt(1 - 0.91 ** 2)))).authenticated).toBe(true);
    expect((await auth.authenticate(vector(0.89, Math.sqrt(1 - 0.89 ** 2)))).authenticated).toBe(false);
    expect((await auth.authenticate(vector(0, 1))).authenticated).toBe(false);
  });
  it('requires a new default enrollment without deleting previous templates', async () => {
    const previousKey = 'oath-face-demo-embedding-v4';
    const previous = JSON.stringify([vector(1, 0)]);
    const data = new Map([[previousKey, previous]]);
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
      removeItem: (key: string) => {
        data.delete(key);
      },
    } as Storage;
    const auth = createLocalAuthProvider({ storage });
    expect(await auth.hasEnrollment?.()).toBe(false);
    expect((await auth.authenticate(vector(1, 0))).authenticated).toBe(false);
    expect(data.get(previousKey)).toBe(previous);
    await auth.enroll([vector(1, 0)]);
    expect(await auth.hasEnrollment?.()).toBe(true);
    expect(data.has('oath-face-demo-embedding-v5')).toBe(true);
    expect((await auth.authenticate(vector(1, 0))).authenticated).toBe(true);
    const custom = createLocalAuthProvider({ storage, key: previousKey });
    expect(await custom.hasEnrollment?.()).toBe(true);
  });

  it('prefers authenticated fallback even when another candidate has a higher score', () => {
    expect(
      selectAuthResult([
        { authenticated: false, score: 0.99 },
        { authenticated: true, score: 0.91, id: 'fallback' },
      ]).id,
    ).toBe('fallback');
  });
  it('retains the HTTP enrollment and authentication wire format', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id: 'face', score: 0.95 }), { status: 200 }));
    const auth = createHttpAuthProvider({ baseUrl: '/api/', fetchImpl });
    await auth.enroll([vector(1, 0)]);
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/enroll');
    expect(JSON.parse(fetchImpl.mock.calls[0][1]?.body as string)).toEqual({ faces: [vector(1, 0)] });
    expect((await auth.authenticate(vector(1, 0))).authenticated).toBe(true);
    expect(JSON.parse(fetchImpl.mock.calls[1][1]?.body as string)).toEqual({ face: vector(1, 0) });
  });
});
