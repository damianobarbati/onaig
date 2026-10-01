# ONAIG

ONAIG is a JS library for enabling biometric authentication in web applications, implementing the ONAIG protocol.  

## Usage

The biometric logic is exposed through a UI-agnostic controller. The caller owns buttons, messages and result rendering.

```js
import createOnaig, { createHttpAuthProvider } from './onaig.ts';

const onaig = createOnaig({
  root: '#cameraRoot',
  landmark: 'live', // live | mesh | contours
  loginTimeoutMs: 5000,
});

await onaig.startCamera();

registerButton.addEventListener('click', async () => {
  console.log('registering...');
  const result = await onaig.register();
  console.log('registered:', result.id);
});

loginButton.addEventListener('click', async () => {
  console.log('logging in...');
  const result = await onaig.login();
  console.log('logged in:', result.id);
});

// event emitted with the latest similarity score, when the provider exposes it
onaig.on('login-progress', ({ matched, score }) => {
  console.log(matched ? 'match' : 'no match', score); // cosine similarity, not a probability
});

// diagnostics emitted for every detected frame
onaig.on('frame', ({ yaw, pitch, roll, landmarks }) => {
  console.log('yaw:', yaw, 'pitch:', pitch, 'roll:', roll);
});
```

`login()` runs the liveness check internally. It randomly asks for two different head movements from `up`, `down`, `left` and `right`, requiring the user to return to the center between movements. The promise resolves only after both movements and face authentication succeed. The default liveness timeout is 5 seconds and can be configured with `loginTimeoutMs`.

All acquisition, image preprocessing and vector comparison live in `onaig.ts`. `main.ts` only presents the controller's events and controls.

Both flows calibrate yaw and pitch against a stable starting pose in the current camera setup. Three consecutive valid samples are collected for each enrollment pose; login requires three consecutive successful comparisons as well as both liveness movements. Invalid frames, lost faces and failed comparisons reset the matching sequence.

The shared preprocessing uses a five-point similarity transform (translation, rotation and uniform scale), a landmark-derived mask inset to 90% before resampling, a feathered mask inset to 88% for the embedding, and exposure correction followed by bounded contrast correction (0.55–1.8×). The inward margins exclude background captured by slightly oversized detected contours. Background pixels are excluded from luminance statistics and replaced with neutral gray. RGB and grayscale templates are averaged and L2-normalized separately. The local similarity threshold remains `0.90`.

`register-guidance` and `login-guidance` state events expose `guidance`: `hold`, `center`, `distance`, `light`, or `pose`. Frames with less than 24 pixels between the eyes, a roll beyond 20 degrees, incomplete crops, or unusable exposure are skipped. Exposure checks use face-only mean luminance (25–230) and reject crops with more than 40% nearly black/white face pixels. These are acquisition defaults, not an accuracy guarantee.

The experimental `normalizePose: true` option enables a perspective crop. It is disabled by default and falls back to the similarity transform when its geometry is invalid. The default local enrollment key is `oath-face-demo-embedding-v5`. No compatibility path for old embeddings is provided; re-register after preprocessing changes. Custom storage keys and HTTP providers must also replace old templates.

## Verification

From the repository root, run `pnpm exec vitest run packages/1-faceonly`, `pnpm exec tsc`, and `pnpm --dir packages/1-faceonly build`. Browser tests start their own Vite server on the configured port 3001 (or the next available port). Controller tests use controlled detector/model/provider outputs; the app smoke test loads the real browser models. The real-model regression test also runs the full embedding pipeline with fresh detections on public OpenCV and MediaPipe photo fixtures: changed backgrounds, dimmer exposure, warmer light, and a different person as a negative control. It requires network access and checks repeated matches against averaged RGB/grayscale reference templates.

For a real-camera check, enroll once, then repeat login with the camera higher/lower or moderately lateral, at a different distance, with brighter/dimmer frontal lighting and with differently colored backgrounds. Test each variation separately and together, record similarity and successful/failed attempts, and repeat with a different person as a negative control. Extreme darkness, blown highlights and partially visible faces should produce guidance. Real-camera biometric accuracy must be assessed separately from the automated tests.

Use `onaig.stop()` to stop the camera and processing, and stop events.  
Use `onaig.destroy()` to remove the generated DOM and listeners.
