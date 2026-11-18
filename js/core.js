'use strict';
// ---------- helpers ----------
const TAU = Math.PI * 2;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a = 1, b) => b === undefined ? Math.random() * a : a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const angDiff = (a, b) => { let d = (a - b) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d; };
// The overworld wraps east–west every WRAP_W px (world.js sets it; 0, as in battles and on the server, means no wrap).
// wrapDx turns an x difference into the short way round.
let WRAP_W = 0;
const wrapDx = dx => WRAP_W ? dx - Math.round(dx / WRAP_W) * WRAP_W : dx;
const wrapX = x => WRAP_W ? x - Math.floor(x / WRAP_W) * WRAP_W : x; // into [0, WRAP_W)
const dist = (a, b) => Math.hypot(wrapDx(a.x - b.x), a.y - b.y);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const hash2 = (x, y) => { const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return n - Math.floor(n); };

// ---------- game data ----------
const SHIP_CLASSES = {
  cog:     { name: 'Cog',         len: 44, wid: 17, hull: 90,  crew: 28,  guns: 3,  speed: 112, turn: 1.25, masts: 1, cost: 600,  cargo: 20, fame: 4,  loot: 1 },
  caravel: { name: 'Caravel',     len: 56, wid: 19, hull: 130, crew: 48,  guns: 5,  speed: 128, turn: 1.05, masts: 2, cost: 1800, cargo: 35, fame: 7,  loot: 1.6 },
  carrack: { name: 'Carrack',     len: 72, wid: 25, hull: 210, crew: 90,  guns: 8,  speed: 108, turn: 0.75, masts: 3, cost: 4500, cargo: 60, fame: 12, loot: 2.5 },
  galleon: { name: 'War Galleon', len: 92, wid: 30, hull: 320, crew: 150, guns: 12, speed: 96,  turn: 0.55, masts: 3, cost: 9500, cargo: 90, fame: 20, loot: 4 },
};
const AMMO = {
  round: { name: 'Round shot', key: '1', range: 520, speed: 520, hull: 11,  sail: 3,  crew: 0.6, desc: 'smashes hulls' },
  chain: { name: 'Chain shot', key: '2', range: 400, speed: 460, hull: 2,   sail: 13, crew: 0.3, desc: 'shreds sails' },
  grape: { name: 'Grapeshot',  key: '3', range: 280, speed: 480, hull: 1.5, sail: 2,  crew: 3.2, desc: 'cuts down crew' },
};
// The broadside battery a ship carries: multipliers on the loaded shot (range, shot speed, damage, reload),
// `spread` is the aim scatter in radians, `cost` is gold per gun a side. A flame battery ignores the loaded shot
// and throws FIRE_SHOT instead.
const GUNS = {
  culverin: { name: 'Culverins',        range: 1,   speed: 1,    dmg: 1,    reload: 1,    spread: .06, cost: 0,   desc: 'the common iron gun' },
  rifled:   { name: 'Rifled long guns', range: 1.4, speed: 1.25, dmg: 1,    reload: 1,    spread: .03, cost: 190, desc: 'shoot farther and truer' },
  bombard:  { name: 'Great bombards',   range: .7,  speed: .85,  dmg: 1.45, reload: 1.5,  spread: .08, cost: 210, desc: 'large bore: shatter hulls up close, slow to load' },
  flame:    { name: 'Flame cannon',     range: 1,   speed: 1,    dmg: 1,    reload: .95,  spread: .09, cost: 190, desc: 'short range, sets the enemy ablaze', fire: true },
};
const FIRE_SHOT = { name: 'Fire pots', range: 240, speed: 300, hull: 1.4, sail: 3.5, crew: .45, ignite: .12 };
// A bow chaser: one long gun on the forecastle that fires dead ahead with whatever shot is loaded (round shot under a flame battery).
const BOW_GUN = { range: 1.2, speed: 1.15, dmg: 1.3, reload: 3.4, spread: .025, arc: .22, cost: 450 };
// A bronze ram on the cutwater: ramming bow-first multiplies the damage dealt (`deal`) and cuts what the rammer takes (`take`).
const RAM = { deal: 3, take: .3 };
const ramCost = cls => Math.round(SHIP_CLASSES[cls].cost * .12) + 200;
const gunCost = (gun, cls) => GUNS[gun].cost * SHIP_CLASSES[cls].guns;
// A ship's fittings, as stored on campaign ships (s.ship, fleet and dock entries) and passed to new Ship().
const fitOf = o => ({ gun: o && GUNS[o.gun] ? o.gun : 'culverin', bow: !!(o && o.bow), ram: !!(o && o.ram) });
const STYLES = {
  player:   { hull: '#6b4423', trim: '#d4a017', sail: '#f1e6c8', flag: '#c62828' },
  ally:     { hull: '#6b4423', trim: '#2e7d32', sail: '#e6e2cf', flag: '#2e7d32' },
  merchant: { hull: '#7a5230', trim: '#3b6ea5', sail: '#fafafa', flag: '#3b6ea5' },
  pirate:   { hull: '#3a2a1c', trim: '#111111', sail: '#5a5252', flag: '#111111' },
  navy:     { hull: '#5a3a22', trim: '#1a237e', sail: '#e3e9ff', flag: '#1a237e' },
  rival:    { hull: '#2f3442', trim: '#c0c8d6', sail: '#dcd6ea', flag: '#26264a' },
  boss:     { hull: '#1c1414', trim: '#8b0000', sail: '#8a1515', flag: '#8b0000' },
};
const SHIP_NAMES = {
  merchant: ['Fat Goose', 'Good Fortune', 'Saint Brigid', 'Amber Lady', 'Honest Tom', 'Wool Queen', 'Silver Herring', 'Patience'],
  pirate:   ['Black Gull', 'Widowmaker', 'Rotten Tooth', 'Sea Wolf', 'Gallows Bird', 'Red Hand', 'Night Eel', 'Bone Harp'],
  navy:     ["King's Oath", 'Vigilant', 'Stalwart', 'Lionheart', 'Resolute', 'Iron Crown', 'Defiance'],
  boss:     ['Dread Herald', 'Mourning Star', 'Ash Maiden'],
  ally:     ['Faithful', 'Sparrowhawk', 'Lucky Penny', 'Brave Otter', 'Kittiwake', 'Steadfast', 'Morning Tide', 'Old Badger'],
  player:   ['Sea Wren', 'Storm Petrel', 'Wild Rose', 'Fortune\'s Fool', 'Grey Mare'],
};

// ---------- input ----------
const Input = {
  down: new Set(), hit: new Set(),
  init() {
    addEventListener('keydown', e => {
      if (e.target && e.target.tagName === 'INPUT') return; // typing a name, not sailing
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (!this.down.has(k)) this.hit.add(k);
      this.down.add(k);
      Sfx.init();
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'Tab'].includes(e.key)) e.preventDefault();
    });
    addEventListener('keyup', e => { this.down.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key); });
    addEventListener('blur', () => this.down.clear());
    addEventListener('pointerdown', () => Sfx.init());
  },
  is(...ks) { return ks.some(k => this.down.has(k)); },
  was(...ks) { return ks.some(k => this.hit.has(k)); },
  endFrame() { this.hit.clear(); },
};

// ---------- synthesized sound ----------
const Sfx = {
  ctx: null, muted: false, buf: null,
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      this.ctx = new AC();
      const n = this.ctx.sampleRate;
      this.buf = this.ctx.createBuffer(1, n, n);
      const d = this.buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    } catch (e) { this.ctx = null; }
  },
  noise(dur, freq, vol, type = 'lowpass') {
    if (!this.ctx || this.muted || vol < 0.01) return;
    const c = this.ctx, t = c.currentTime;
    const s = c.createBufferSource(); s.buffer = this.buf; s.loop = true;
    const f = c.createBiquadFilter(); f.type = type;
    f.frequency.setValueAtTime(freq, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(40, freq * 0.25), t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    s.connect(f); f.connect(g); g.connect(c.destination);
    s.start(t, Math.random() * 0.5); s.stop(t + dur);
  },
  tone(f0, f1, dur, vol, type = 'sine') {
    if (!this.ctx || this.muted || vol < 0.01) return;
    const c = this.ctx, t = c.currentTime;
    const o = c.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(c.destination);
    o.start(t); o.stop(t + dur);
  },
  cannon(v = 1) { this.noise(0.55, 900, 0.45 * v); this.tone(110, 35, 0.35, 0.5 * v); },
  hit(v = 1) { this.noise(0.18, 2200, 0.3 * v, 'bandpass'); this.tone(170, 60, 0.12, 0.2 * v, 'square'); },
  splash(v = 1) { this.noise(0.3, 3000, 0.07 * v, 'highpass'); },
  coin() { this.tone(880, 1320, 0.12, 0.12, 'triangle'); },
  horn() { this.tone(196, 185, 0.6, 0.12, 'sawtooth'); },
};

// ---------- DOM dialogs ----------
const UI = {
  open: false, handler: null,
  init() {
    this.overlay = document.getElementById('overlay');
    this.panel = document.getElementById('panel');
    this.panel.addEventListener('click', e => {
      const b = e.target.closest('[data-a]');
      if (b && !b.disabled && this.handler) this.handler(b.dataset.a, b);
    });
    addEventListener('keydown', e => {
      if (!this.open || e.repeat) return;
      if (e.target && e.target.tagName === 'INPUT' && e.key !== 'Enter') return;
      const b = e.key === 'Enter' ? this.panel.querySelector('button.primary')
        : this.panel.querySelector(`button[data-k="${e.key.replace(/"/g, '')}"]`);
      if (b && !b.disabled) { e.preventDefault(); b.click(); }
    });
  },
  show(html, handler) {
    this.panel.innerHTML = html; this.handler = handler;
    this.overlay.classList.remove('hidden'); this.open = true;
  },
  hide() {
    this.overlay.classList.add('hidden'); this.open = false; this.handler = null;
    Input.down.clear(); Input.hit.clear();
  },
};

// ---------- shared canvas drawing ----------
function drawWater(ctx, camX, camY, zoom, W, H, t) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#1d6189'); g.addColorStop(1, '#174f76');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  const cell = 110, hw = W / 2 / zoom, hh = H / 2 / zoom;
  const x0 = Math.floor((camX - hw) / cell) - 1, x1 = Math.floor((camX + hw) / cell) + 1;
  const y0 = Math.floor((camY - hh) / cell) - 1, y1 = Math.floor((camY + hh) / cell) + 1;
  ctx.strokeStyle = 'rgba(255,255,255,0.13)'; ctx.lineWidth = Math.max(1, 1.5 * zoom);
  ctx.beginPath();
  for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) {
    const h = hash2(gx, gy);
    const wx = (gx + h) * cell + Math.sin(t * 0.5 + h * 30) * 6;
    const wy = (gy + (h * 7.3) % 1) * cell + Math.sin(t * 0.8 + h * 20) * 4;
    const sx = (wx - camX) * zoom + W / 2, sy = (wy - camY) * zoom + H / 2, l = (9 + h * 14) * zoom;
    ctx.moveTo(sx - l, sy); ctx.quadraticCurveTo(sx, sy - 5 * zoom, sx + l, sy);
  }
  ctx.stroke();
}
function hudPanel(ctx, x, y, w, h) {
  ctx.fillStyle = 'rgba(30,18,8,.72)'; ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#c9a45c'; ctx.lineWidth = 2; ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
}
function hudBar(ctx, x, y, w, h, frac, col, label) {
  ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = col; ctx.fillRect(x, y, w * clamp(frac, 0, 1), h);
  ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 1; ctx.strokeRect(x + .5, y + .5, w - 1, h - 1);
  if (label) { ctx.fillStyle = '#fff'; ctx.font = '12px Georgia'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(label, x + 5, y + h / 2 + 1); }
}
function hudText(ctx, s, x, y, size = 14, col = '#f5e9c8', align = 'left', bold = false) {
  ctx.font = (bold ? 'bold ' : '') + size + 'px Georgia'; ctx.textAlign = align; ctx.textBaseline = 'middle';
  ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.75)'; ctx.strokeText(s, x, y);
  ctx.fillStyle = col; ctx.fillText(s, x, y);
}
function drawWindRose(ctx, x, y, wind, heading) {
  hudPanel(ctx, x - 46, y - 46, 92, 104);
  ctx.strokeStyle = 'rgba(255,255,255,.4)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(x, y, 34, 0, TAU); ctx.stroke();
  ctx.save(); ctx.translate(x, y);
  ctx.save(); ctx.rotate(heading); ctx.fillStyle = '#d4a017';
  ctx.beginPath(); ctx.moveTo(14, 0); ctx.lineTo(-9, -6); ctx.lineTo(-9, 6); ctx.closePath(); ctx.fill(); ctx.restore();
  ctx.rotate(wind.dir); ctx.strokeStyle = '#fff'; ctx.fillStyle = '#fff'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(-32, 0); ctx.lineTo(-18, 0); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(34, 0); ctx.lineTo(20, -7); ctx.lineTo(20, 7); ctx.closePath(); ctx.fill();
  ctx.restore();
  hudText(ctx, 'WIND', x, y + 47, 12, '#f5e9c8', 'center');
}
function drawMessages(ctx, msgs, W) {
  let y = 70;
  for (const m of msgs) {
    ctx.globalAlpha = clamp(m.t, 0, 1);
    hudText(ctx, m.text, W / 2, y, 19, m.col || '#fff3c4', 'center', true);
    y += 26;
  }
  ctx.globalAlpha = 1;
}
