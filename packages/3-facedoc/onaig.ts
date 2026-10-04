import { FaceLandmarker, FilesetResolver } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/+esm';
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/+esm';

export type LandmarkMode = 'live' | 'mesh' | 'contours';
export type Pose = 'up' | 'down' | 'left' | 'right' | 'center';
export type Guidance = 'hold' | 'center' | 'distance' | 'light' | 'pose';
export type Point = { x: number; y: number; z?: number };
export type XY = [number, number];
export type Enrollment = { id?: string; embeddings: number[][]; count: number };
export type AuthResult = { authenticated: boolean; score?: number; id?: string; vector?: number[]; matched?: boolean };
export interface AuthProvider {
  enroll(embeddings: number[][]): Promise<{ id?: string }>;
  authenticate(embedding: number[]): Promise<AuthResult>;
  hasEnrollment?(): Promise<boolean>;
  getEnrollment?(): Promise<number[][] | null>;
  forget?(): Promise<void>;
}
export interface OnaigOptions {
  root: string | HTMLElement;
  landmark?: LandmarkMode;
  auth?: AuthProvider;
  loginTimeoutMs?: number;
  normalizePose?: boolean;
}
type Diagnostics = { yaw: number; pitch: number; roll: number; landmarks: Point[] };
type StateEvent =
  | { type: 'loading' | 'register-start' | 'login-liveness-success' | 'stopped' | 'no-face' }
  | { type: 'camera-ready'; video: HTMLVideoElement }
  | { type: 'register-guidance' | 'login-guidance'; guidance: Guidance }
  | { type: 'challenge'; challenge: Pose }
  | { type: 'register-progress'; completed: number; total: number; challenge: Pose }
  | { type: 'register-success'; result: Enrollment }
  | { type: 'login-start'; challenges: Pose[]; timeoutMs: number }
  | { type: 'login-challenge'; challenge: Exclude<Pose, 'center'>; index: number; total: number }
  | { type: 'login-challenge-progress'; challenge: Pose; index: number; stableFrames: number; requiredFrames: number }
  | { type: 'login-center'; index: number; total: number }
  | { type: 'login-success'; result: AuthResult & { matched: true } }
  | { type: 'login-timeout' | 'login-error'; error: unknown }
  | { type: 'login-check'; matched: boolean };
export type OnaigEvents = {
  frame: Diagnostics;
  state: StateEvent;
  error: unknown;
  'login-progress': { matched: boolean; score?: number };
  landmark: { mode: LandmarkMode };
};
type PreparedFace = { image: Uint8ClampedArray; weights: Float32Array };
type Transform = (point: XY) => XY | null;

const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
];
const FACE_TARGET: XY[] = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

const MODEL_URL = 'https://media.githubusercontent.com/media/andestech/ModelZoo/refs/heads/master/GhostFaceNet/Model/ghostface_fp32.onnx';
const MP_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
// Bump the local enrollment format because embeddings are now generated from
// a crop whose background is neutralized before resampling.
const STORAGE_KEY = 'oath-face-demo-embedding-v5';
const MODEL_CACHE_NAME = 'face-auth-models-v1';
const THRESHOLD = 0.9;
// Leave a buffer for landmark uncertainty at the face/background boundary.
// The final mask sits further inside so resampling cannot pull in that boundary.
const SOURCE_FACE_SCALE = 0.9;
const EMBEDDING_FACE_SCALE = 0.88;
const POSES: Pose[] = ['up', 'down', 'left', 'right', 'center'];
const POSE_SAMPLE_COUNT = 3;
// Allow for small pose-estimation variations while the user is centering.
const NEUTRAL_YAW_TOLERANCE = 0.14;
const MAX_ROLL_DEGREES = 20;
const PITCH_CALIBRATION_COUNT = 3;
const NEUTRAL_STABLE_FRAMES = 3;
const LOGIN_CHALLENGE_COUNT = 2;
const LOGIN_STABLE_FRAMES = 3;
const DEFAULT_LOGIN_TIMEOUT_MS = 5000;
const POSE_PITCH_THRESHOLD = 0.05;
const POSE_YAW_THRESHOLD = 0.14;
// The desktop preview uses object-fit: cover, so the source camera frame can
// extend beyond the visible 16:9 card.
const FACE_FRAME_MARGIN = 0.02;
const POSE_INTERVAL_MS = 50;
const EMBEDDING_INTERVAL_MS = 50;
const assetLoads = new Map<string, Promise<ArrayBuffer>>();
const landmarkModes = new Set(['live', 'mesh', 'contours']);

function parseEmbeddings(value: unknown): number[][] | null {
  if (Array.isArray(value) && value.length === 512 && value.every(Number.isFinite)) return [value];
  if (Array.isArray(value) && value.length > 0 && value.every((v) => Array.isArray(v) && v.length === 512 && v.every(Number.isFinite))) return value;
  return null;
}

async function cachedAssetBuffer(url) {
  if (!assetLoads.has(url))
    assetLoads.set(
      url,
      (async () => {
        if (!('caches' in window)) {
          const response = await fetch(url);
          if (!response.ok) throw new Error(`Model download failed (${response.status}).`);
          return response.arrayBuffer();
        }
        const cache = await caches.open(MODEL_CACHE_NAME);
        let response = await cache.match(url);
        if (!response) {
          response = await fetch(url, { cache: 'force-cache' });
          if (!response.ok) throw new Error(`Model download failed (${response.status}).`);
          await cache.put(url, response.clone());
        }
        return response.arrayBuffer();
      })(),
    );
  const pending = assetLoads.get(url);
  if (!pending) throw new Error('Model download was not started.');
  return (await pending).slice(0);
}

function readLocalEmbeddings(storage, key) {
  try {
    return parseEmbeddings(JSON.parse(storage.getItem(key) || 'null'));
  } catch {
    /* Invalid storage is equivalent to no enrollment. */
    return null;
  }
}

export function createLocalAuthProvider({ storage = globalThis.localStorage, key = STORAGE_KEY, threshold = THRESHOLD } = {}): AuthProvider {
  return {
    async enroll(embeddings) {
      storage.setItem(key, JSON.stringify(embeddings));
      return { id: key };
    },
    async authenticate(embedding) {
      const references = readLocalEmbeddings(storage, key);
      if (!references) return { authenticated: false };
      const score = Math.max(...references.map((reference) => cosine(embedding, reference)));
      return { authenticated: score >= threshold, score, id: score >= threshold ? key : undefined };
    },
    async hasEnrollment() {
      return Boolean(readLocalEmbeddings(storage, key));
    },
    async getEnrollment() {
      return readLocalEmbeddings(storage, key);
    },
    async forget() {
      storage.removeItem(key);
    },
  };
}

export function createHttpAuthProvider({ baseUrl = '', fetchImpl = globalThis.fetch } = {}): AuthProvider {
  if (typeof fetchImpl !== 'function') throw new TypeError('An HTTP provider requires fetch.');
  const apiBaseUrl = baseUrl.replace(/\/$/, '');

  const request = async (path: string, { method = 'POST', body }: { method?: string; body?: unknown } = {}) => {
    const response = await fetchImpl(`${apiBaseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let payload: { error?: string; id?: string; ids?: string[]; score?: number; faces?: number[][] } | number[][] | null = null;
    try {
      payload = await response.json();
    } catch {
      /* The status code remains sufficient for the generic error. */
    }
    return { response, payload: Array.isArray(payload) ? { faces: payload } : payload };
  };

  return {
    async enroll(embeddings) {
      const { response, payload } = await request('/enroll', { body: { faces: embeddings } });
      if (!response.ok) throw new Error(payload?.error || `Enrollment failed (${response.status}).`);
      return { id: payload?.id || payload?.ids?.[0] };
    },
    async authenticate(embedding) {
      const { response, payload } = await request('/auth', { body: { face: embedding } });
      if (response.status === 404) return { authenticated: false, score: payload?.score };
      if (!response.ok) throw new Error(payload?.error || `Authentication failed (${response.status}).`);
      return { authenticated: true, score: payload?.score, id: payload?.id };
    },
    async hasEnrollment() {
      const { response, payload } = await request('/me', { method: 'GET' });
      if (response.status === 404) return false;
      if (!response.ok) throw new Error(payload?.error || `Enrollment lookup failed (${response.status}).`);
      return true;
    },
    async getEnrollment() {
      const { response, payload } = await request('/me', { method: 'GET' });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(payload?.error || `Enrollment lookup failed (${response.status}).`);
      return parseEmbeddings(payload?.faces);
    },
    async forget() {
      const { response, payload } = await request('/forget');
      if (!response.ok && response.status !== 404) throw new Error(payload?.error || `Forget failed (${response.status}).`);
    },
  };
}

export function solveSimilarity(src: XY[], dst: XY[]): number[] | null {
  if (src.length < 2 || src.length !== dst.length || ![...src.flat(), ...dst.flat()].every(Number.isFinite)) return null;
  const mean = (points: XY[]): XY => [points.reduce((s, p) => s + p[0], 0) / points.length, points.reduce((s, p) => s + p[1], 0) / points.length];
  const [sx, sy] = mean(src),
    [tx, ty] = mean(dst);
  let denominator = 0,
    real = 0,
    imaginary = 0;
  src.forEach(([x, y], i) => {
    const dx = x - sx,
      dy = y - sy,
      u = dst[i][0] - tx,
      v = dst[i][1] - ty;
    denominator += dx * dx + dy * dy;
    real += dx * u + dy * v;
    imaginary += dx * v - dy * u;
  });
  if (denominator < 1e-8) return null;
  const a = real / denominator,
    b = imaginary / denominator;
  if (a * a + b * b < 1e-8) return null;
  return [a, -b, tx - a * sx + b * sy, b, a, ty - b * sx - a * sy];
}

function insetFacePolygon(polygon: XY[], scale: number): XY[] {
  const center: XY = [polygon.reduce((sum, [x]) => sum + x, 0) / polygon.length, polygon.reduce((sum, [, y]) => sum + y, 0) / polygon.length];
  return polygon.map(([x, y]) => [center[0] + (x - center[0]) * scale, center[1] + (y - center[1]) * scale]);
}

function rasterFaceMask(polygon: XY[], width: number, height: number, feather: number, minimumArea: number): Float32Array | null {
  if (polygon.length < 3 || !polygon.flat().every(Number.isFinite)) return null;
  const area =
    Math.abs(
      polygon.reduce((s, p, i) => {
        const q = polygon[(i + 1) % polygon.length];
        return s + p[0] * q[1] - q[0] * p[1];
      }, 0),
    ) / 2;
  if (area < minimumArea) return null;
  const weights = new Float32Array(width * height);
  const top = Math.max(0, Math.ceil(Math.min(...polygon.map((p) => p[1])) - 0.5));
  const bottom = Math.min(height, Math.ceil(Math.max(...polygon.map((p) => p[1])) - 0.5));
  for (let y = top; y < bottom; y++) {
    const py = y + 0.5;
    const crossings: number[] = [];
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const [ax, ay] = polygon[j],
        [bx, by] = polygon[i];
      if (ay > py !== by > py) crossings.push(((bx - ax) * (py - ay)) / (by - ay) + ax);
    }
    crossings.sort((a, b) => a - b);
    for (let pair = 0; pair + 1 < crossings.length; pair += 2) {
      const left = Math.min(width, Math.max(0, Math.ceil(crossings[pair] - 0.5)));
      const right = Math.max(0, Math.min(width, Math.ceil(crossings[pair + 1] - 0.5)));
      if (!feather) {
        weights.fill(1, y * width + left, y * width + right);
        continue;
      }
      for (let x = left; x < right; x++) {
        const px = x + 0.5;
        let distance = Infinity;
        for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
          const [ax, ay] = polygon[j],
            [bx, by] = polygon[i];
          const dx = bx - ax,
            dy = by - ay;
          const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / Math.max(dx * dx + dy * dy, 1e-8)));
          distance = Math.min(distance, Math.hypot(px - ax - t * dx, py - ay - t * dy));
        }
        // Feather inward only; exterior pixels have zero weight.
        weights[y * width + x] = Math.min(1, distance / feather);
      }
    }
  }
  return weights;
}

export function faceMask(polygon: XY[], size = 112): Float32Array | null {
  return rasterFaceMask(polygon, size, size, 4, size * size * 0.1);
}

export function normalizeFacePixels(image: Uint8ClampedArray, weights: Float32Array, grayscale = false): Uint8ClampedArray | null {
  let sum = 0,
    squared = 0,
    total = 0,
    clipped = 0;
  for (let i = 0; i < weights.length; i++) {
    const j = i * 4,
      w = weights[i];
    if (!w) continue;
    // Transparent/out-of-frame pixels must never enter an embedding.
    if (image[j + 3] !== 255) return null;
    const l = image[j] * 0.299 + image[j + 1] * 0.587 + image[j + 2] * 0.114;
    sum += l * w;
    squared += l * l * w;
    total += w;
    if (l < 8 || l > 247) clipped += w;
  }
  if (total < weights.length * 0.1) return null;
  const mean = sum / total,
    deviation = Math.sqrt(Math.max(1, squared / total - mean * mean));
  if (mean < 25 || mean > 230 || clipped / total > 0.4) return null;
  // Bound contrast after correcting exposure. Capping the raw gain makes the
  // same dimmed face keep a different contrast from its enrollment image.
  const exposureScale = 127.5 / mean;
  const gain = Math.min(1.8, Math.max(0.55, 58 / (deviation * exposureScale))) * exposureScale;
  const normalized = new Uint8ClampedArray(image.length);
  for (let i = 0; i < weights.length; i++) {
    const j = i * 4,
      w = weights[i];
    const l = image[j] * 0.299 + image[j + 1] * 0.587 + image[j + 2] * 0.114;
    const corrected = (l - mean) * gain + 127.5;
    // Scale all RGB channels equally, retaining chromatic ratios.
    const scale = corrected / Math.max(l, 1);
    for (let c = 0; c < 3; c++) normalized[j + c] = Math.max(0, Math.min(255, grayscale ? corrected : image[j + c] * scale)) * w + 127.5 * (1 - w);
    normalized[j + 3] = 255;
  }
  return normalized;
}

export function averageVector(samples: number[][]): number[] {
  const average = new Array<number>(512).fill(0);
  for (const vector of samples) for (let i = 0; i < 512; i++) average[i] += vector[i] / samples.length;
  const norm = Math.hypot(...average);
  if (!Number.isFinite(norm) || norm < 1e-8) throw new Error('Invalid face embedding.');
  return average.map((v) => v / norm);
}
export function selectAuthResult(results: AuthResult[]): AuthResult {
  return results.reduce((best, candidate) => {
    if (candidate.authenticated !== best.authenticated) return candidate.authenticated ? candidate : best;
    return (candidate.score ?? -Infinity) > (best.score ?? -Infinity) ? candidate : best;
  });
}
export function faceDiagnostics(points: Point[], width: number, height: number) {
  const dx = (points[263].x - points[33].x) * width,
    dy = (points[263].y - points[33].y) * height;
  const lengthSquared = Math.max(dx * dx + dy * dy, 1e-8);
  const nx = (points[1].x - (points[33].x + points[263].x) / 2) * width;
  const ny = (points[1].y - (points[33].y + points[263].y) / 2) * height;
  return { yaw: (nx * dx + ny * dy) / lengthSquared, pitch: (-nx * dy + ny * dx) / lengthSquared, roll: (Math.atan2(dy, dx) * 180) / Math.PI };
}
const cosine = (a: number[], b: number[]) => a.reduce((sum, value, i) => sum + value * b[i], 0);

function createOnaig({ root, landmark = 'live', auth = createLocalAuthProvider(), loginTimeoutMs = DEFAULT_LOGIN_TIMEOUT_MS, normalizePose = false }: OnaigOptions) {
  const rootNode = typeof root === 'string' ? document.querySelector(root) : root;
  if (!(rootNode instanceof HTMLElement)) throw new TypeError('ONAIG root must be a selector or an HTMLElement.');
  const rootElement: HTMLElement = rootNode;
  if (!landmarkModes.has(landmark)) throw new TypeError("ONAIG landmark must be 'live', 'mesh' or 'contours'.");
  if (!auth || typeof auth.enroll !== 'function' || typeof auth.authenticate !== 'function') throw new TypeError('ONAIG auth must provide enroll() and authenticate().');
  if (!Number.isFinite(loginTimeoutMs) || loginTimeoutMs <= 0) throw new TypeError('ONAIG loginTimeoutMs must be a positive number.');

  // Perspective warping remains experimental; similarity is the standard path.
  if (typeof normalizePose !== 'boolean') throw new TypeError('ONAIG normalizePose must be a boolean.');

  rootElement.replaceChildren();
  rootElement.classList.add('onaig-root');
  const video = document.createElement('video');
  video.className = 'onaig-video';
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  const landmarkCanvas = document.createElement('canvas');
  landmarkCanvas.className = 'onaig-landmark-canvas';
  landmarkCanvas.hidden = landmark === 'live';
  video.hidden = landmark !== 'live';
  rootElement.append(video, landmarkCanvas);
  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = 112;
  cropCanvas.height = 112;
  const context = (canvas: HTMLCanvasElement) => {
    const result = canvas.getContext('2d', { willReadFrequently: true });
    if (!result) throw new Error('A 2D canvas context is required.');
    return result;
  };
  const ctx = context(cropCanvas);
  const sourceCanvas = document.createElement('canvas');
  const sourceCtx = context(sourceCanvas);
  const landmarkCtx = context(landmarkCanvas);

  const listeners = new Map<keyof OnaigEvents, Set<(payload: unknown) => void>>();
  const on = <K extends keyof OnaigEvents>(event: K, listener: (payload: OnaigEvents[K]) => void) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    const callback = (payload: unknown) => listener(payload as OnaigEvents[K]);
    listeners.get(event)?.add(callback);
    return () => listeners.get(event)?.delete(callback);
  };
  const emit = <K extends keyof OnaigEvents>(event: K, payload: OnaigEvents[K]) => {
    listeners.get(event)?.forEach((listener) => {
      listener(payload);
    });
  };

  let stream: MediaStream | null = null;
  let cameraPermission: PermissionStatus | null = null;
  let permissionWatchStarted = false;
  let cameraAutoStart = true;
  let removeCameraPermissionWatch = () => {};
  let landmarker: FaceLandmarker | null = null;
  let session: ort.InferenceSession | null = null;
  let raf = 0;
  let startPromise: Promise<boolean> | null = null;
  let startCameraId = 0;
  let poseBusy = false,
    embeddingBusy = false,
    registrationBusy = false;
  let lastVideoTime = -1,
    lastPoseAt = 0,
    lastEmbeddingAt = 0,
    processingEpoch = 0;
  let mode: 'idle' | 'register' | 'login' = 'idle';
  let landmarkMode = landmark;
  let challenge: Pose | 'calibrate' = 'up';
  let poseIndex = 0;
  let poseSamples: PreparedFace[] = [],
    registeredVectors: number[][] = [];
  let pitchBaseline: number | null = null,
    yawBaseline: number | null = null;
  let pitchCalibration: number[] = [],
    yawCalibration: number[] = [],
    neutralStableFrames = 0;
  let registerPromise: Promise<Enrollment> | null = null;
  let resolveRegister: ((result: Enrollment) => void) | null = null;
  let rejectRegister: ((error: unknown) => void) | null = null;
  let registerRunId = 0;
  let loginRunId = 0,
    cameraRunId = 0;
  let loginPromise: Promise<AuthResult> | null = null;
  let resolveLogin: ((result: AuthResult) => void) | null = null;
  let rejectLogin: ((error: unknown) => void) | null = null;
  let loginAuthenticated = false;
  let loginAuthResult: AuthResult | null = null;
  let loginTimer: ReturnType<typeof setTimeout> | null = null;
  let loginChallenges: Exclude<Pose, 'center'>[] = [];
  let loginPitchBaseline: number | null = null,
    loginYawBaseline: number | null = null;
  let loginPitchCalibration: number[] = [],
    loginYawCalibration: number[] = [];
  let loginMatchFrames = 0,
    frameRevision = 0;
  let previousCalibrationPose: [number, number] | null = null;
  let guidancePending = false;
  let loginStage: 'idle' | 'calibrate' | 'challenge' | 'return' | 'complete' = 'idle';
  let loginChallengeIndex = 0,
    loginStableFrames = 0,
    loginLivenessPassed = false;

  const connections = {
    mesh: FaceLandmarker.FACE_LANDMARKS_TESSELATION || [],
    contours: FaceLandmarker.FACE_LANDMARKS_CONTOURS || [
      ...(FaceLandmarker.FACE_LANDMARKS_FACE_OVAL || []),
      ...(FaceLandmarker.FACE_LANDMARKS_LEFT_EYE || []),
      ...(FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE || []),
      ...(FaceLandmarker.FACE_LANDMARKS_LEFT_EYEBROW || []),
      ...(FaceLandmarker.FACE_LANDMARKS_RIGHT_EYEBROW || []),
      ...(FaceLandmarker.FACE_LANDMARKS_LIPS || []),
    ],
  };
  const contourIndexes = new Set(connections.contours.flatMap(({ start, end }) => [start, end]));

  function clearLandmarks() {
    landmarkCtx.clearRect(0, 0, landmarkCanvas.width, landmarkCanvas.height);
    if (landmarkMode !== 'live') {
      landmarkCtx.fillStyle = '#000';
      landmarkCtx.fillRect(0, 0, landmarkCanvas.width, landmarkCanvas.height);
    }
  }
  function setLandmark(next: LandmarkMode) {
    if (!landmarkModes.has(next)) throw new TypeError("ONAIG landmark must be 'live', 'mesh' or 'contours'.");
    landmarkMode = next;
    video.hidden = next !== 'live';
    landmarkCanvas.hidden = next === 'live';
    clearLandmarks();
    emit('landmark', { mode: next });
  }
  function resizeCanvas() {
    if (!video.videoWidth || !video.videoHeight) return;
    landmarkCanvas.width = video.videoWidth;
    landmarkCanvas.height = video.videoHeight;
    clearLandmarks();
  }
  function drawLandmarks(points: Point[]) {
    if (landmarkMode === 'live' || !points || !landmarkCanvas.width) return;
    clearLandmarks();
    const mesh = landmarkMode === 'mesh',
      lines = mesh ? connections.mesh : connections.contours;
    landmarkCtx.strokeStyle = '#39ff88';
    landmarkCtx.fillStyle = '#39ff88';
    landmarkCtx.lineWidth = mesh ? 1.15 : 1.8;
    landmarkCtx.globalAlpha = mesh ? 0.72 : 0.95;
    landmarkCtx.beginPath();
    lines.forEach(({ start, end }) => {
      const from = points[start],
        to = points[end];
      if (from && to) {
        landmarkCtx.moveTo(from.x * landmarkCanvas.width, from.y * landmarkCanvas.height);
        landmarkCtx.lineTo(to.x * landmarkCanvas.width, to.y * landmarkCanvas.height);
      }
    });
    landmarkCtx.stroke();
    landmarkCtx.globalAlpha = 1;
    for (const index of mesh ? points.keys() : contourIndexes) {
      const point = points[index];
      if (!point) continue;
      landmarkCtx.beginPath();
      landmarkCtx.arc(point.x * landmarkCanvas.width, point.y * landmarkCanvas.height, mesh ? 1.5 : 2.2, 0, Math.PI * 2);
      landmarkCtx.fill();
    }
  }
  function faceIsFramed(points: Point[]) {
    if (points.length < 455 || !points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return false;
    let minX = 1,
      maxX = 0,
      minY = 1,
      maxY = 0;
    for (const point of points) {
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y);
      maxY = Math.max(maxY, point.y);
    }
    return minX >= FACE_FRAME_MARGIN && maxX <= 1 - FACE_FRAME_MARGIN && minY >= FACE_FRAME_MARGIN && maxY <= 1 - FACE_FRAME_MARGIN;
  }
  function solveLinearSystem(matrix: number[][], vector: number[]) {
    const augmented = matrix.map((row, index) => [...row, vector[index]]);
    for (let column = 0; column < vector.length; column += 1) {
      let pivot = column;
      for (let row = column + 1; row < augmented.length; row += 1) {
        if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
      }
      if (Math.abs(augmented[pivot][column]) < 1e-8) return null;
      [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
      const divisor = augmented[column][column];
      for (let index = column; index <= vector.length; index += 1) augmented[column][index] /= divisor;
      for (let row = 0; row < augmented.length; row += 1) {
        if (row === column) continue;
        const factor = augmented[row][column];
        for (let index = column; index <= vector.length; index += 1) augmented[row][index] -= factor * augmented[column][index];
      }
    }
    return augmented.map((row) => row[vector.length]);
  }

  function homographyFromFourPoints(source: XY[], target: XY[]) {
    const matrix: number[][] = [],
      vector: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      const [x, y] = source[index],
        [u, v] = target[index];
      matrix.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
      vector.push(u);
      matrix.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
      vector.push(v);
    }
    const solution = solveLinearSystem(matrix, vector);
    return solution ? [...solution, 1] : null;
  }

  function cropAlignedPerspective(points: Point[], pixels: Uint8ClampedArray): Transform | null {
    const source: XY[] = [33, 263, 61, 291].map((index) => [points[index].x * video.videoWidth, points[index].y * video.videoHeight]);
    const target: XY[] = [
      [38.2946, 51.6963],
      [73.5318, 51.5014],
      [41.5493, 92.3655],
      [70.7299, 92.2041],
    ];
    const homography = homographyFromFourPoints(source, target);
    if (!homography?.every(Number.isFinite)) return null;
    const [h00, h01, h02, h10, h11, h12, h20, h21, h22] = homography;
    const determinant = h00 * (h11 * h22 - h12 * h21) - h01 * (h10 * h22 - h12 * h20) + h02 * (h10 * h21 - h11 * h20);
    if (Math.abs(determinant) < 1e-8) return null;
    const transform: Transform = ([x, y]) => {
      const d = h20 * x + h21 * y + h22;
      if (Math.abs(d) < 1e-8) return null;
      const result: XY = [(h00 * x + h01 * y + h02) / d, (h10 * x + h11 * y + h12) / d];
      return result.every(Number.isFinite) ? result : null;
    };
    const oval = FACE_OVAL.map((i) => transform([points[i].x * video.videoWidth, points[i].y * video.videoHeight]));
    if (oval.some((p) => !p || Math.abs(p[0]) > 224 || Math.abs(p[1]) > 224)) return null;
    const i00 = (h11 * h22 - h12 * h21) / determinant,
      i01 = (h02 * h21 - h01 * h22) / determinant,
      i02 = (h01 * h12 - h02 * h11) / determinant,
      i10 = (h12 * h20 - h10 * h22) / determinant,
      i11 = (h00 * h22 - h02 * h20) / determinant,
      i12 = (h02 * h10 - h00 * h12) / determinant,
      i20 = (h10 * h21 - h11 * h20) / determinant,
      i21 = (h01 * h20 - h00 * h21) / determinant,
      i22 = (h00 * h11 - h01 * h10) / determinant;
    const output = ctx.createImageData(112, 112);
    for (let y = 0; y < 112; y += 1) {
      for (let x = 0; x < 112; x += 1) {
        // Invert the destination -> source mapping numerically from the
        // source -> destination homography. This keeps the crop independent
        // of the camera's position and handles perspective better than the
        // original affine transform.
        const denominator = i20 * x + i21 * y + i22;
        const sourceX = (i00 * x + i01 * y + i02) / denominator;
        const sourceY = (i10 * x + i11 * y + i12) / denominator;
        const outputIndex = (y * 112 + x) * 4;
        if (
          !Number.isFinite(sourceX) ||
          !Number.isFinite(sourceY) ||
          Math.abs(denominator) < 1e-8 ||
          sourceX < 0 ||
          sourceY < 0 ||
          sourceX >= sourceCanvas.width - 1 ||
          sourceY >= sourceCanvas.height - 1
        ) {
          continue;
        }
        const left = Math.floor(sourceX),
          top = Math.floor(sourceY),
          dx = sourceX - left,
          dy = sourceY - top;
        for (let channel = 0; channel < 3; channel += 1) {
          const topLeft = pixels[(top * sourceCanvas.width + left) * 4 + channel],
            topRight = pixels[(top * sourceCanvas.width + left + 1) * 4 + channel],
            bottomLeft = pixels[((top + 1) * sourceCanvas.width + left) * 4 + channel],
            bottomRight = pixels[((top + 1) * sourceCanvas.width + left + 1) * 4 + channel];
          output.data[outputIndex + channel] = topLeft * (1 - dx) * (1 - dy) + topRight * dx * (1 - dy) + bottomLeft * (1 - dx) * dy + bottomRight * dx * dy;
        }
        output.data[outputIndex + 3] = 255;
      }
    }
    ctx.putImageData(output, 0, 0);
    return transform;
  }

  function maskedSourcePixels(points: Point[]): Uint8ClampedArray | null {
    const width = video.videoWidth,
      height = video.videoHeight;
    const polygon: XY[] = FACE_OVAL.map((i) => [points[i].x * width, points[i].y * height]);
    // Do not turn missing face pixels into an apparently complete gray crop.
    if (polygon.some(([x, y]) => x < 0 || y < 0 || x >= width || y >= height)) return null;
    const weights = rasterFaceMask(insetFacePolygon(polygon, SOURCE_FACE_SCALE), width, height, 0, 1);
    if (!weights) return null;
    if (sourceCanvas.width !== width || sourceCanvas.height !== height) {
      sourceCanvas.width = width;
      sourceCanvas.height = height;
    }
    sourceCtx.clearRect(0, 0, width, height);
    sourceCtx.drawImage(video, 0, 0);
    const image = sourceCtx.getImageData(0, 0, width, height);
    for (let i = 0; i < weights.length; i++) {
      const j = i * 4;
      if (weights[i]) {
        if (image.data[j + 3] !== 255) return null;
      } else {
        image.data[j] = image.data[j + 1] = image.data[j + 2] = 128;
        image.data[j + 3] = 255;
      }
    }
    sourceCtx.putImageData(image, 0, 0);
    return image.data;
  }

  function cropAligned(points: Point[], pixels: Uint8ClampedArray): Transform | null {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, 112, 112);
    if (normalizePose) {
      const perspective = cropAlignedPerspective(points, pixels);
      if (perspective) return perspective;
    }
    const src: XY[] = [33, 263, 1, 61, 291].map((i) => [points[i].x * video.videoWidth, points[i].y * video.videoHeight]);
    const a = solveSimilarity(src, FACE_TARGET);
    if (!a) return null;
    ctx.setTransform(a[0], a[3], a[1], a[4], a[2], a[5]);
    ctx.drawImage(sourceCanvas, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return ([x, y]) => [a[0] * x + a[1] * y + a[2], a[3] * x + a[4] * y + a[5]];
  }
  function alignedPixels(points: Point[]): PreparedFace | null {
    const pixels = maskedSourcePixels(points);
    if (!pixels) return null;
    const transform = cropAligned(points, pixels);
    if (!transform) return null;
    const polygon = FACE_OVAL.map((i) => transform([points[i].x * video.videoWidth, points[i].y * video.videoHeight]));
    if (polygon.some((p) => !p)) return null;
    const weights = faceMask(insetFacePolygon(polygon as XY[], EMBEDDING_FACE_SCALE));
    if (!weights) return null;
    return { image: new Uint8ClampedArray(ctx.getImageData(0, 0, 112, 112).data), weights };
  }
  async function embeddingFromPixels(face: PreparedFace, grayscale = false) {
    const normalizedImage = normalizeFacePixels(face.image, face.weights, grayscale);
    if (!normalizedImage) throw new Error('Face image is not usable.');
    if (!session) throw new Error('Face model is not ready.');
    const input = new Float32Array(112 * 112 * 3);
    for (let i = 0; i < 112 * 112; i += 1) {
      input[i * 3] = (normalizedImage[i * 4] - 127.5) / 127.5;
      input[i * 3 + 1] = (normalizedImage[i * 4 + 1] - 127.5) / 127.5;
      input[i * 3 + 2] = (normalizedImage[i * 4 + 2] - 127.5) / 127.5;
    }
    const output = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 112, 112, 3]) });
    const raw = output[session.outputNames[0]].data,
      norm = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0));
    if (raw.length !== 512 || !Number.isFinite(norm) || norm < 1e-8) throw new Error('Invalid face embedding.');
    return Array.from(raw, (value) => value / norm);
  }
  async function embeddingVariantsFromPixels(image: PreparedFace, current: () => boolean) {
    const primary = await embeddingFromPixels(image);
    if (!current()) return null;
    // Only use the grayscale representation as a fallback/template. It is
    // useful for strong color casts (warm doors, colored walls, backlight),
    // while the primary RGB representation preserves normal face detail.
    const grayscale = await embeddingFromPixels(image, true);
    if (!current()) return null;
    return [primary, grayscale];
  }
  async function initModels() {
    if (landmarker && session) return;
    emit('state', { type: 'loading' });
    const vision = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm');
    landmarker = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetBuffer: new Uint8Array(await cachedAssetBuffer(MP_MODEL_URL)), delegate: 'CPU' },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFacialTransformationMatrixes: true,
    });
    ort.env.wasm.numThreads = 1;
    session = await ort.InferenceSession.create(await cachedAssetBuffer(MODEL_URL), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  }
  async function startCamera() {
    cameraAutoStart = true;
    if (stream) return true;
    if (startPromise) return startCameraId === cameraRunId ? startPromise : startPromise.then(() => startCamera());
    const cameraId = cameraRunId;
    startCameraId = cameraId;
    startPromise = (async () => {
      try {
        await initModels();
        if (cameraId !== cameraRunId) return false;
        let acquired: MediaStream;
        try {
          acquired = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'user' }, width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
        } catch (error) {
          if (!(error instanceof Error) || error.name !== 'NotReadableError') throw error;
          if (cameraId !== cameraRunId) return false;
          acquired = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        }
        if (cameraId !== cameraRunId) {
          acquired.getTracks().forEach((track) => {
            track.stop();
          });
          return false;
        }
        stream = acquired;
        const handleTrackEnded = () => {
          if (stream !== acquired || !cameraAutoStart) return;
          cancelAnimationFrame(raf);
          processingEpoch += 1;
          stream = null;
          video.srcObject = null;
          restartCameraIfAllowed();
        };
        acquired.getVideoTracks().forEach((track) => {
          track.addEventListener('ended', handleTrackEnded, { once: true });
        });
        video.srcObject = stream;
        await video.play();
        if (cameraId !== cameraRunId) return false;
        processingEpoch += 1;
        lastPoseAt = 0;
        lastEmbeddingAt = 0;
        resizeCanvas();
        emit('state', { type: 'camera-ready', video });
        loop();
        return true;
      } catch (error) {
        emit('error', error);
        return false;
      } finally {
        startPromise = null;
      }
    })();
    return startPromise;
  }
  async function cameraPermissionState() {
    if (!('permissions' in navigator)) return null;
    try {
      if (!cameraPermission) cameraPermission = await navigator.permissions.query({ name: 'camera' as PermissionName });
      return cameraPermission.state;
    } catch {
      // Some browsers expose getUserMedia but not a queryable camera permission.
      return null;
    }
  }
  function restartCameraIfAllowed() {
    if (!cameraAutoStart || stream || startPromise) return;
    void cameraPermissionState().then((state) => {
      if (state !== 'denied') void startCamera();
    });
  }
  function watchCameraPermission() {
    if (permissionWatchStarted) return;
    permissionWatchStarted = true;
    void cameraPermissionState().then(() => {
      if (!cameraPermission) return;
      cameraPermission.onchange = () => {
        if (cameraPermission?.state === 'granted' || cameraPermission?.state === 'prompt') restartCameraIfAllowed();
      };
    });
    // Permission changes made in browser/app settings are not surfaced by all
    // browsers through PermissionStatus.onchange.
    const retry = () => restartCameraIfAllowed();
    window.addEventListener('focus', retry);
    document.addEventListener('visibilitychange', retry);
    removeCameraPermissionWatch = () => {
      window.removeEventListener('focus', retry);
      document.removeEventListener('visibilitychange', retry);
      if (cameraPermission) cameraPermission.onchange = null;
    };
  }
  function stop() {
    cameraAutoStart = false;
    cancelAnimationFrame(raf);
    processingEpoch += 1;
    registerRunId += 1;
    loginRunId += 1;
    cameraRunId += 1;
    stream?.getTracks().forEach((track) => {
      track.stop();
    });
    stream = null;
    video.srcObject = null;
    mode = 'idle';
    loginAuthenticated = false;
    if (loginTimer !== null) clearTimeout(loginTimer);
    loginTimer = null;
    loginAuthResult = null;
    loginChallenges = [];
    loginChallengeIndex = 0;
    loginStage = 'idle';
    loginStableFrames = 0;
    loginPitchBaseline = null;
    loginYawBaseline = null;
    loginPitchCalibration = [];
    loginYawCalibration = [];
    loginMatchFrames = 0;
    previousCalibrationPose = null;
    loginLivenessPassed = false;
    poseBusy = false;
    embeddingBusy = false;
    registrationBusy = false;
    clearLandmarks();
    const error = new DOMException('ONAIG stopped.', 'AbortError');
    rejectRegister?.(error);
    rejectLogin?.(error);
    registerPromise = null;
    loginPromise = null;
    resolveRegister = null;
    rejectRegister = null;
    resolveLogin = null;
    rejectLogin = null;
    emit('state', { type: 'stopped' });
  }
  const poseValid = (points: Point[], roll: number) => faceIsFramed(points) && Math.abs(roll) <= MAX_ROLL_DEGREES;
  const loginNeutral = (points: Point[], yaw: number, pitch: number, roll: number) =>
    poseValid(points, roll) &&
    loginYawBaseline !== null &&
    Math.abs(yaw - loginYawBaseline) <= NEUTRAL_YAW_TOLERANCE &&
    loginPitchBaseline !== null &&
    Math.abs(pitch - loginPitchBaseline) < 0.05;
  const loginChallengeReached = (challenge: Pose, yaw: number, pitch: number) => {
    if (loginPitchBaseline === null || loginYawBaseline === null) return false;
    const delta = pitch - loginPitchBaseline;
    const yawDelta = yaw - loginYawBaseline;
    return { up: delta < -0.08, down: delta > 0.08, left: yawDelta > 0.16, right: yawDelta < -0.16, center: false }[challenge] === true;
  };
  const shuffle = <T>(values: T[]) => {
    const shuffled = [...values];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const randomIndex = Math.floor(Math.random() * (index + 1));
      [shuffled[index], shuffled[randomIndex]] = [shuffled[randomIndex], shuffled[index]];
    }
    return shuffled;
  };
  const clearLoginTimer = () => {
    if (loginTimer !== null) clearTimeout(loginTimer);
    loginTimer = null;
  };
  const abortRegistration = () => {
    if (!registerPromise) return;
    processingEpoch += 1;
    rejectRegister?.(new DOMException('Registration restarted.', 'AbortError'));
    registerPromise = null;
    resolveRegister = null;
    rejectRegister = null;
    mode = 'idle';
  };
  const resetLoginState = () => {
    clearLoginTimer();
    loginAuthenticated = false;
    loginAuthResult = null;
    loginChallenges = [];
    loginChallengeIndex = 0;
    loginStage = 'idle';
    loginStableFrames = 0;
    loginPitchBaseline = null;
    loginYawBaseline = null;
    loginPitchCalibration = [];
    loginYawCalibration = [];
    loginMatchFrames = 0;
    previousCalibrationPose = null;
    loginLivenessPassed = false;
  };
  const finishLoginIfReady = () => {
    if (!loginAuthenticated || !loginAuthResult || !loginLivenessPassed || !loginPromise) return;
    const result = { ...loginAuthResult, matched: true as const };
    mode = 'idle';
    clearLoginTimer();
    resolveLogin?.(result);
    loginPromise = null;
    resolveLogin = null;
    rejectLogin = null;
    emit('state', { type: 'login-success', result });
  };
  const rejectLoginFlow = (error: unknown, state: 'login-error' | 'login-timeout' = 'login-error') => {
    if (!loginPromise) return;
    processingEpoch += 1;
    mode = 'idle';
    clearLoginTimer();
    rejectLogin?.(error);
    loginPromise = null;
    resolveLogin = null;
    rejectLogin = null;
    emit('state', { type: state, error });
    resetLoginState();
  };
  function calibrationStable(yaw: number, pitch: number) {
    const stable =
      Math.abs(yaw) <= 0.35 && (!previousCalibrationPose || (Math.abs(yaw - previousCalibrationPose[0]) < 0.025 && Math.abs(pitch - previousCalibrationPose[1]) < 0.025));
    previousCalibrationPose = [yaw, pitch];
    return stable;
  }
  function invalidateFrame(guidance: Guidance = 'pose', lostFace = false) {
    frameRevision += 1;
    loginMatchFrames = 0;
    loginAuthenticated = false;
    loginAuthResult = null;
    poseSamples = [];
    neutralStableFrames = 0;
    pitchCalibration = [];
    yawCalibration = [];
    loginStableFrames = 0;
    loginPitchCalibration = [];
    loginYawCalibration = [];
    previousCalibrationPose = null;
    guidancePending = true;
    if (lostFace && mode === 'login') {
      loginLivenessPassed = false;
      loginStage = 'calibrate';
      loginChallengeIndex = 0;
      loginYawBaseline = null;
      loginPitchBaseline = null;
    }
    if (mode === 'register' || mode === 'login') emit('state', { type: mode === 'register' ? 'register-guidance' : 'login-guidance', guidance });
  }
  function prepareFace(points: Point[], roll: number): PreparedFace | null {
    if (!poseValid(points, roll)) {
      invalidateFrame('pose');
      return null;
    }
    const eyeDistance = Math.hypot((points[263].x - points[33].x) * video.videoWidth, (points[263].y - points[33].y) * video.videoHeight);
    if (eyeDistance < 24) {
      invalidateFrame('distance');
      return null;
    }
    const face = alignedPixels(points);
    if (!face || face.weights.some((w, i) => w > 0 && face.image[i * 4 + 3] !== 255)) {
      invalidateFrame('pose');
      return null;
    }
    if (!normalizeFacePixels(face.image, face.weights)) {
      invalidateFrame('light');
      return null;
    }
    return face;
  }
  function loginLivenessFrame(points: Point[], yaw: number, pitch: number, roll: number, epoch: number) {
    if (epoch !== processingEpoch || mode !== 'login' || loginLivenessPassed) return;
    if (loginStage === 'calibrate') {
      if (!poseValid(points, roll) || !calibrationStable(yaw, pitch)) {
        loginStableFrames = 0;
        loginPitchCalibration = [];
        loginYawCalibration = [];
        emit('state', { type: 'login-guidance', guidance: 'center' });
        return;
      }
      loginStableFrames += 1;
      loginPitchCalibration.push(pitch);
      loginYawCalibration.push(yaw);
      emit('state', { type: 'login-guidance', guidance: 'hold' });
      if (loginStableFrames < NEUTRAL_STABLE_FRAMES || loginPitchCalibration.length < PITCH_CALIBRATION_COUNT) return;
      const sorted = [...loginPitchCalibration].sort((a, b) => a - b);
      loginPitchBaseline = sorted[Math.floor(sorted.length / 2)];
      loginYawBaseline = [...loginYawCalibration].sort((a, b) => a - b)[Math.floor(loginYawCalibration.length / 2)];
      loginPitchCalibration = [];
      loginYawCalibration = [];
      loginStableFrames = 0;
      loginStage = 'challenge';
      emit('state', { type: 'login-challenge', challenge: loginChallenges[loginChallengeIndex], index: loginChallengeIndex, total: LOGIN_CHALLENGE_COUNT });
      return;
    }
    const challenge = loginChallenges[loginChallengeIndex];
    if (loginStage === 'challenge') {
      if (!poseValid(points, roll)) {
        loginStableFrames = 0;
        return;
      }
      loginStableFrames = loginChallengeReached(challenge, yaw, pitch) ? loginStableFrames + 1 : 0;
      emit('state', { type: 'login-challenge-progress', challenge, index: loginChallengeIndex, stableFrames: loginStableFrames, requiredFrames: LOGIN_STABLE_FRAMES });
      if (loginStableFrames < LOGIN_STABLE_FRAMES) return;
      loginStableFrames = 0;
      loginStage = 'return';
      emit('state', { type: 'login-center', index: loginChallengeIndex, total: LOGIN_CHALLENGE_COUNT });
      return;
    }
    if (loginStage === 'return') {
      loginStableFrames = loginNeutral(points, yaw, pitch, roll) ? loginStableFrames + 1 : 0;
      if (loginStableFrames < NEUTRAL_STABLE_FRAMES) return;
      loginStableFrames = 0;
      loginChallengeIndex += 1;
      if (loginChallengeIndex >= LOGIN_CHALLENGE_COUNT) {
        loginLivenessPassed = true;
        loginStage = 'complete';
        emit('state', { type: 'login-liveness-success' });
        finishLoginIfReady();
        return;
      }
      loginStage = 'challenge';
      emit('state', { type: 'login-challenge', challenge: loginChallenges[loginChallengeIndex], index: loginChallengeIndex, total: LOGIN_CHALLENGE_COUNT });
    }
  }
  async function registerFrame(points: Point[], yaw: number, pitch: number, roll: number, epoch: number, face: PreparedFace) {
    if (epoch !== processingEpoch || registrationBusy) return;
    if (challenge === 'calibrate') {
      if (!calibrationStable(yaw, pitch)) {
        neutralStableFrames = 0;
        pitchCalibration = [];
        yawCalibration = [];
        emit('state', { type: 'register-guidance', guidance: 'center' });
        return;
      }
      neutralStableFrames += 1;
      pitchCalibration.push(pitch);
      yawCalibration.push(yaw);
      emit('state', { type: 'register-guidance', guidance: 'hold' });
      if (neutralStableFrames < NEUTRAL_STABLE_FRAMES || pitchCalibration.length < PITCH_CALIBRATION_COUNT) return;
      const sorted = [...pitchCalibration].sort((a, b) => a - b);
      pitchBaseline = sorted[Math.floor(sorted.length / 2)];
      yawBaseline = [...yawCalibration].sort((a, b) => a - b)[Math.floor(yawCalibration.length / 2)];
      pitchCalibration = [];
      yawCalibration = [];
      neutralStableFrames = 0;
      poseIndex = 0;
      challenge = POSES[poseIndex];
      emit('state', { type: 'challenge', challenge });
      return;
    }
    if (!poseValid(points, roll) || pitchBaseline === null || yawBaseline === null) {
      poseSamples = [];
      return;
    }
    const delta = pitch - pitchBaseline,
      yawDelta = yaw - yawBaseline,
      reached = {
        up: delta < -POSE_PITCH_THRESHOLD,
        down: delta > POSE_PITCH_THRESHOLD,
        left: yawDelta > POSE_YAW_THRESHOLD,
        right: yawDelta < -POSE_YAW_THRESHOLD,
        center: Math.abs(yawDelta) < 0.08 && Math.abs(delta) < POSE_PITCH_THRESHOLD,
      }[challenge];
    if (!reached) {
      poseSamples = [];
      return;
    }
    poseSamples.push(face);
    if (poseSamples.length < POSE_SAMPLE_COUNT) return;
    registrationBusy = true;
    try {
      const vectors: number[][] = [],
        grayscaleVectors: number[][] = [];
      const current = () => epoch === processingEpoch && mode === 'register';
      for (const pixels of poseSamples) {
        const variants = await embeddingVariantsFromPixels(pixels, current);
        if (!variants) return;
        const [vector, grayscaleVector] = variants;
        vectors.push(vector);
        grayscaleVectors.push(grayscaleVector);
      }
      if (!current()) return;
      registeredVectors.push(averageVector(vectors), averageVector(grayscaleVectors));
      poseSamples = [];
      poseIndex += 1;
      emit('state', { type: 'register-progress', completed: poseIndex, total: POSES.length, challenge });
      if (poseIndex >= POSES.length) {
        const enrollment = await auth.enroll(registeredVectors);
        if (!current()) return;
        mode = 'idle';
        const result = { ...enrollment, embeddings: registeredVectors, count: registeredVectors.length };
        resolveRegister?.(result);
        registerPromise = null;
        resolveRegister = null;
        rejectRegister = null;
        emit('state', { type: 'register-success', result });
      } else {
        challenge = POSES[poseIndex];
        emit('state', { type: 'challenge', challenge });
      }
    } catch (error) {
      if (epoch !== processingEpoch) return;
      mode = 'idle';
      rejectRegister?.(error);
      registerPromise = null;
      resolveRegister = null;
      rejectRegister = null;
      emit('error', error);
    } finally {
      if (epoch === processingEpoch) registrationBusy = false;
    }
  }
  async function loginFrame(face: PreparedFace, epoch: number, revision: number) {
    const current = () => epoch === processingEpoch && revision === frameRevision && mode === 'login';
    const vectors = await embeddingVariantsFromPixels(face, current);
    if (!vectors || !current()) return;
    const results: AuthResult[] = [];
    for (const vector of vectors) {
      const result = await auth.authenticate(vector);
      if (!current()) return;
      results.push({ ...result, vector });
      if (result.authenticated === true) break;
    }
    const result = selectAuthResult(results);
    const matched = result.authenticated === true;
    const score = Number.isFinite(result.score) ? result.score : undefined;
    emit('login-progress', { matched, score });
    emit('state', { type: 'login-check', matched });
    loginMatchFrames = matched ? loginMatchFrames + 1 : 0;
    if (!matched) {
      loginAuthenticated = false;
      loginAuthResult = null;
      return;
    }
    if (loginMatchFrames < LOGIN_STABLE_FRAMES) return;
    loginAuthenticated = true;
    loginAuthResult = { ...result, matched: true };
    finishLoginIfReady();
  }
  async function loop() {
    if (!stream) return;
    raf = requestAnimationFrame(loop);
    if (poseBusy || video.readyState < 2 || video.currentTime === lastVideoTime) return;
    const now = performance.now();
    if (now - lastPoseAt < POSE_INTERVAL_MS) return;
    lastPoseAt = now;
    lastVideoTime = video.currentTime;
    poseBusy = true;
    const epoch = processingEpoch;
    try {
      const points = landmarker?.detectForVideo(video, now).faceLandmarks?.[0];
      if (!points) {
        clearLandmarks();
        invalidateFrame('pose', true);
        emit('state', { type: 'no-face' });
        return;
      }
      if (!faceIsFramed(points)) {
        invalidateFrame();
        return;
      }
      drawLandmarks(points);
      const diagnostics = { ...faceDiagnostics(points, video.videoWidth, video.videoHeight), landmarks: points };
      emit('frame', diagnostics);
      if (mode === 'idle') return;
      const face = prepareFace(points, diagnostics.roll);
      if (!face) return;
      if (guidancePending) {
        guidancePending = false;
        if (mode === 'register' && challenge !== 'calibrate') emit('state', { type: 'challenge', challenge });
        if (mode === 'login' && loginStage === 'challenge')
          emit('state', { type: 'login-challenge', challenge: loginChallenges[loginChallengeIndex], index: loginChallengeIndex, total: LOGIN_CHALLENGE_COUNT });
        if (mode === 'login' && (loginStage === 'return' || loginStage === 'complete'))
          emit('state', { type: 'login-center', index: loginChallengeIndex, total: LOGIN_CHALLENGE_COUNT });
      }
      if (mode === 'register') await registerFrame(points, diagnostics.yaw, diagnostics.pitch, diagnostics.roll, epoch, face);
      if (mode === 'login') loginLivenessFrame(points, diagnostics.yaw, diagnostics.pitch, diagnostics.roll, epoch);
      if (mode === 'login' && !embeddingBusy && now - lastEmbeddingAt >= EMBEDDING_INTERVAL_MS) {
        embeddingBusy = true;
        lastEmbeddingAt = now;
        const revision = frameRevision;
        void loginFrame(face, epoch, revision)
          .catch((error) => {
            if (epoch !== processingEpoch || revision !== frameRevision) return;
            rejectLoginFlow(error);
            emit('error', error);
          })
          .finally(() => {
            if (epoch === processingEpoch) embeddingBusy = false;
          });
      }
    } catch (error) {
      emit('error', error);
    } finally {
      poseBusy = false;
    }
  }
  function register() {
    if (registerPromise) abortRegistration();
    if (loginPromise) {
      loginRunId += 1;
      rejectLoginFlow(new DOMException('Registration started.', 'AbortError'));
    }
    processingEpoch += 1;
    registrationBusy = false;
    embeddingBusy = false;
    const runId = ++registerRunId;
    const promise = new Promise<Enrollment>((resolve, reject) => {
      resolveRegister = resolve;
      rejectRegister = reject;
    });
    registerPromise = promise;
    void startCamera().then((ready) => {
      if (runId !== registerRunId) return;
      if (!ready) {
        rejectRegister?.(new Error('Camera could not be started.'));
        registerPromise = null;
        return;
      }
      mode = 'register';
      challenge = 'calibrate';
      poseIndex = 0;
      poseSamples = [];
      registeredVectors = [];
      pitchBaseline = null;
      yawBaseline = null;
      pitchCalibration = [];
      yawCalibration = [];
      previousCalibrationPose = null;
      neutralStableFrames = 0;
      emit('state', { type: 'register-start' });
    });
    return promise;
  }
  function login() {
    if (loginPromise) return loginPromise;
    if (registerPromise) {
      registerRunId += 1;
      abortRegistration();
    }
    processingEpoch += 1;
    registrationBusy = false;
    embeddingBusy = false;
    const runId = ++loginRunId;
    const promise = new Promise<AuthResult>((resolve, reject) => {
      resolveLogin = resolve;
      rejectLogin = reject;
    });
    loginPromise = promise;
    void startCamera().then((ready) => {
      if (runId !== loginRunId) return;
      if (!ready) {
        rejectLogin?.(new Error('Camera could not be started.'));
        loginPromise = null;
        return;
      }
      mode = 'login';
      resetLoginState();
      loginChallenges = shuffle<Exclude<Pose, 'center'>>(['up', 'down', 'left', 'right']).slice(0, LOGIN_CHALLENGE_COUNT);
      loginStage = 'calibrate';
      loginTimer = setTimeout(() => rejectLoginFlow(new DOMException('Liveness check timed out.', 'TimeoutError'), 'login-timeout'), loginTimeoutMs);
      emit('state', { type: 'login-start', challenges: loginChallenges, timeoutMs: loginTimeoutMs });
    });
    return promise;
  }
  async function hasEnrollment() {
    await startCamera();
    return typeof auth.hasEnrollment === 'function' ? auth.hasEnrollment() : true;
  }
  async function getEnrollment() {
    return typeof auth.getEnrollment === 'function' ? auth.getEnrollment() : null;
  }
  async function clearEnrollment() {
    await startCamera();
    if (typeof auth.forget !== 'function') throw new Error('This auth provider does not support forgetting enrollment.');
    await auth.forget();
  }
  function destroy() {
    stop();
    removeCameraPermissionWatch();
    listeners.clear();
    rootElement.replaceChildren();
  }
  video.addEventListener('loadedmetadata', resizeCanvas);
  watchCameraPermission();
  // Keep the public API name (`live`) aligned with the demo control's legacy value (`off`).
  document.querySelector('[data-landmark-mode="off"]')?.setAttribute('data-landmark-mode', 'live');
  void startCamera();
  return { register, login, hasEnrollment, getEnrollment, clearEnrollment, startCamera, stop, destroy, setLandmark, on, video, root: rootElement };
}

export default createOnaig;

