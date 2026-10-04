import createFaceDoc, { captureVideoFrame, createFaceDocHttpProvider, type PersonData } from './facedoc.ts';
import type { Guidance, LandmarkMode } from './onaig.ts';

const app = document.querySelector<HTMLElement>('#app');
if (!app) throw new Error('App root is missing.');

app.innerHTML = `<section class="app-shell gap-2"><header class="flex h-16 shrink-0 items-center"><h1 class="uppercase text-2xl font-bold tracking-tight text-cyan-400">ONAIG FaceDoc</h1></header><div class="video-card"><div data-ui="camera"></div><div data-ui="placeholder" class="absolute inset-0 grid place-items-center text-sm text-slate-500">Camera unavailable</div><div class="pointer-events-none absolute left-1/2 top-1/2 h-[68%] w-[45%] -translate-x-1/2 -translate-y-1/2 rounded-[45%] border border-cyan-300/60 shadow-[0_0_0_9999px_rgba(2,6,23,.28)]"></div><div class="pointer-events-none absolute bottom-5 right-5 rounded-2xl border border-amber-300/60 bg-slate-950/85 px-4 py-2 text-center text-xs text-amber-100 shadow-lg backdrop-blur">Tieni il documento<br>accanto al viso</div><div data-ui="challenge" class="absolute left-1/2 top-5 hidden -translate-x-1/2 rounded-2xl border border-cyan-300/50 bg-slate-950/85 px-4 py-2 text-sm text-cyan-100 shadow-lg"><span data-ui="challengeText">Starting...</span></div><div class="pointer-events-none absolute left-3 right-3 top-3 flex justify-between gap-3 text-xs"><div class="overlay-card px-3 py-2"><div>Yaw <span data-ui="yaw" class="mono text-cyan-300">—</span></div><div>Pitch <span data-ui="pitch" class="mono text-cyan-300">—</span></div><div>Threshold <span class="mono text-slate-300">90%</span></div></div><div class="rounded-full border border-white/10 bg-slate-950/75 px-3 py-2"><span data-ui="cameraStatus">Offline</span></div></div><div class="absolute right-3 top-[4.5rem] flex flex-col gap-1 rounded-2xl border border-white/10 bg-slate-950/80 p-1 text-xs"><button data-action="landmark" data-mode="live" class="landmark-button">Live</button><button data-action="landmark" data-mode="mesh" class="landmark-button">Mesh</button><button data-action="landmark" data-mode="contours" class="landmark-button">Contours</button></div></div><div class="flex w-full gap-2"><button data-action="register" class="action-button register-button" disabled>Register with document</button></div><div data-ui="result" class="hidden rounded-xl border border-emerald-700/60 bg-slate-950/90 px-4 py-3 text-sm text-emerald-300"></div><p data-ui="log" class="min-h-5 text-center text-xs text-slate-500" aria-live="polite"></p></section>`;

const ui = (key: string) => {
  const value = app.querySelector<HTMLElement>(`[data-ui="${key}"]`);
  if (!value) throw new Error(`Missing UI element: ${key}`);
  return value;
};
const button = app.querySelector<HTMLButtonElement>('[data-action="register"]');
if (!button) throw new Error('Register button is missing.');
let controller: ReturnType<typeof createFaceDoc>;
let latestResult: { matched?: boolean; person?: PersonData; score?: number } | undefined;
const provider = createFaceDocHttpProvider({
  baseUrl: 'http://localhost:3004',
  getDocumentImage: () => captureVideoFrame(controller.video),
  onResult: (result) => {
    latestResult = result;
  },
});
controller = createFaceDoc({ root: ui('camera'), landmark: 'live', loginTimeoutMs: 60_000, auth: provider });
const textFor = (g: Guidance) =>
  ({ hold: 'Hold still.', center: 'Look straight.', distance: 'Move closer.', light: 'Improve the lighting.', pose: 'Keep your face fully visible.' })[g];
const setLog = (message: string, error = false) => {
  ui('log').textContent = message;
  ui('log').className = `min-h-5 text-center text-xs ${error ? 'text-rose-400' : 'text-slate-500'}`;
};
const renderPerson = (person?: PersonData) =>
  person ? `Name: ${person.firstName ?? '—'} ${person.lastName ?? '—'}<br>Birth date: ${person.birthDate ?? '—'}` : 'No personal data extracted.';

controller.on('frame', ({ yaw, pitch }) => {
  ui('yaw').textContent = yaw.toFixed(2);
  ui('pitch').textContent = pitch.toFixed(2);
});
controller.on('state', (event) => {
  if (event.type === 'camera-ready') {
    ui('placeholder').classList.add('hidden');
    ui('cameraStatus').textContent = 'Online';
    button.disabled = false;
  }
  if (event.type === 'register-start') {
    ui('challenge').classList.remove('hidden');
    ui('challengeText').textContent = 'Liveness started. Keep the document visible.';
    ui('result').classList.add('hidden');
    setLog('Document enrollment started.');
  }
  if (event.type === 'register-guidance') ui('challengeText').textContent = textFor(event.guidance);
  if (event.type === 'register-success') {
    ui('challenge').classList.add('hidden');
    setLog('Document enrollment completed.');
  }
});
controller.on('error', (error) => setLog(error instanceof Error ? error.message : String(error), true));

button.addEventListener('click', () => {
  if (!controller.video) return;
  try {
    void controller
      .register()
      .then((result) => {
        const docResult = latestResult ?? (result as typeof result & { matched?: boolean; person?: PersonData; score?: number });
        ui('result').innerHTML =
          `${docResult.matched === false ? 'Document face does not match.' : 'Document face matched.'}<br>Score: ${typeof docResult.score === 'number' ? `${(docResult.score * 100).toFixed(2)}%` : '—'}<br>${renderPerson(docResult.person)}`;
        ui('result').classList.remove('hidden');
      })
      .catch((error) => setLog(error instanceof Error ? error.message : String(error), true));
  } catch (error) {
    setLog(error instanceof Error ? error.message : String(error), true);
  }
});
app.querySelectorAll<HTMLButtonElement>('[data-action="landmark"]').forEach((control) => {
  control.addEventListener('click', () => {
    const mode = control.dataset.mode as LandmarkMode;
    controller.setLandmark(mode);
    app.querySelectorAll('[data-action="landmark"]').forEach((item) => {
      item.classList.toggle('is-active', (item as HTMLElement).dataset.mode === mode);
    });
  });
});
app.querySelector('[data-action="landmark"]')?.classList.add('is-active');
