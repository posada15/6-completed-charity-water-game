'use strict';

/* =========================================================
   Configuration — tweak these to balance difficulty
   ========================================================= */
const CONFIG = {
  GOAL_CANS:      20,     // cans needed to win
  DURATION:       30,     // seconds
  SPAWN_INTERVAL: 650,    // ms between spawns
  ITEM_LIFETIME:  1400,   // ms a can stays on screen
  DIRTY_CHANCE:   0.22,   // probability an item is dirty water
  PENALTY:        1,      // cans lost on a dirty hit
  MILESTONES:     [5, 10, 15],
  GOOD_MESSAGES: [
    'Nice catch!',
    'Clean water secured!',
    '+1 can. Keep going!',
    'Great hit!',
    'That’s a can!'
  ],
  MILESTONE_MESSAGES: {
    5:  '5 cans — great start!',
    10: '10 cans — halfway there!',
    15: '15 cans — almost there!'
  }
};

/* =========================================================
   State
   ========================================================= */
const state = {
  active:        false,
  score:         0,
  timeLeft:      CONFIG.DURATION,
  spawnTimer:    null,
  clockTimer:    null,
  itemTimeouts:  new Map(),   // cellEl -> timeoutId
  milestonesHit: new Set()
};

const prefersReducedMotion =
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* =========================================================
   DOM references
   ========================================================= */
const els = {
  grid:         document.getElementById('game-grid'),
  startBtn:     document.getElementById('start-game'),
  resetBtn:     document.getElementById('reset-game'),
  currentCans:  document.getElementById('current-cans'),
  timer:        document.getElementById('timer'),
  feedback:     document.getElementById('feedback'),
  overlay:      document.getElementById('overlay'),
  overlayTitle: document.getElementById('overlay-title'),
  overlayMsg:   document.getElementById('overlay-message'),
  playAgain:    document.getElementById('play-again'),
  closeOverlay: document.getElementById('close-overlay'),
  confetti:     document.getElementById('confetti')
};

/* =========================================================
   SVG templates (inline so no external files are needed)
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
  <circle cx="38" cy="88" r="6" fill="#6B3A1F" opacity="0.7"/>
  <circle cx="60" cy="98" r="5" fill="#6B3A1F" opacity="0.7"/>
  <circle cx="54" cy="74" r="4" fill="#6B3A1F" opacity="0.7"/>
  <circle cx="40" cy="108" r="4" fill="#6B3A1F" opacity="0.7"/>
  <circle cx="70" cy="82" r="3" fill="#6B3A1F" opacity="0.7"/>
</svg>`;

/* =========================================================
   Grid creation
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
  // clear any pending expiry for this cell
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
   Spawning
   ========================================================= */
function spawn() {
  if (!state.active) return;

  const cells = [...els.grid.querySelectorAll('.grid-cell')];
  const emptyCells = cells.filter(c => c.dataset.type === 'empty');
  if (emptyCells.length === 0) return;

  const cell = emptyCells[Math.floor(Math.random() * emptyCells.length)];
  const isDirty = Math.random() < CONFIG.DIRTY_CHANCE;

  setCellItem(cell, isDirty ? 'dirty' : 'can');

  // auto-expire the item if not clicked
  const timeoutId = setTimeout(() => {
    if (cell.dataset.type === 'can' || cell.dataset.type === 'dirty') {
      setCellEmpty(cell);
    }
  }, CONFIG.ITEM_LIFETIME);

  state.itemTimeouts.set(cell, timeoutId);
}

/* =========================================================
   Hit handling
   ========================================================= */
function handleHit(cell) {
  const type = cell.dataset.type;
  if (type === 'empty') return;

  // cancel auto-expire
  const t = state.itemTimeouts.get(cell);
  if (t) { clearTimeout(t); state.itemTimeouts.delete(cell); }

  if (type === 'can') {
    state.score++;
    updateScore();

    cell.classList.add('is-hit');
    setTimeout(() => cell.classList.remove('is-hit'), 350);
    setCellEmpty(cell);

    // milestone check takes priority over generic feedback
    const milestone = CONFIG.MILESTONES.find(
      m => state.score === m && !state.milestonesHit.has(m)
    );

    if (milestone) {
      state.milestonesHit.add(milestone);
      showFeedback(CONFIG.MILESTONE_MESSAGES[milestone] || `${milestone} cans!`, 'good');
    } else {
      showFeedback(pickGoodMessage(), 'good');
    }

    checkWin();

  } else if (type === 'dirty') {
    state.score = Math.max(0, state.score - CONFIG.PENALTY);
    updateScore();

    cell.classList.add('is-dirty-hit');
    setTimeout(() => cell.classList.remove('is-dirty-hit'), 400);
    setCellEmpty(cell);

    showFeedback('Dirty water! You lost a can.', 'bad');
  }
}

function pickGoodMessage() {
  return CONFIG.GOOD_MESSAGES[
    Math.floor(Math.random() * CONFIG.GOOD_MESSAGES.length)
  ];
}

/* =========================================================
   Feedback banner
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
   Score & timer displays
   ========================================================= */
function updateScore() {
  els.currentCans.textContent = state.score;
  // retrigger pulse animation
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
    endGame(state.score >= CONFIG.GOAL_CANS);
  }
}

function checkWin() {
  if (state.score >= CONFIG.GOAL_CANS) {
    endGame(true);
  }
}

/* =========================================================
   Game lifecycle
   ========================================================= */
function startGame() {
  if (state.active) return;

  resetGame();

  state.active = true;
  els.startBtn.disabled = true;
  els.resetBtn.disabled = false;

  state.spawnTimer = setInterval(spawn, CONFIG.SPAWN_INTERVAL);
  state.clockTimer = setInterval(tickClock, 1000);

  spawn(); // immediate first item
  showFeedback('Go! Collect the yellow Jerry Cans.', 'good');
}

function endGame(won) {
  if (!state.active) return;
  state.active = false;

  clearInterval(state.spawnTimer);
  clearInterval(state.clockTimer);
  state.spawnTimer = null;
  state.clockTimer = null;

  // clear pending item timeouts and empty the board
  state.itemTimeouts.forEach(clearTimeout);
  state.itemTimeouts.clear();
  els.grid.querySelectorAll('.grid-cell').forEach(setCellEmpty);

  els.startBtn.disabled = false;
  els.resetBtn.disabled = false;

  if (won) {
    showFeedback('You did it!', 'good');
    showOverlay(
      'You did it! 🎉',
      `You collected ${CONFIG.GOAL_CANS} Jerry Cans with ${state.timeLeft}s to spare. ` +
      `Every can represents clean water for someone who needs it.`,
      true
    );
    launchConfetti();
  } else {
    showFeedback('Time’s up!', 'bad');
    showOverlay(
      'Time’s up!',
      `You collected ${state.score} of ${CONFIG.GOAL_CANS} cans. ` +
      `Give it another shot — clean water is worth it.`,
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

  state.score = 0;
  state.timeLeft = CONFIG.DURATION;
  state.milestonesHit.clear();

  els.grid.querySelectorAll('.grid-cell').forEach(setCellEmpty);

  updateScore();
  updateTimer();
  showFeedback('');

  hideOverlay();
  stopConfetti();

  els.startBtn.disabled = false;
  els.resetBtn.disabled = true;
}

/* =========================================================
   Overlay
   ========================================================= */
function showOverlay(title, message /*, won */) {
  els.overlayTitle.textContent = title;
  els.overlayMsg.textContent = message;
  els.overlay.hidden = false;
  setTimeout(() => els.playAgain.focus(), 60);
}

function hideOverlay() {
  els.overlay.hidden = true;
}

/* =========================================================
   Confetti (lightweight canvas particle system)
   ========================================================= */
let confettiState = null;

function launchConfetti() {
  if (prefersReducedMotion) return;

  stopConfetti();

  const canvas = els.confetti;
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  const resize = () => {
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.style.width = window.innerWidth + 'px';
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
    if (!confettiState) return; // stopped externally

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
   Event wiring
   ========================================================= */
els.grid.addEventListener('click', (e) => {
  if (!state.active) return;
  const cell = e.target.closest('.grid-cell');
  if (cell) handleHit(cell);
});

els.startBtn.addEventListener('click', startGame);

els.resetBtn.addEventListener('click', () => {
  resetGame();
  showFeedback('Board reset. Press Start when ready.', 'good');
});

els.playAgain.addEventListener('click', () => {
  hideOverlay();
  startGame();
});

els.closeOverlay.addEventListener('click', hideOverlay);

// Escape closes overlay
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.overlay.hidden) {
    hideOverlay();
  }
});

// Number keys 1–9 hit the matching tile
document.addEventListener('keydown', (e) => {
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
updateScore();
updateTimer();