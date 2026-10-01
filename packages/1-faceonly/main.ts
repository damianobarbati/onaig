import createOnaig, { type Guidance, type LandmarkMode } from './onaig.ts';

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Required app element is missing.');
  return value;
}
const app = required(document.querySelector<HTMLElement>('#app'));

app.innerHTML = `
  <section class="app-shell flex min-h-0 flex-1 flex-col items-center justify-center gap-2 overflow-hidden pb-[env(safe-area-inset-bottom)]">
    <header class="flex h-16 shrink-0 items-center">
      <h1 class="uppercase text-2xl font-bold tracking-tight text-cyan-400 sm:text-3xl">ONAIG Auth</h1>
    </header>
      <div class="video-card">
        <div data-ui="camera"></div>
        <div data-ui="placeholder" class="absolute inset-0 grid place-items-center px-6 text-center text-sm text-slate-500">Camera unavailable</div>
        <div data-ui="faceGuide" class="pointer-events-none absolute left-1/2 top-1/2 aspect-[3/4] w-[68%] -translate-x-1/2 -translate-y-1/2 rounded-[45%] border border-cyan-300/60 shadow-[0_0_0_9999px_rgba(2,6,23,.28)] sm:w-[30%]"></div>
        <div data-ui="challenge" class="pointer-events-none absolute left-1/2 top-5 hidden -translate-x-1/2 px-4">
          <div class="flex w-max max-w-[calc(100vw-2rem)] items-center gap-3 rounded-2xl border border-cyan-300/50 bg-slate-950/85 px-4 py-2 text-cyan-100 shadow-lg backdrop-blur">
            <span data-ui="challengeArrow" class="text-3xl leading-none text-cyan-300">←</span>
            <span data-ui="challengeText" class="text-sm font-semibold">Move left</span>
          </div>
        </div>
        <div data-ui="match" class="match-panel hidden">
          <div data-ui="matchLabel" class="text-xs font-semibold uppercase tracking-[0.18em]">NO MATCH</div>
          <div class="mt-1 flex items-center justify-end gap-2">
            <div data-ui="score" class="mono text-3xl font-semibold">0.00%</div>
            <svg data-ui="matchCheck" class="match-check hidden" viewBox="0 0 24 24" aria-label="Login successful" role="img">
              <path d="M5 12.5 10 17l9-10"></path>
            </svg>
          </div>
        </div>
        <div class="pointer-events-none absolute left-3 right-3 top-3 flex items-start justify-between gap-3 text-[11px] sm:text-xs">
          <div class="overlay-card px-3 py-2 leading-5">
            <div><span class="text-slate-500">Yaw</span> <span data-ui="yaw" class="mono text-cyan-300">—</span></div>
            <div><span class="text-slate-500">Pitch</span> <span data-ui="pitch" class="mono text-cyan-300">—</span></div>
            <div><span class="text-slate-500">Threshold</span> <span class="mono text-slate-300">90%</span></div>
          </div>
          <div class="flex items-center gap-2 rounded-full border border-white/10 bg-slate-950/75 px-3 py-2 backdrop-blur">
            <span data-ui="stateDot" class="h-2.5 w-2.5 rounded-full bg-slate-600"></span>
            <span data-ui="cameraStatus" class="text-slate-300">Offline</span>
          </div>
        </div>
        <div class="absolute right-3 top-[4.5rem] flex flex-col items-stretch gap-1 rounded-2xl border border-white/10 bg-slate-950/80 p-1 text-[10px] shadow-lg backdrop-blur sm:top-[4.75rem] sm:text-xs">
          <button data-action="landmark" data-mode="live" class="landmark-button" type="button">Live</button>
          <button data-action="landmark" data-mode="mesh" class="landmark-button" type="button">Mesh</button>
          <button data-action="landmark" data-mode="contours" class="landmark-button" type="button">Contours</button>
        </div>
      </div>
      <div class="flex w-full flex-col gap-2">
        <div class="flex gap-2">
          <button id="registerBtn" data-action="register" class="action-button register-button" type="button" disabled>Register</button>
          <button id="loginBtn" data-action="login" class="action-button login-button" type="button" disabled>Login</button>
        </div>
        <div data-ui="registerResult" class="hidden overflow-hidden rounded-xl border border-emerald-700/60 bg-slate-950/90 px-3 py-2 text-emerald-300 shadow-xl backdrop-blur">
          <div data-ui="registerVector" class="mono truncate whitespace-nowrap text-[10px] leading-4"></div>
        </div>
      </div>
    <p data-ui="log" class="min-h-5 text-center text-xs text-slate-500" aria-live="polite"></p>
  </section>
`;

const ui = Object.fromEntries([...app.querySelectorAll<HTMLElement>('[data-ui]')].map((element) => [required(element.dataset.ui), element]));
const registerButton = required(app.querySelector<HTMLButtonElement>('[data-action="register"]'));
const loginButton = required(app.querySelector<HTMLButtonElement>('[data-action="login"]'));
const landmarkButtons = [...app.querySelectorAll<HTMLButtonElement>('[data-action="landmark"]')];
const onaig = createOnaig({ root: ui.camera, landmark: 'live', loginTimeoutMs: 60_000 });
const guidanceText = (guidance: Guidance) =>
  ({
    hold: 'Hold still.',
    center: 'Look straight.',
    distance: 'Move closer to the camera.',
    light: 'Use softer, even lighting on your face.',
    pose: 'Keep your face fully visible.',
  })[guidance];

const setLog = (message, error = false) => {
  ui.log.textContent = message;
  ui.log.className = `min-h-5 text-center text-xs ${error ? 'text-rose-400' : 'text-slate-500'}`;
};

const formatVector = (vector: number[]) =>
  `[${vector
    .slice(0, 6)
    .map((value) => Number(value).toFixed(7))
    .join(', ')}, ...]`;
const toggle = (element: Element, visible: boolean) => element.classList.toggle('hidden', !visible);
const setMatchCheck = (visible) => {
  toggle(ui.matchCheck, visible);
  ui.matchCheck.classList.toggle('is-visible', visible);
};

async function updateEnrollment() {
  const enrolled = await onaig.hasEnrollment();
  registerButton.textContent = enrolled ? 'Forget face' : 'Register';
  registerButton.classList.toggle('is-enrolled', enrolled);
  loginButton.disabled = !enrolled;
  const embeddings = await onaig.getEnrollment();
  if (embeddings?.[0]) {
    ui.registerVector.textContent = formatVector(embeddings[0]);
    toggle(ui.registerResult, true);
  }
}

function setLandmarkMode(mode: LandmarkMode) {
  onaig.setLandmark(mode);
  landmarkButtons.forEach((button) => {
    button.classList.toggle('is-active', button.dataset.mode === mode);
  });
  toggle(ui.faceGuide, mode === 'live');
}

onaig.on('frame', ({ yaw, pitch }) => {
  ui.yaw.textContent = yaw.toFixed(2);
  ui.pitch.textContent = pitch.toFixed(2);
});

onaig.on('state', (event) => {
  if (event.type === 'loading') setLog('Loading models...');
  if (event.type === 'camera-ready') {
    toggle(ui.placeholder, false);
    ui.cameraStatus.textContent = 'Online';
    ui.stateDot.className = 'h-2.5 w-2.5 rounded-full bg-emerald-400 shadow-[0_0_12px_#34d399]';
    registerButton.disabled = false;
  }
  if (event.type === 'register-start') {
    toggle(ui.registerResult, false);
    toggle(ui.match, false);
    setMatchCheck(false);
    toggle(ui.challenge, true);
    ui.challengeArrow.textContent = '•';
    ui.challengeText.textContent = 'Starting registration...';
    setLog('Liveness check started.');
  }
  if (event.type === 'register-guidance') ui.challengeText.textContent = guidanceText(event.guidance);
  if (event.type === 'challenge') {
    const instructions = {
      up: ['↑', 'Look up'],
      down: ['↓', 'Look down'],
      left: ['←', 'Look left'],
      right: ['→', 'Look right'],
      center: ['↔', 'Look straight'],
    };
    [ui.challengeArrow.textContent, ui.challengeText.textContent] = instructions[event.challenge];
    toggle(ui.challenge, true);
  }
  if (event.type === 'register-success') {
    toggle(ui.challenge, false);
    toggle(ui.registerResult, true);
    ui.registerVector.textContent = formatVector(event.result.embeddings[0]);
    void updateEnrollment();
    setLog('Face embeddings saved.');
  }
  if (event.type === 'login-start') {
    loginButton.textContent = 'Stop';
    toggle(ui.challenge, true);
    setMatchCheck(false);
    ui.challengeText.textContent = 'Look straight.';
    ui.challengeArrow.textContent = '•';
    setLog('Liveness check started.');
  }
  if (event.type === 'login-guidance') {
    ui.challengeArrow.textContent = '•';
    ui.challengeText.textContent = guidanceText(event.guidance);
  }
  if (event.type === 'login-challenge') {
    const instructions = {
      up: ['↑', 'Look up'],
      down: ['↓', 'Look down'],
      left: ['←', 'Look left'],
      right: ['→', 'Look right'],
    };
    [ui.challengeArrow.textContent, ui.challengeText.textContent] = instructions[event.challenge];
    toggle(ui.challenge, true);
    setLog(`Liveness step ${event.index + 1} of ${event.total}.`);
  }
  if (event.type === 'login-center') {
    ui.challengeArrow.textContent = '•';
    ui.challengeText.textContent = 'Look straight.';
  }
  if (event.type === 'login-liveness-success') setLog('Liveness check complete.');
  if (event.type === 'login-success') {
    loginButton.textContent = 'Login';
    toggle(ui.challenge, false);
    setMatchCheck(true);
    setLog('Login successful.');
  }
  if (event.type === 'login-timeout') {
    loginButton.textContent = 'Login';
    toggle(ui.challenge, false);
    setMatchCheck(false);
    setLog('Liveness check timed out.', true);
  }
  if (event.type === 'stopped') {
    loginButton.textContent = 'Login';
    toggle(ui.challenge, false);
    setMatchCheck(false);
    ui.cameraStatus.textContent = 'Offline';
    ui.stateDot.className = 'h-2.5 w-2.5 rounded-full bg-slate-600';
  }
});

onaig.on('login-progress', ({ matched, score }) => {
  const percentage = typeof score === 'number' && Number.isFinite(score) ? Math.max(0, Math.min(100, score * 100)) : null;
  ui.matchLabel.textContent = matched ? 'MATCH' : 'NO MATCH';
  ui.score.textContent = percentage === null ? '—' : `${percentage.toFixed(2)}%`;
  ui.match.classList.toggle('is-no-match', !matched);
  if (!matched) setMatchCheck(false);
  toggle(ui.match, true);
  setLog(`Live check: ${matched ? 'match' : 'no match'}.`);
});

onaig.on('error', (error) => setLog(error instanceof Error ? error.message : String(error), true));

async function register() {
  try {
    if (await onaig.hasEnrollment()) {
      await onaig.clearEnrollment();
      await updateEnrollment();
      toggle(ui.registerResult, false);
      toggle(ui.match, false);
      setMatchCheck(false);
      setLog('Face cleared.');
      return;
    }
    await onaig.register();
  } catch (error) {
    if (!(error instanceof Error)) {
      setLog(String(error), true);
      return;
    }
    if (error instanceof Error && error.name !== 'AbortError') setLog(error.message, true);
  }
}

function login() {
  if (loginButton.textContent === 'Stop') {
    onaig.stop();
    loginButton.textContent = 'Login';
    setLog('Live check stopped.');
    return;
  }
  void onaig.login().catch((error) => {
    if (error.name !== 'AbortError') setLog(error.message, true);
  });
}

// Bind the controls directly. Delegating from #app makes the flow depend on
// the clicked node and can be brittle when the desktop layout is rerendered.
registerButton.addEventListener('click', () => void register());
loginButton.addEventListener('click', login);
landmarkButtons.forEach((button) => {
  button.addEventListener('click', () => setLandmarkMode(button.dataset.mode as LandmarkMode));
});

setLandmarkMode('live');
void updateEnrollment();
