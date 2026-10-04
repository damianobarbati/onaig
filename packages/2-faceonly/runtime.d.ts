// Types for the pinned browser-only CDN modules used by this demo.
declare module 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/+esm' {
  type Connection = { start: number; end: number };
  export class FaceLandmarker {
    static FACE_LANDMARKS_TESSELATION: Connection[];
    static FACE_LANDMARKS_CONTOURS: Connection[];
    static FACE_LANDMARKS_FACE_OVAL: Connection[];
    static FACE_LANDMARKS_LEFT_EYE: Connection[];
    static FACE_LANDMARKS_RIGHT_EYE: Connection[];
    static FACE_LANDMARKS_LEFT_EYEBROW: Connection[];
    static FACE_LANDMARKS_RIGHT_EYEBROW: Connection[];
    static FACE_LANDMARKS_LIPS: Connection[];
    static createFromOptions(vision: unknown, options: unknown): Promise<FaceLandmarker>;
    detectForVideo(video: HTMLVideoElement, timestamp: number): { faceLandmarks: { x: number; y: number; z: number }[][] };
    close(): void;
  }
  export const FilesetResolver: { forVisionTasks(url: string): Promise<unknown> };
}
declare module 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/+esm' {
  export const env: { wasm: { numThreads: number } };
  export class Tensor {
    constructor(type: 'float32', data: Float32Array, dims: number[]);
    data: Float32Array;
  }
  export class InferenceSession {
    static create(buffer: ArrayBuffer, options: unknown): Promise<InferenceSession>;
    inputNames: string[];
    outputNames: string[];
    run(feeds: Record<string, Tensor>): Promise<Record<string, Tensor>>;
  }
}
