'use strict';

/* =========================================================
   Difficulty table
   ========================================================= */
const DIFFICULTIES = {
  easy: {
    name: 'Easy',
    goal: 15,
    duration: 40,
    spawnInterval: 750,
    itemLifetime: 1800,
    dirtyChance: 0.12,
    penalty: 1,
    hint: '15 cans · 40s · light dirty water'
  },
  normal: {
    name: 'Normal',
    goal: 20,
    duration: 30,
    spawnInterval: 650,
    itemLifetime: 1400,
    dirtyChance: 0.22,
    penalty: 1,
    hint: '20 cans · 30s · moderate dirty water'
  },
  hard: {
    name: 'Hard',
    goal: 25,
    duration: 24,
    spawnInterval: 500,
    itemLifetime: 1100,
    dirtyChance: 0.30,
    penalty: 2,
    hint: '25 cans · 24s · lots of dirty water, -2 per hit'
  }
};

/* =========================================================
   Milestone definitions (percentage of the goal)
   ========================================================= */
const MILESTONE_DEFS = [
  { pct: 0.25, text: '25% — great start!' },
  { pct: 0.50, text: 'Halfway there! Keep it up.' },
  { pct: 0.75, text: '75% — almost there!' },
  { pct: 0.90, text: 'So close! Don’t stop now.' }
];

/* =========================================================
   State
   ========================================================= */
const state = {
  active:        false,
  score:         0,
  timeLeft:      0,
  difficulty:    'normal',
  config:        DIFFICULTIES.normal,
  spawnTimer:    null,
  clockTimer:    null,
  itemTimeouts:  new Map(),   // cellEl -> timeoutId
  milestonesHit: new Set()    // pct values that have already fired
};

const prefersReducedMotion =
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* =========================================================
   Sound engine (Web Audio API — no external files)
   ========================================================= */
const audio = {
  ctx: null,
  enabled: true,

  ensure() {
    if (!this.enabled) return null;
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { this.enabled = false; return null; }
      try { this.ctx = new AC(); } catch { this.enabled = false; return null; }
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  },

  // Play a sequence of tones
  play(notes) {
    const ctx = this.ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime;

    for (const n of notes) {
      const start = t0 + (n.delay || 0);
      const osc = ctx.createOscillator();
      const g   = ctx.createGain();

      osc.type = n.type || 'sine';
      osc.frequency.setValueAtTime(n.freq, start);

      const peak = n.gain ?? 0.10;
      g.gain.setValueAtTime(0.0001, start);
      g.gain.linearRampToValueAtTime(peak, start + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, start + n.dur);

      osc.connect(g).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + n.dur + 0.03);
    }
  },

  // Preset sounds
  click()    { this.play([{ freq: 660, dur: 0.05, type: 'square',   gain: 0.045 }]); },
  collect()  { this.play([
                 { freq: 880,  dur: 0.09, type: 'triangle', gain: 0.10 },
                 { freq: 1320, dur: 0.13, type: 'triangle', gain: 0.08, delay: 0.05 }
               ]); },
  dirty()    { this.play([
                 { freq: 220, dur: 0.16, type: 'sawtooth', gain: 0.055 },
                 { freq: 140, dur: 0.18, type: 'sawtooth', gain: 0.045, delay: 0.05 }
               ]); },
  miss()     { this.play([{ freq: 180, dur: 0.09, type: 'sine', gain: 0.035 }]); },
  milestone(){ this.play([
                 { freq: 1046.50, dur: 0.10, type: 'triangle', gain: 0.08 },
                 { freq: 1318.51, dur: 0.16, type: 'triangle', gain: 0.08, delay: 0.06 }
               ]); },
  win()      { const notes = [523.25, 659.25, 783.99, 1046.50];
               this.play(notes.map((f, i) => ({
                 freq: f, dur: 0.20, type: 'triangle', gain: 0.09, delay: i * 0.10
               }))); },
  lose()     { const notes = [392, 329.63, 261.63];
               this.play(notes.map((f, i) => ({
                 freq: f, dur: 0.24, type: 'triangle', gain: 0.08, delay: i * 0.13
               }))); }
};

/* =========================================================
   DOM references
   ========================================================= */
const els = {
  grid:         document.getElementById('game-grid'),
  startBtn:     document.getElementById('start-game'),
  resetBtn:     document.getElementById('reset-game'),
  currentCans:  document.getElementById('current-cans'),
  goalValue:    document.getElementById('goal-value'),
  goalDisplay:  document.getElementById('goal-display'),
  timer:        document.getElementById('timer'),
  feedback:     document.getElementById('feedback'),
  difficultyHint: document.getElementById('difficulty-hint'),
  difficultyBtns: [...document.querySelectorAll('.difficulty-btn')],
  soundToggle:  document.getElementById('sound-toggle'),
  toastContainer: document.getElementById('toast-container'),
  overlay:      document.getElementById('overlay'),
  overlayTitle: document.getElementById('overlay-title'),
  overlayMsg:   document.getElementById('overlay-message'),
  playAgain:    document.getElementById('play-again'),
  closeOverlay: document.getElementById('close-overlay'),
  confetti:     document.getElementById('confetti')
};

/* =========================================================
   SVG templates
   ========================================================= */
const CAN_SVG = `
<svg viewBox="0 0 100 130" xmlns="http://www.w3.org/2000/svg"
     aria-hidden="true" focusable="false">
  <g fill="#FFC907">
    <rect x="16" y="6" width="18" height="16" rx="4"/>
    <rect x="66" y="8" width="18" height="14" rx="4"/>
    <rect x="6" y="14" width="88" height="112" rx="16"/>
  </g>
  <rect x="30" y="26" width="40" height="12" rx="6" fill="#FFFFFF"/>
  <g stroke="#FFFFFF" stroke-width="12" stroke-linecap="round">
    <line x1="26" y1="52" x2="74" y2="102"/>
    <line x1="74" y1="52" x2="26" y2="102"/>
  </g>
  <rect x="38" y="64" width="24" height="26" rx="6" fill="#FFC907"/>
</svg>`;

const DIRTY_SVG = `
<svg viewBox="0 0 100 130" xmlns="http://www.w3.org/2000/svg"
     aria-hidden="true" focusable="false">
  <path d="M50 8 C50 8, 14 58, 14 84 C14 105, 30 122, 50 122
           C70 122, 86 105, 86 84 C86 58, 50 8, 50 8 Z"
        fill="#BF6C46"/>
  <circle cx="38" cy="88"  r="6" fill="#6B3A1F" opacity="0.7"/>
  <circle cx="60" cy="98"  r="5" fill="#6B3A1F" opacity="0.7"/>
  <circle cx="54" cy="74"  r="4" fill="#6B3A1F" opacity="0.7"/>
  <circle cx="40" cy="108" r="4" fill="#6B3A1F" opacity="0.7"/>
  <circle cx="70" cy="82"  r="3" fill="#6B3A1F" opacity="0.7"/>
</svg>`;

/* =========================================================
   Grid
   ========================================================= */
function buildGrid() {
  els.grid.innerHTML = '';
  for (let i = 0; i < 9; i++) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'grid-cell';
    cell.dataset.index = i;
    cell.dataset.type = 'empty';
    cell.tabIndex = -1;
    cell.setAttribute('aria-label', `Tile ${i + 1}: empty`);
    els.grid.appendChild(cell);
  }
}

function setCellEmpty(cell) {
  const t = state.itemTimeouts.get(cell);
  if (t) { clearTimeout(t); state.itemTimeouts.delete(cell); }

  cell.innerHTML = '';
  cell.dataset.type = 'empty';
  cell.tabIndex = -1;
  cell.setAttribute('aria-label',
    `Tile ${Number(cell.dataset.index) + 1}: empty`);
  cell.classList.remove('is-hit', 'is-dirty-hit');
}

function setCellItem(cell, type) {
  cell.dataset.type = type;
  cell.tabIndex = 0;

  if (type === 'can') {
    cell.innerHTML = `<div class="item">${CAN_SVG}</div>`;
    cell.setAttribute('aria-label',
      `Tile ${Number(cell.dataset.index) + 1}: yellow Jerry Can — press to collect`);
  } else {
    cell.innerHTML = `<div class="item">${DIRTY_SVG}</div>`;
    cell.setAttribute('aria-label',
      `Tile ${Number(cell.dataset.index) + 1}: dirty water — avoid!`);
  }
}

/* =========================================================
   DOM-injection helpers
   ========================================================= */
function showFloatScore(cell, text, kind) {
  const rect = cell.getBoundingClientRect();
  const el = document.createElement('span');
  el.className = `float-score is-${kind}`;
  el.textContent = text;
  el.setAttribute('aria-hidden', 'true');
  el.style.left = (rect.left + rect.width / 2) + 'px';
  el.style.top  = (rect.top  + rect.height / 2) + 'px';
  document.body.appendChild(el);
  el.addEventListener('animationend', () => el.remove(), { once: true });
  setTimeout(() => el.remove(), 1400); // safety net
}

function showToast(text, kind = '') {
  const t = document.createElement('div');
  t.className = 'toast' + (kind ? ` is-${kind}` : '');
  t.textContent = text;
  els.toastContainer.appendChild(t);

  setTimeout(() => {
    t.classList.add('is-leaving');
    t.addEventListener('animationend', () => t.remove(), { once: true });
    setTimeout(() => t.remove(), 500); // safety net
  }, 2200);
}

/* =========================================================
   Spawning
   ========================================================= */
function spawn() {
  if (!state.active) return;

  const cells = [...els.grid.querySelectorAll('.grid-cell')];
  const emptyCells = cells.filter(c => c.dataset.type === 'empty');
  if (emptyCells.length === 0) return;

  const cell = emptyCells[Math.floor(Math.random() * emptyCells.length)];
  const isDirty = Math.random() < state.config.dirtyChance;
  const type = isDirty ? 'dirty' : 'can';

  setCellItem(cell, type);

  const timeoutId = setTimeout(() => {
    if (cell.dataset.type !== type) return; // already handled

    // Auto-expire. Cans that expire count as a (soft) miss.
    if (type === 'can') audio.miss();
    setCellEmpty(cell);
  }, state.config.itemLifetime);

  state.itemTimeouts.set(cell, timeoutId);
}

/* =========================================================
   Hit handling
   ========================================================= */
function handleHit(cell) {
  const type = cell.dataset.type;

  if (type === 'empty') {
    // Soft click feedback for empty tiles
    if (state.active) audio.click();
    return;
  }

  const t = state.itemTimeouts.get(cell);
  if (t) { clearTimeout(t); state.itemTimeouts.delete(cell); }

  if (type === 'can') {
    state.score++;
    updateScore();
    audio.collect();
    showFloatScore(cell, '+1', 'good');

    cell.classList.add('is-hit');
    setTimeout(() => cell.classList.remove('is-hit'), 350);
    setCellEmpty(cell);

    checkMilestones();
    checkWin();

  } else if (type === 'dirty') {
    state.score = Math.max(0, state.score - state.config.penalty);
    updateScore();
    audio.dirty();
    showFloatScore(cell, `-${state.config.penalty}`, 'bad');

    cell.classList.add('is-dirty-hit');
    setTimeout(() => cell.classList.remove('is-dirty-hit'), 400);
    setCellEmpty(cell);

    showToast(`Dirty water! −${state.config.penalty}`, 'bad');
  }
}

/* =========================================================
   Milestones
   ========================================================= */
function checkMilestones() {
  const pct = state.score / state.config.goal;

  for (const m of MILESTONE_DEFS) {
    if (pct >= m.pct && !state.milestonesHit.has(m.pct)) {
      state.milestonesHit.add(m.pct);
      showToast(m.text, 'gold');
      audio.milestone();
      break; // fire at most one per collect
    }
  }
}

/* =========================================================
   Feedback banner (inline)
   ========================================================= */
let feedbackTimeout = null;
function showFeedback(text, kind = '') {
  clearTimeout(feedbackTimeout);
  if (!text) {
    els.feedback.textContent = '';
    els.feedback.className = 'feedback';
    return;
  }
  els.feedback.textContent = text;
  els.feedback.className = 'feedback' + (kind ? ` is-${kind}` : '');
  feedbackTimeout = setTimeout(() => {
    els.feedback.textContent = '';
    els.feedback.className = 'feedback';
  }, 1600);
}

/* =========================================================
   Score & timer
   ========================================================= */
function updateScore() {
  els.currentCans.textContent = state.score;
  els.currentCans.classList.remove('pulse');
  void els.currentCans.offsetWidth;
  els.currentCans.classList.add('pulse');
}

function updateTimer() {
  els.timer.textContent = Math.max(0, state.timeLeft);
}

function tickClock() {
  state.timeLeft--;
  updateTimer();
  if (state.timeLeft <= 0) {
    endGame(state.score >= state.config.goal);
  }
}

function checkWin() {
  if (state.score >= state.config.goal) endGame(true);
}

/* =========================================================
   Game lifecycle
   ========================================================= */
function startGame() {
  if (state.active) return;

  resetGame();

  // Lock in config at start
  state.config = DIFFICULTIES[state.difficulty];
  state.timeLeft = state.config.duration;

  updateTimer();
  updateScore();

  state.active = true;
  els.startBtn.disabled = true;
  els.resetBtn.disabled = false;
  setDifficultyLocked(true);

  audio.ensure();          // prime AudioContext on user gesture
  audio.click();

  state.spawnTimer = setInterval(spawn, state.config.spawnInterval);
  state.clockTimer = setInterval(tickClock, 1000);
  spawn();

  showFeedback('Go! Collect the yellow Jerry Cans.', 'good');
}

function endGame(won) {
  if (!state.active) return;
  state.active = false;

  clearInterval(state.spawnTimer);
  clearInterval(state.clockTimer);
  state.spawnTimer = null;
  state.clockTimer = null;

  state.itemTimeouts.forEach(clearTimeout);
  state.itemTimeouts.clear();
  els.grid.querySelectorAll('.grid-cell').forEach(setCellEmpty);

  els.startBtn.disabled = false;
  els.resetBtn.disabled = false;
  setDifficultyLocked(false);

  if (won) {
    audio.win();
    showFeedback('You did it!', 'good');
    showOverlay(
      'You did it! 🎉',
      `You collected ${state.config.goal} Jerry Cans on ${state.config.name} ` +
      `with ${state.timeLeft}s to spare. Every can represents clean water ` +
      `for someone who needs it.`,
      true
    );
    launchConfetti();
  } else {
    audio.lose();
    showFeedback('Time’s up!', 'bad');
    showOverlay(
      'Time’s up!',
      `You collected ${state.score} of ${state.config.goal} cans on ` +
      `${state.config.name}. Give it another shot — clean water is worth it.`,
      false
    );
  }
}

function resetGame() {
  state.active = false;

  clearInterval(state.spawnTimer);
  clearInterval(state.clockTimer);
  state.spawnTimer = null;
  state.clockTimer = null;

  state.itemTimeouts.forEach(clearTimeout);
  state.itemTimeouts.clear();

  state.config = DIFFICULTIES[state.difficulty];
  state.score = 0;
  state.timeLeft = state.config.duration;
  state.milestonesHit.clear();

  els.grid.querySelectorAll('.grid-cell').forEach(setCellEmpty);

  updateScore();
  updateTimer();
  showFeedback('');

  hideOverlay();
  stopConfetti();

  els.startBtn.disabled = false;
  els.resetBtn.disabled = true;
  setDifficultyLocked(false);
}

/* =========================================================
   Difficulty UI
   ========================================================= */
function applyDifficulty(key) {
  if (state.active) return;
  if (!DIFFICULTIES[key]) return;

  state.difficulty = key;
  state.config = DIFFICULTIES[key];

  // Reflect in buttons
  for (const btn of els.difficultyBtns) {
    const isActive = btn.dataset.difficulty === key;
    btn.classList.toggle('is-active', isActive);
    btn.setAttribute('aria-pressed', String(isActive));
  }

  // Reflect in UI text
  els.goalValue.textContent = state.config.goal;
  els.goalDisplay.textContent =
    `${state.config.goal} yellow Jerry Cans`;
  els.timer.textContent = state.config.duration;
  els.difficultyHint.textContent = state.config.hint;

  updateScore();
  updateTimer();
}

function setDifficultyLocked(locked) {
  for (const btn of els.difficultyBtns) {
    btn.disabled = locked;
  }
}

/* =========================================================
   Overlay
   ========================================================= */
function showOverlay(title, message) {
  els.overlayTitle.textContent = title;
  els.overlayMsg.textContent = message;
  els.overlay.hidden = false;
  setTimeout(() => els.playAgain.focus(), 60);
}
function hideOverlay() { els.overlay.hidden = true; }

/* =========================================================
   Confetti
   ========================================================= */
let confettiState = null;

function launchConfetti() {
  if (prefersReducedMotion) return;
  stopConfetti();

  const canvas = els.confetti;
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  const resize = () => {
    canvas.width  = window.innerWidth  * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.style.width  = window.innerWidth  + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();

  const colors = ['#FFC907', '#003366', '#77A8BB', '#FFF7E1', '#BF6C46', '#FED8C1'];
  const particles = [];
  const count = 140;
  const W = window.innerWidth;
  const H = window.innerHeight;

  for (let i = 0; i < count; i++) {
    particles.push({
      x: W / 2 + (Math.random() - 0.5) * 220,
      y: H / 2 - 100,
      vx: (Math.random() - 0.5) * 12,
      vy: -Math.random() * 12 - 4,
      size: 6 + Math.random() * 8,
      color: colors[Math.floor(Math.random() * colors.length)],
      rotation: Math.random() * Math.PI * 2,
      rotationSpeed: (Math.random() - 0.5) * 0.3,
      shape: Math.random() > 0.5 ? 'rect' : 'circle'
    });
  }

  const start = performance.now();
  const duration = 3500;

  const frame = (now) => {
    if (!confettiState) return;

    const progress = Math.min(1, (now - start) / duration);
    ctx.clearRect(0, 0, W, H);
    let alive = false;

    for (const p of particles) {
      p.vy += 0.35;
      p.vx *= 0.99;
      p.x += p.vx;
      p.y += p.vy;
      p.rotation += p.rotationSpeed;

      const alpha = 1 - progress;
      if (alpha <= 0 || p.y > H + 60) continue;
      alive = true;

      ctx.save();
      ctx.globalAlpha = Math.max(0, alpha);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation);
      ctx.fillStyle = p.color;

      if (p.shape === 'rect') {
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    if (alive && progress < 1) {
      confettiState.raf = requestAnimationFrame(frame);
    } else {
      ctx.clearRect(0, 0, W, H);
      confettiState = null;
    }
  };

  confettiState = { raf: 0, resize };
  window.addEventListener('resize', resize);
  confettiState.raf = requestAnimationFrame(frame);
}

function stopConfetti() {
  if (!confettiState) return;
  cancelAnimationFrame(confettiState.raf);
  if (confettiState.resize) {
    window.removeEventListener('resize', confettiState.resize);
  }
  const ctx = els.confetti.getContext('2d');
  ctx.clearRect(0, 0, els.confetti.width, els.confetti.height);
  confettiState = null;
}

/* =========================================================
   Sound toggle
   ========================================================= */
function updateSoundToggleUI() {
  const on = audio.enabled;
  els.soundToggle.setAttribute('aria-pressed', String(on));
  els.soundToggle.setAttribute('aria-label', on ? 'Mute sound' : 'Unmute sound');
}

function toggleSound() {
  audio.enabled = !audio.enabled;
  if (audio.enabled) audio.click();
  updateSoundToggleUI();
  try { localStorage.setItem('cw-sound', audio.enabled ? '1' : '0'); } catch {}
}

// Restore preference
try {
  const saved = localStorage.getItem('cw-sound');
  if (saved === '0') audio.enabled = false;
} catch {}

/* =========================================================
   Event wiring
   ========================================================= */
els.grid.addEventListener('click', (e) => {
  if (!state.active) return;
  const cell = e.target.closest('.grid-cell');
  if (cell) handleHit(cell);
});

els.startBtn.addEventListener('click', startGame);

els.resetBtn.addEventListener('click', () => {
  audio.click();
  resetGame();
  showFeedback('Board reset. Press Start when ready.', 'good');
});

els.playAgain.addEventListener('click', () => {
  audio.click();
  hideOverlay();
  startGame();
});

els.closeOverlay.addEventListener('click', () => {
  audio.click();
  hideOverlay();
});

els.soundToggle.addEventListener('click', toggleSound);

for (const btn of els.difficultyBtns) {
  btn.addEventListener('click', () => {
    if (state.active) return;
    audio.ensure(); // prime on first interaction
    audio.click();
    applyDifficulty(btn.dataset.difficulty);
  });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.overlay.hidden) {
    hideOverlay();
    return;
  }
  if (!state.active) return;
  const n = parseInt(e.key, 10);
  if (n >= 1 && n <= 9) {
    const cell = els.grid.children[n - 1];
    if (cell) handleHit(cell);
  }
});

/* =========================================================
   Boot
   ========================================================= */
buildGrid();
applyDifficulty('normal');
updateSoundToggleUI();