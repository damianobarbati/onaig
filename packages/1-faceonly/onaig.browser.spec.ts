import { type Browser, chromium, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer } from './test-server.ts';

let host: Awaited<ReturnType<typeof startTestServer>>;
let browser: Browser;
beforeAll(async () => {
  host = await startTestServer();
  browser = await chromium.launch({ channel: 'chromium-headless-shell', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
});
afterAll(async () => {
  await browser?.close();
  await host?.server.close();
});

// The actual controller, canvas warping and lifecycle run in Chromium. Only
// the detector, neural network and provider are controlled for repeatability.
declare global {
  interface Window {
    createTestOnaig: typeof import('./onaig.ts').default;
    test: {
      controller: ReturnType<typeof import('./onaig.ts').default>;
      events: import('./onaig.ts').OnaigEvents['state'][];
      progress: import('./onaig.ts').OnaigEvents['login-progress'][];
      enrollment: number[][] | null;
      status: string;
      authCalls: number;
      gate: boolean;
      release: (() => void) | null;
      inferenceCalls: number;
      authMode: 'match' | 'reject' | 'fallback';
      hasFace: boolean;
      light: number;
      background: number;
      syntheticFace: boolean;
      detectedFaceScale: number;
      incompleteFace: boolean;
      captureInputs: boolean;
      inputs: { background: number; grayscale: boolean; data: number[] }[];
      sourcePixels: Uint8ClampedArray | null;
      poseSequence: { yaw: number; pitch: number }[];
      pose: { yaw: number; pitch: number; angle: number; scale: number; x: number; y: number };
    };
  }
}

async function setup(normalizePose = false): Promise<Page> {
  const page = await browser.newPage({ permissions: ['camera'] });
  await page.route('**/harness', (route) => route.fulfill({ contentType: 'text/html', body: '<div id="camera"></div>' }));
  await page.route('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/+esm', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: `
    export const FilesetResolver = { forVisionTasks: async () => ({}) };
    export class FaceLandmarker {
      static FACE_LANDMARKS_TESSELATION = [];
      static FACE_LANDMARKS_CONTOURS = [];
      static async createFromOptions() { return new FaceLandmarker(); }
      detectForVideo(video) {
        const t = window.test;
        if (!t.hasFace) return { faceLandmarks: [] };
        const p = {...t.pose, ...t.poseSequence.shift()}, w = video.videoWidth, h = video.videoHeight;
        const map = (x, y) => ({ x: (p.scale * (x*Math.cos(p.angle)-y*Math.sin(p.angle)) + p.x) / w, y: (p.scale * (x*Math.sin(p.angle)+y*Math.cos(p.angle)) + p.y) / h, z: 0 });
        const points = Array.from({length: 468}, () => map(56, 70));
        const oval = [10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109];
        oval.forEach((idx,i) => { const a = i*2*Math.PI/oval.length - Math.PI/2; points[idx] = map(56+42*t.detectedFaceScale*Math.cos(a), 66+51*t.detectedFaceScale*Math.sin(a)); });
        points[33] = map(38.2946,51.6963); points[263] = map(73.5318,51.5014);
        points[1] = map(56.0252+p.yaw*35.2372, 71.7366+p.pitch*35.2372);
        points[61] = map(41.5493,92.3655); points[291] = map(70.7299,92.2041);
        return { faceLandmarks: [points] };
      }
    }
  `,
    }),
  );
  await page.route('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/+esm', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: `
    export const env = { wasm: {} };
    export class Tensor { constructor(type, data, dims) { this.data = data; } }
    export const InferenceSession = { create: async () => ({ inputNames: ['input'], outputNames: ['output'], run: async (feeds) => {
      window.test.inferenceCalls++;
      const input = feeds.input.data;
      const grayscale = input.every((v,i) => i % 3 === 0 || Math.abs(v-input[i-i%3]) < 0.00001);
      if (window.test.captureInputs) window.test.inputs.push({ background: window.test.background, grayscale, data: Array.from(input) });
      const data = new Float32Array(512); data[grayscale ? 1 : 0] = 1;
      return { output: { data } };
    } }) };
  `,
    }),
  );
  await page.route('https://media.githubusercontent.com/**', (route) => route.fulfill({ body: 'model' }));
  await page.route('https://storage.googleapis.com/**', (route) => route.fulfill({ body: 'model' }));
  await page.goto(`${host.url}harness`);
  await page.addScriptTag({ type: 'module', content: "import createOnaig from '/onaig.ts'; window.createTestOnaig = createOnaig;" });
  await page.waitForFunction(() => typeof window.createTestOnaig === 'function');
  await page.evaluate(async (perspective) => {
    const t: Window['test'] = {
      controller: undefined as unknown as Window['test']['controller'],
      events: [],
      progress: [],
      enrollment: null,
      status: 'idle',
      authCalls: 0,
      gate: false,
      release: null,
      inferenceCalls: 0,
      authMode: 'match',
      hasFace: true,
      light: 1,
      background: 0,
      syntheticFace: false,
      detectedFaceScale: 1,
      incompleteFace: false,
      captureInputs: false,
      inputs: [],
      sourcePixels: null,
      poseSequence: [],
      pose: { yaw: 0.12, pitch: 0, angle: 0, scale: 2, x: 190, y: 95 },
    };
    window.test = t;
    const originalDraw = CanvasRenderingContext2D.prototype.drawImage;
    const syntheticFrames = new Map<string, HTMLCanvasElement>();
    CanvasRenderingContext2D.prototype.drawImage = function (image: CanvasImageSource, ...coordinates: number[]) {
      if (image instanceof HTMLVideoElement && t.syntheticFace) {
        const width = image.videoWidth,
          height = image.videoHeight,
          p = t.pose;
        const key = JSON.stringify([width, height, p, t.background, t.incompleteFace]);
        const cached = syntheticFrames.get(key);
        if (cached) {
          Reflect.apply(originalDraw, this, [cached, ...coordinates]);
          return;
        }
        const pixels = this.createImageData(width, height);
        const polygon = Array.from({ length: 36 }, (_, i) => {
          const a = (i * 2 * Math.PI) / 36 - Math.PI / 2;
          const x = 56 + 42 * Math.cos(a),
            y = 66 + 51 * Math.sin(a);
          return [p.scale * (x * Math.cos(p.angle) - y * Math.sin(p.angle)) + p.x, p.scale * (x * Math.sin(p.angle) + y * Math.cos(p.angle)) + p.y];
        });
        const backgrounds = [
          [255, 0, 0],
          [0, 0, 255],
          [255, 255, 255],
          [0, 0, 0],
        ];
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width; x++) {
            let inside = false;
            for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
              const [ax, ay] = polygon[j],
                [bx, by] = polygon[i];
              if (ay > y + 0.5 !== by > y + 0.5 && x + 0.5 < ((bx - ax) * (y + 0.5 - ay)) / (by - ay) + ax) inside = !inside;
            }
            const dx = x + 0.5 - p.x,
              dy = y + 0.5 - p.y;
            const localX = (dx * Math.cos(p.angle) + dy * Math.sin(p.angle)) / p.scale;
            const localY = (-dx * Math.sin(p.angle) + dy * Math.cos(p.angle)) / p.scale;
            const level = 55 + localX * 0.7 + localY * 0.4;
            const color = inside ? [level, level * 0.85, level * 0.7] : backgrounds[t.background];
            const incomplete = inside && t.incompleteFace && Math.abs(localX - 56) < 5 && Math.abs(localY - 66) < 5;
            pixels.data.set([...color, incomplete ? 0 : 255], (y * width + x) * 4);
          }
        const frame = document.createElement('canvas');
        frame.width = width;
        frame.height = height;
        const frameContext = frame.getContext('2d');
        if (!frameContext) throw new Error('Synthetic frame requires a canvas context.');
        frameContext.putImageData(pixels, 0, 0);
        syntheticFrames.set(key, frame);
        Reflect.apply(originalDraw, this, [frame, ...coordinates]);
      } else if (image instanceof HTMLVideoElement) {
        const gradient = this.createLinearGradient(0, 0, 640, 0);
        gradient.addColorStop(0, `rgb(${70 * t.light},${60 * t.light},${50 * t.light})`);
        gradient.addColorStop(1, `rgb(${180 * t.light},${150 * t.light},${130 * t.light})`);
        this.fillStyle = gradient;
        this.fillRect(0, 0, 640, 480);
      } else {
        if (t.captureInputs && image instanceof HTMLCanvasElement && image.width === t.controller.video.videoWidth) {
          t.sourcePixels = image.getContext('2d')?.getImageData(0, 0, image.width, image.height).data ?? null;
        }
        Reflect.apply(originalDraw, this, [image, ...coordinates]);
      }
    };
    t.controller = window.createTestOnaig({
      root: '#camera',
      loginTimeoutMs: 15_000,
      normalizePose: perspective,
      auth: {
        enroll: async (vectors) => {
          t.enrollment = vectors;
          return { id: 'face' };
        },
        authenticate: async (vector) => {
          t.authCalls++;
          const mode = t.authMode;
          if (t.gate)
            await new Promise<void>((resolve) => {
              t.release = resolve;
            });
          const authenticated = mode === 'match' || (mode === 'fallback' && vector[1] === 1);
          return { authenticated, score: authenticated ? 0.95 : 0.98, id: authenticated ? 'face' : undefined };
        },
      },
    });
    t.controller.on('state', (event) => {
      t.events.push(event);
    });
    t.controller.on('login-progress', (event) => {
      t.progress.push(event);
    });
  }, normalizePose);
  await page.waitForFunction(() => window.test.events.some((e) => e.type === 'camera-ready'));
  return page;
}

async function setPose(page: Page, values: Partial<Window['test']['pose']>) {
  await page.evaluate((values) => {
    Object.assign(window.test.pose, values);
  }, values);
}
async function startLogin(page: Page) {
  await page.evaluate(() => {
    const t = window.test;
    t.status = 'pending';
    void t.controller.login().then(
      () => {
        t.status = 'success';
      },
      () => {
        t.status = 'rejected';
      },
    );
  });
  await page.waitForFunction(() => window.test.events.some((e) => e.type === 'login-challenge'));
}
async function liveness(page: Page) {
  for (let index = 0; index < 2; index++) {
    await page.waitForFunction((i) => window.test.events.some((e) => e.type === 'login-challenge' && e.index === i), index);
    const challenge = await page.evaluate((i) => {
      const e = window.test.events.find((e) => e.type === 'login-challenge' && e.index === i);
      return e?.type === 'login-challenge' ? e.challenge : null;
    }, index);
    await setPose(page, { yaw: challenge === 'left' ? 0.38 : challenge === 'right' ? -0.12 : 0.12, pitch: challenge === 'up' ? -0.14 : challenge === 'down' ? 0.14 : 0 });
    await page.waitForFunction((i) => window.test.events.some((e) => e.type === 'login-center' && e.index === i), index);
    await setPose(page, { yaw: 0.12, pitch: 0 });
  }
  await page.waitForFunction(() => window.test.events.some((e) => e.type === 'login-liveness-success'));
}

describe('ONAIG controller', () => {
  it.each([false, true])('neutralizes background before resampling and preserves RGB/grayscale tensors (perspective=%s)', async (perspective) => {
    const page = await setup(perspective);
    try {
      await page.evaluate(() => {
        window.test.syntheticFace = true;
        window.test.authMode = 'reject';
      });
      await startLogin(page);
      for (const geometry of [
        { angle: 0, scale: 2, x: 190, y: 95 },
        { angle: 0.2, scale: 1.5, x: 250, y: 140 },
        { angle: -0.2, scale: 2.5, x: 180, y: 100 },
      ]) {
        await page.evaluate((geometry) => {
          Object.assign(window.test.pose, geometry);
          window.test.inputs = [];
          window.test.captureInputs = true;
        }, geometry);
        for (const background of [0, 1, 2, 3]) {
          await page.evaluate((background) => {
            window.test.background = background;
          }, background);
          await page.waitForFunction((background) => window.test.inputs.some((input) => input.background === background && input.grayscale), background);
        }
        const comparison = await page.evaluate(() => {
          const inputs = window.test.inputs;
          return [false, true].map((grayscale) => {
            const baseline = inputs.find((input) => input.background === 0 && input.grayscale === grayscale);
            if (!baseline) return false;
            return [1, 2, 3].every((background) => {
              const candidate = inputs.find((input) => input.background === background && input.grayscale === grayscale);
              if (!candidate) return false;
              return baseline.data.every((value, i) => value === candidate.data[i]);
            });
          });
        });
        expect(comparison).toEqual([true, true]);
        if (!perspective) {
          const source = await page.evaluate(() => {
            const t = window.test,
              width = t.controller.video.videoWidth;
            const p = t.pose;
            if (!t.sourcePixels) throw new Error('Missing masked source image.');
            const x = Math.floor(p.scale * (56 * Math.cos(p.angle) - 66 * Math.sin(p.angle)) + p.x);
            const y = Math.floor(p.scale * (56 * Math.sin(p.angle) + 66 * Math.cos(p.angle)) + p.y);
            const j = (y * width + x) * 4;
            const dx = x + 0.5 - p.x,
              dy = y + 0.5 - p.y;
            const level = 55 + ((dx * Math.cos(p.angle) + dy * Math.sin(p.angle)) / p.scale) * 0.7 + ((-dx * Math.sin(p.angle) + dy * Math.cos(p.angle)) / p.scale) * 0.4;
            return {
              background: Array.from(t.sourcePixels.slice(0, 4)),
              face: Array.from(t.sourcePixels.slice(j, j + 4)),
              expected: Array.from(new Uint8ClampedArray([level, level * 0.85, level * 0.7, 255])),
              dimensions: [width, t.controller.video.videoHeight],
            };
          });
          expect(source.dimensions).toEqual([640, 480]);
          expect(source.background).toEqual([128, 128, 128, 255]);
          expect(source.face).toEqual(source.expected);
        }
      }
      await page.evaluate(() => {
        window.test.captureInputs = false;
      });
      expect(await page.evaluate(() => window.test.events.some((e) => e.type === 'login-success'))).toBe(false);
    } finally {
      await page.close();
    }
  }, 15_000);

  it.each([false, true])('excludes background when the detected contour extends beyond the actual face (perspective=%s)', async (perspective) => {
    const page = await setup(perspective);
    try {
      await page.evaluate(() => {
        window.test.syntheticFace = true;
        window.test.detectedFaceScale = 1.05;
        window.test.captureInputs = true;
        window.test.authMode = 'reject';
      });
      await startLogin(page);
      for (const background of [0, 1, 2, 3]) {
        await page.evaluate((background) => {
          window.test.background = background;
        }, background);
        await page.waitForFunction((background) => window.test.inputs.some((input) => input.background === background && input.grayscale), background);
      }
      const comparison = await page.evaluate(() =>
        [false, true].map((grayscale) => {
          const inputs = window.test.inputs;
          const baseline = inputs.find((input) => input.background === 0 && input.grayscale === grayscale);
          return Boolean(
            baseline &&
              [1, 2, 3].every((background) => {
                const candidate = inputs.find((input) => input.background === background && input.grayscale === grayscale);
                return candidate && baseline.data.every((value, i) => value === candidate.data[i]);
              }),
          );
        }),
      );
      expect(comparison).toEqual([true, true]);
    } finally {
      await page.close();
    }
  });

  it.each([false, true])('rejects incomplete or out-of-frame source faces before inference (perspective=%s)', async (perspective) => {
    const page = await setup(perspective);
    try {
      await page.evaluate(() => {
        window.test.syntheticFace = true;
      });
      await startLogin(page);
      await page.evaluate(() => {
        window.test.incompleteFace = true;
        window.test.inferenceCalls = 0;
        window.test.events = [];
      });
      await page.waitForFunction(() => window.test.events.some((e) => e.type === 'login-guidance' && e.guidance === 'pose'));
      expect(await page.evaluate(() => window.test.inferenceCalls)).toBe(0);
      await page.evaluate(() => {
        window.test.incompleteFace = false;
        window.test.events = [];
        window.test.pose.x = -100;
      });
      await page.waitForFunction(() => window.test.events.some((e) => e.type === 'login-guidance'));
      expect(await page.evaluate(() => window.test.inferenceCalls)).toBe(0);
    } finally {
      await page.close();
    }
  });

  it('guides unusable lighting, discards interrupted samples and enrolls all five poses', async () => {
    const page = await setup();
    try {
      await page.evaluate(() => {
        window.test.light = 0;
        window.test.status = 'pending';
        void window.test.controller.register().then(() => {
          window.test.status = 'success';
        });
      });
      await page.waitForFunction(() => window.test.events.some((e) => e.type === 'register-guidance' && e.guidance === 'light'));
      expect(await page.evaluate(() => window.test.inferenceCalls)).toBe(0);
      await page.evaluate(() => {
        window.test.light = 1;
      });
      for (const [index, pose] of ['up', 'down', 'left', 'right', 'center'].entries()) {
        await page.waitForFunction((pose) => window.test.events.some((e) => e.type === 'challenge' && e.challenge === pose), pose);
        if (index === 0) {
          await page.evaluate(() => {
            window.test.poseSequence = [-0.14, 0, -0.14, -0.14, 0].map((pitch) => ({ yaw: 0.12, pitch }));
          });
          await page.waitForFunction(() => window.test.poseSequence.length === 0);
          expect(await page.evaluate(() => window.test.inferenceCalls)).toBe(0);
        }
        await setPose(page, { yaw: pose === 'left' ? 0.38 : pose === 'right' ? -0.12 : 0.12, pitch: pose === 'up' ? -0.14 : pose === 'down' ? 0.14 : 0 });
        await page.waitForFunction((i) => window.test.events.some((e) => e.type === 'register-progress' && e.completed === i + 1), index);
      }
      await page.waitForFunction(() => window.test.status === 'success');
      expect(await page.evaluate(() => window.test.enrollment?.length)).toBe(10);
    } finally {
      await page.close();
    }
  });

  it('requires liveness and three matches, accepts a grayscale fallback and changed camera geometry', async () => {
    const page = await setup();
    try {
      await setPose(page, { angle: 0.2, scale: 1.5, x: 250, y: 140 });
      await page.evaluate(() => {
        window.test.light = 0.8;
        window.test.authMode = 'fallback';
      });
      await startLogin(page);
      await page.waitForFunction(() => window.test.progress.filter((e) => e.matched).length >= 3);
      expect(await page.evaluate(() => window.test.status)).toBe('pending');
      await liveness(page);
      await page.waitForFunction(() => window.test.status === 'success');
      expect(await page.evaluate(() => window.test.authCalls)).toBeGreaterThanOrEqual(6);
    } finally {
      await page.close();
    }
  });

  it('does not log in a rejected identity even after the movements complete', async () => {
    const page = await setup(true);
    try {
      await page.evaluate(() => {
        window.test.authMode = 'reject';
      });
      await startLogin(page);
      await liveness(page);
      expect(await page.evaluate(() => window.test.status)).toBe('pending');
      expect(await page.evaluate(() => window.test.events.some((e) => e.type === 'login-success'))).toBe(false);
    } finally {
      await page.close();
    }
  });

  it('ignores an authentication response after losing the face or stopping', async () => {
    const page = await setup();
    try {
      await page.evaluate(() => {
        window.test.gate = true;
      });
      await startLogin(page);
      await page.waitForFunction(() => window.test.release !== null);
      await page.evaluate(() => {
        window.test.hasFace = false;
      });
      await page.waitForFunction(() => window.test.events.some((e) => e.type === 'no-face'));
      await page.evaluate(() => {
        window.test.release?.();
      });
      await page.waitForFunction(() => window.test.controller.video.currentTime > 1);
      expect(await page.evaluate(() => window.test.progress.length)).toBe(0);
      await page.evaluate(() => {
        window.test.controller.stop();
      });
      await page.waitForFunction(() => window.test.status === 'rejected');
      expect(await page.evaluate(() => window.test.events.some((e) => e.type === 'login-success'))).toBe(false);
    } finally {
      await page.close();
    }
  });

  it('waits for the third successful comparison even after liveness has completed', async () => {
    const page = await setup();
    try {
      await page.evaluate(() => {
        window.test.gate = true;
      });
      await startLogin(page);
      await liveness(page);
      for (let count = 1; count <= 2; count++) {
        await page.waitForFunction((n) => window.test.authCalls === n, count);
        await page.evaluate(() => {
          const release = window.test.release;
          window.test.release = null;
          release?.();
        });
        await page.waitForFunction((n) => window.test.authCalls === n + 1, count);
        expect(await page.evaluate(() => window.test.status)).toBe('pending');
      }
      await page.evaluate(() => {
        window.test.release?.();
      });
      await page.waitForFunction(() => window.test.status === 'success');
      expect(await page.evaluate(() => window.test.progress.filter((e) => e.matched).length)).toBe(3);
    } finally {
      await page.close();
    }
  });

  it('ignores a pending provider response after stop and allows a fresh login', async () => {
    const page = await setup();
    try {
      await page.evaluate(() => {
        window.test.gate = true;
      });
      await startLogin(page);
      await page.waitForFunction(() => window.test.release !== null);
      await page.evaluate(() => {
        window.test.controller.stop();
        window.test.release?.();
      });
      await page.waitForFunction(() => window.test.status === 'rejected');
      expect(await page.evaluate(() => window.test.progress.length)).toBe(0);
      await page.evaluate(() => {
        window.test.events = [];
        window.test.gate = false;
      });
      await startLogin(page);
      await liveness(page);
      await page.waitForFunction(() => window.test.status === 'success');
    } finally {
      await page.close();
    }
  });

  it('resets the sequence when both RGB and grayscale comparisons fail', async () => {
    const page = await setup();
    try {
      await page.evaluate(() => {
        window.test.gate = true;
      });
      await startLogin(page);
      await liveness(page);
      await page.waitForFunction(() => window.test.authCalls === 1);
      await page.evaluate(() => {
        window.test.authMode = 'reject';
        window.test.release?.();
      });
      await page.waitForFunction(() => window.test.authCalls === 2);
      await page.evaluate(() => {
        window.test.release?.();
      });
      await page.waitForFunction(() => window.test.authCalls === 3);
      await page.evaluate(() => {
        window.test.authMode = 'match';
        window.test.release?.();
      });
      await page.waitForFunction(() => window.test.authCalls === 4);
      expect(await page.evaluate(() => window.test.progress.map((e) => e.matched))).toEqual([true, false]);
      for (let call = 4; call < 6; call++) {
        await page.evaluate(() => {
          window.test.release?.();
        });
        await page.waitForFunction((n) => window.test.authCalls === n + 1, call);
        expect(await page.evaluate(() => window.test.status)).toBe('pending');
      }
      await page.evaluate(() => {
        window.test.release?.();
      });
      await page.waitForFunction(() => window.test.status === 'success');
    } finally {
      await page.close();
    }
  });
});
