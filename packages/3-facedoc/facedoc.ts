import createOnaig, { type AuthProvider, type AuthResult, type Enrollment, type LandmarkMode, type OnaigOptions } from './onaig.ts';

export type PersonData = { firstName?: string; lastName?: string; birthDate?: string };
export type FaceDocResult = { matched: boolean; score?: number; person?: PersonData; warnings?: string[]; id?: string };

export type FaceDocProvider = AuthProvider & {
  enrollDocument(embeddings: number[][], documentImageBase64: string): Promise<FaceDocResult>;
};

export function captureVideoFrame(video: HTMLVideoElement, quality = 0.9): string {
  if (!video.videoWidth || !video.videoHeight) throw new Error('Camera frame is not ready.');
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Unable to capture camera frame.');
  context.translate(canvas.width, 0);
  context.scale(-1, 1);
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

export function createFaceDocHttpProvider({
  baseUrl = '',
  fetchImpl = globalThis.fetch,
  getDocumentImage,
  onResult,
}: {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  getDocumentImage: () => string;
  onResult?: (result: FaceDocResult) => void;
}): FaceDocProvider {
  if (typeof fetchImpl !== 'function') throw new TypeError('An HTTP provider requires fetch.');
  const apiBaseUrl = baseUrl.replace(/\/$/, '');
  const request = async (path: string, body?: unknown) => {
    const response = await fetchImpl(`${apiBaseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    let payload: FaceDocResult & { error?: string } = { matched: false };
    try {
      payload = await response.json();
    } catch {
      /* status is enough */
    }
    return { response, payload };
  };
  return {
    async enroll(embeddings) {
      return this.enrollDocument(embeddings, getDocumentImage());
    },
    async enrollDocument(embeddings, documentImageBase64) {
      const { response, payload } = await request('/enroll', { faces: embeddings, documentImageBase64 });
      if (!response.ok) throw new Error(payload.error || `Document enrollment failed (${response.status}).`);
      onResult?.(payload);
      return payload;
    },
    async authenticate(): Promise<AuthResult> {
      return { authenticated: false };
    },
  };
}

export type FaceDocOptions = Omit<OnaigOptions, 'auth'> & { auth: FaceDocProvider };

export default function createFaceDoc({ auth, ...options }: FaceDocOptions) {
  return createOnaig({ ...options, auth });
}

export type { AuthProvider, AuthResult, Enrollment, LandmarkMode };
