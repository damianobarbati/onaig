import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { startTestServer } from './test-server.ts';

declare global {
  interface Window {
    modelFactory: typeof import('./onaig.ts').default;
    modelAverageVector: typeof import('./onaig.ts').averageVector;
    modelVision: { FaceLandmarker: any; FilesetResolver: any };
  }
}

// Run the actual controller, detector and GhostFaceNet. Public image fixtures
// are test inputs, not user enrollments. Like the app smoke test, this needs network.
it('keeps real-model matches across backgrounds and exposure changes, and rejects a different face', async () => {
  const host = await startTestServer();
  const browser = await chromium.launch({ channel: 'chromium-headless-shell', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  try {
    const page = await browser.newPage({ permissions: ['camera'] });
    await page.route('**/model-harness', (route) => route.fulfill({ contentType: 'text/html', body: '<div id="camera"></div>' }));
    for (const [path, url] of [
      ['primary.jpg', 'https://raw.githubusercontent.com/opencv/opencv/master/samples/data/lena.jpg'],
      ['secondary.jpg', 'https://storage.googleapis.com/mediapipe-assets/portrait.jpg'],
    ]) {
      await page.route(`**/${path}`, async (route) => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Fixture download failed (${response.status}): ${url}`);
        await route.fulfill({ contentType: 'image/jpeg', body: Buffer.from(await response.arrayBuffer()) });
      });
    }
    await page.goto(`${host.url}model-harness`);
    await page.addScriptTag({
      type: 'module',
      content: `
      import createOnaig, { averageVector } from '/onaig.ts';
      import { FaceLandmarker, FilesetResolver } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/+esm';
      window.modelFactory = createOnaig;
      window.modelAverageVector = averageVector;
      window.modelVision = { FaceLandmarker, FilesetResolver };
    `,
    });
    await page.waitForFunction(() => typeof window.modelFactory === 'function');
    const measurements = await page.evaluate(async () => {
      const { FaceLandmarker, FilesetResolver } = window.modelVision;
      const createOnaig = window.modelFactory;
      const vision = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm');
      const detector = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task', delegate: 'CPU' },
        runningMode: 'IMAGE',
        numFaces: 1,
      });
      const pictures = await Promise.all(
        ['primary.jpg', 'secondary.jpg'].map(async (url) => {
          const image = new Image();
          image.src = url;
          await image.decode();
          return image;
        }),
      );
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 480;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('Fixture requires a canvas context.');
      context.drawImage(pictures[0], 120, 40, 400, 400);
      const points: { x: number; y: number }[] = detector.detect(canvas).faceLandmarks[0];
      if (!points) throw new Error('Fixture face was not detected.');
      detector.close();
      const oval = [
        10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67,
        109,
      ];
      const polygon = oval.map((i) => [points[i].x * 640, points[i].y * 480]);
      const original = context.getImageData(0, 0, 640, 480);
      const scenes = [
        { name: 'reference', background: [80, 80, 80], gain: [1, 1, 1] },
        { name: 'blue background', background: [0, 0, 255], gain: [1, 1, 1] },
        { name: 'white background', background: [255, 255, 255], gain: [1, 1, 1] },
        { name: 'dimmer face', background: [255, 255, 255], gain: [0.65, 0.65, 0.65] },
        { name: 'warm light', background: [255, 255, 255], gain: [1.15, 0.9, 0.7] },
      ];
      const frames = scenes.map(({ background, gain }) => {
        const frame = document.createElement('canvas');
        frame.width = 640;
        frame.height = 480;
        const pixels = new ImageData(new Uint8ClampedArray(original.data), 640, 480);
        for (let y = 0; y < 480; y++)
          for (let x = 0; x < 640; x++) {
            let inside = false;
            for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
              const [ax, ay] = polygon[j],
                [bx, by] = polygon[i];
              if (ay > y + 0.5 !== by > y + 0.5 && x + 0.5 < ((bx - ax) * (y + 0.5 - ay)) / (by - ay) + ax) inside = !inside;
            }
            const j = (y * 640 + x) * 4;
            for (let c = 0; c < 3; c++) pixels.data[j + c] = inside ? original.data[j + c] * gain[c] : background[c];
            pixels.data[j + 3] = 255;
          }
        const frameContext = frame.getContext('2d');
        if (!frameContext) throw new Error('Fixture requires a canvas context.');
        frameContext.putImageData(pixels, 0, 0);
        return frame;
      });
      const other = document.createElement('canvas');
      other.width = 640;
      other.height = 480;
      const otherContext = other.getContext('2d');
      if (!otherContext) throw new Error('Fixture requires a canvas context.');
      otherContext.fillStyle = 'rgb(80,80,80)';
      otherContext.fillRect(0, 0, 640, 480);
      const scale = 400 / Math.max(pictures[1].width, pictures[1].height);
      otherContext.drawImage(pictures[1], 120, 40, pictures[1].width * scale, pictures[1].height * scale);
      frames.push(other);
      let sceneIndex = 0;
      const originalDetection = FaceLandmarker.prototype.detectForVideo;
      FaceLandmarker.prototype.detectForVideo = function (_video: HTMLVideoElement, timestamp: number) {
        return originalDetection.call(this, frames[sceneIndex], timestamp);
      };
      const originalDraw = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function (image: CanvasImageSource, ...coordinates: number[]) {
        Reflect.apply(originalDraw, this, [image instanceof HTMLVideoElement ? frames[sceneIndex] : image, ...coordinates]);
      };
      const references: number[][] = [];
      const progress: { matched: boolean; score?: number }[] = [];
      let controller: ReturnType<typeof createOnaig> | null = null;
      const measurements: { scene: string; scores: number[]; matches: boolean[] }[] = [];
      try {
        for (const index of frames.keys()) {
          controller?.destroy();
          sceneIndex = index;
          progress.length = 0;
          controller = createOnaig({
            root: '#camera',
            loginTimeoutMs: 60_000,
            auth: {
              enroll: async () => ({}),
              authenticate: async (vector) => {
                if (sceneIndex === 0) references.push(vector);
                const score = Math.max(...references.map((reference) => reference.reduce((sum, value, i) => sum + value * vector[i], 0)));
                return { authenticated: sceneIndex !== 0 && score >= 0.9, score };
              },
            },
          });
          controller.on('login-progress', (event) => {
            progress.push(event);
          });
          void controller.login().catch(() => {});
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error(`No embeddings for scene ${index}.`)), 15_000);
            const check = () => {
              if (progress.length >= (index === 0 ? 3 : 6)) {
                clearTimeout(timeout);
                resolve();
              } else requestAnimationFrame(check);
            };
            check();
          });
          controller.stop();
          measurements.push({
            scene: scenes[index]?.name ?? 'different face',
            scores: progress.map((event) => event.score ?? -1),
            matches: progress.map((event) => event.matched),
          });
          if (index === 0) {
            const vectors = references.splice(0);
            references.push(window.modelAverageVector(vectors.filter((_, i) => i % 2 === 0)), window.modelAverageVector(vectors.filter((_, i) => i % 2 === 1)));
          }
        }
      } finally {
        controller?.destroy();
      }
      return measurements;
    });
    for (const measurement of measurements.slice(1, -1)) {
      expect(measurement.matches, `${measurement.scene}: ${measurement.scores.join(', ')}`).toEqual(new Array(measurement.matches.length).fill(true));
    }
    // console.log(
    //   'Real-model similarities:',
    //   measurements.map(({ scene, scores }) => ({ scene, min: Math.min(...scores).toFixed(4), max: Math.max(...scores).toFixed(4) })),
    // );
    const negative = measurements.at(-1);
    expect(negative).toBeDefined();
    expect(Math.max(...(negative?.scores ?? [])), 'different face').toBeLessThan(0.9);
  } finally {
    await browser.close();
    await host.server.close();
  }
}, 120_000);
