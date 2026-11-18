'use strict';
// How well a square-rigger sails at each angle off the wind (0 = running dead downwind, PI = in irons).
const POINTS_OF_SAIL = [[0, .8], [.8, 1], [1.57, .86], [2.36, .5], [2.85, .16], [3.15, .07]];
function windFactor(heading, windDir) {
  const a = Math.abs(angDiff(heading, windDir));
  for (let i = 1; i < POINTS_OF_SAIL.length; i++) {
    if (a <= POINTS_OF_SAIL[i][0]) {
      const [a0, f0] = POINTS_OF_SAIL[i - 1], [a1, f1] = POINTS_OF_SAIL[i];
      return lerp(f0, f1, (a - a0) / (a1 - a0));
    }
  }
  return .07;
}
const MAST_POS = { 1: [0.05], 2: [-0.2, 0.2], 3: [-0.3, 0.02, 0.3] };

class Ship {
  constructor(o) {
    this.cls = o.cls; this.c = SHIP_CLASSES[o.cls];
    this.team = o.team || 0; this.isPlayer = !!o.isPlayer;
    this.styleKey = o.style || 'pirate'; this.style = STYLES[this.styleKey];
    this.name = o.name || 'Ship';
    this.x = o.x || 0; this.y = o.y || 0; this.heading = o.heading || 0;
    this.speed = 0; this.rudder = 0; this.rudderS = 0; this.sail = o.sail != null ? o.sail : 1;
    const up = o.up || { hull: 0, sails: 0, guns: 0 };
    this.maxHull = Math.round(this.c.hull * (1 + .15 * up.hull) * (o.hullMul || 1));
    this.hull = o.hull != null ? Math.min(o.hull, this.maxHull) : this.maxHull;
    this.sailHp = o.sailHp != null ? o.sailHp : 100;
    this.maxCrew = this.c.crew;
    this.crew = o.crew != null ? o.crew : Math.round(this.maxCrew * (o.crewMul || 1));
    this.guns = Math.max(1, Math.round(this.c.guns * (o.gunsMul || 1)));
    this.speedMul = (1 + .07 * up.sails) * (o.speedMul || 1);
    this.turnMul = o.turnMul || 1; this.accelMul = o.accelMul || 1; // a full hold turns and gathers way slowly
    this.reloadBase = (o.up ? 4.6 : 5.6) * (1 - .12 * up.guns);
    this.reload = { L: 0, R: 0, F: 0 }; this.ammo = 'round';
    const fit = fitOf(o); this.gun = fit.gun; this.bow = fit.bow; this.ram = fit.ram;
    this.burn = 0; // seconds of fire left aboard
    this.state = 'active'; // active | sinking | sunk | surrendered | captured | escaped
    this.sinkT = 0; this.wakeT = 0; this.flash = 0;
    this.loot = o.loot || { gold: 0, cargo: 0 };
    this.boss = !!o.boss; this.noFlee = !!o.noFlee; this.meleeMul = o.meleeMul || 1;
    this.ai = { mode: o.aiMode || 'aggr', t: 0, target: null, tack: 1, ammoT: rand(2, 6), fleeChecked: false };
  }
  get vx() { return Math.cos(this.heading) * this.speed; }
  get vy() { return Math.sin(this.heading) * this.speed; }
  get afloat() { return this.state === 'active' || this.state === 'surrendered' || this.state === 'captured'; }
  reloadTime(side) {
    const base = side === 'F' ? BOW_GUN.reload * this.reloadBase / 5.6 : this.reloadBase * GUNS[this.gun].reload;
    return base * (1 + (1 - clamp(this.crew / (this.maxCrew * .7), 0, 1)) * .9);
  }
  // What a gun throws: the loaded shot as modified by the battery (side L/R) or the bow chaser (side F).
  shot(ammo, side) {
    const G = side === 'F' ? BOW_GUN : GUNS[this.gun];
    if (G.fire) return { ammo: 'fire', range: FIRE_SHOT.range, speed: FIRE_SHOT.speed, hull: FIRE_SHOT.hull, sail: FIRE_SHOT.sail, crew: FIRE_SHOT.crew, spread: G.spread, ignite: FIRE_SHOT.ignite };
    const A = AMMO[ammo];
    const k = Math.min(1, G.dmg); // a bigger ball smashes more timber, not more canvas or men
    return { ammo, range: A.range * G.range, speed: A.speed * G.speed, hull: A.hull * G.dmg, sail: A.sail * k, crew: A.crew * k, spread: G.spread, ignite: 0 };
  }
  effGuns() { return Math.max(1, Math.round(this.guns * clamp(this.crew / (this.maxCrew * .5), .34, 1))); }
  sideAngle(side) { return this.heading + (side === 'L' ? -1 : 1) * Math.PI / 2; }

  update(dt, wind) {
    if (this.state === 'sinking') {
      this.sinkT += dt; this.speed *= Math.max(0, 1 - dt * 1.5);
      if (this.sinkT > 4) this.state = 'sunk';
    } else {
      const sail = this.state === 'active' ? this.sail : 0;
      const target = this.c.speed * this.speedMul * windFactor(this.heading, wind.dir) * wind.str * sail * (.3 + .7 * this.sailHp / 100);
      this.speed += (target - this.speed) * Math.min(1, dt * (target > this.speed ? .45 * this.accelMul : .6));
      const steer = .4 + .6 * Math.min(1, this.speed / (this.c.speed * .45));
      this.rudderS = lerp(this.rudderS, this.state === 'active' ? this.rudder : 0, Math.min(1, dt * 4));
      this.heading += this.rudderS * this.c.turn * this.turnMul * steer * dt;
      this.speed *= 1 - Math.abs(this.rudderS) * .12 * dt;
    }
    this.x += Math.cos(this.heading) * this.speed * dt;
    this.y += Math.sin(this.heading) * this.speed * dt;
    this.reload.L = Math.max(0, this.reload.L - dt);
    this.reload.R = Math.max(0, this.reload.R - dt);
    this.flash = Math.max(0, this.flash - dt);
  }

  hullPath(ctx) {
    const h = this.c.len / 2, w = this.c.wid / 2;
    ctx.beginPath(); ctx.moveTo(h, 0);
    ctx.bezierCurveTo(h * .55, -w * 1.05, -h * .3, -w * 1.1, -h * .85, -w * .8);
    ctx.quadraticCurveTo(-h * 1.04, 0, -h * .85, w * .8);
    ctx.bezierCurveTo(-h * .3, w * 1.1, h * .55, w * 1.05, h, 0);
    ctx.closePath();
  }

  draw(ctx, wind) {
    if (this.state === 'sunk' || this.state === 'escaped') return;
    const L = this.c.len, W = this.c.wid, st = this.style;
    let alpha = 1, sc = 1, roll = 0;
    if (this.state === 'sinking') { const k = Math.min(1, this.sinkT / 4); alpha = 1 - k; sc = 1 - .25 * k; roll = k * .5; }
    ctx.save(); ctx.globalAlpha = alpha;
    // shadow on the water
    ctx.save(); ctx.translate(this.x + 4, this.y + 6); ctx.rotate(this.heading); ctx.scale(sc, sc);
    this.hullPath(ctx); ctx.fillStyle = 'rgba(0,15,35,.28)'; ctx.fill(); ctx.restore();

    ctx.translate(this.x, this.y); ctx.rotate(this.heading + roll); ctx.scale(sc, sc);
    this.hullPath(ctx); ctx.fillStyle = this.flash > 0 ? '#c9713a' : st.hull; ctx.fill();
    ctx.lineWidth = 2.2; ctx.strokeStyle = st.trim; ctx.stroke();
    ctx.save(); ctx.scale(.84, .7); this.hullPath(ctx); ctx.fillStyle = '#b08a57'; ctx.fill(); ctx.restore();
    // deck planks
    ctx.strokeStyle = 'rgba(70,45,20,.35)'; ctx.lineWidth = 1; ctx.beginPath();
    ctx.moveTo(-L * .38, 0); ctx.lineTo(L * .4, 0); ctx.stroke();
    // guns: long and thin (rifled), fat (bombards), brass-mouthed (flame)
    const gw = { culverin: 3, rifled: 2.4, bombard: 4.4, flame: 3.4 }[this.gun], gl = { culverin: 5, rifled: 7, bombard: 5, flame: 5 }[this.gun];
    ctx.fillStyle = this.gun === 'flame' ? '#7a3a12' : '#1a1a1a';
    for (let i = 0; i < this.guns; i++) {
      const gx = lerp(-L * .28, L * .25, (i + .5) / this.guns);
      ctx.fillRect(gx - gw / 2, -W / 2 - (gl - 3.5), gw, gl); ctx.fillRect(gx - gw / 2, W / 2 - 3.5, gw, gl);
    }
    if (this.bow) { ctx.fillStyle = '#1a1a1a'; ctx.fillRect(L * .36, -1.6, 9, 3.2); }
    if (this.ram) {
      ctx.fillStyle = '#b8862e'; ctx.strokeStyle = '#5a3c10'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(L * .47, -W * .16); ctx.lineTo(L * .5 + 11, 0); ctx.lineTo(L * .47, W * .16); ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    // masts & sails
    const rel = angDiff(wind.dir, this.heading), trim = clamp(rel, -.9, .9);
    const amt = this.state === 'active' ? this.sail : 0;
    const masts = MAST_POS[this.c.masts];
    masts.forEach((m, i) => {
      const yl = W * (masts.length > 1 && i === Math.floor(masts.length / 2) ? 1.08 : .92);
      ctx.save(); ctx.translate(m * L, 0); ctx.rotate(trim);
      if (amt > 0) {
        const belly = (3 + W * .42) * amt * 2;
        ctx.beginPath(); ctx.moveTo(0, -yl); ctx.quadraticCurveTo(belly, 0, 0, yl); ctx.closePath();
        ctx.globalAlpha = alpha * (.5 + .5 * this.sailHp / 100);
        ctx.fillStyle = st.sail; ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,.3)'; ctx.lineWidth = 1; ctx.stroke();
        if (this.sailHp < 75) { // holes
          ctx.fillStyle = 'rgba(20,40,60,.7)';
          const n = Math.ceil((75 - this.sailHp) / 14);
          for (let k = 0; k < n; k++) {
            const hy = (hash2(i + 1, k + 1) - .5) * yl * 1.4;
            ctx.beginPath(); ctx.arc(belly * .22 * (1 - Math.abs(hy) / yl), hy, 1.8, 0, TAU); ctx.fill();
          }
        }
        ctx.globalAlpha = alpha;
      }
      ctx.strokeStyle = '#4a2f14'; ctx.lineWidth = amt > 0 ? 2 : 3.2;
      ctx.beginPath(); ctx.moveTo(0, -yl); ctx.lineTo(0, yl); ctx.stroke();
      ctx.restore();
      ctx.fillStyle = '#2e1c0b'; ctx.beginPath(); ctx.arc(m * L, 0, 2.4, 0, TAU); ctx.fill();
    });
    if (this.burn > 0 && this.state !== 'sinking') { // flames licking the deck
      const k = Math.min(1, this.burn / 6), fl = .6 + .4 * Math.sin(Date.now() / 90);
      ctx.fillStyle = `rgba(255,${120 + 60 * fl | 0},30,${.35 * k})`;
      ctx.beginPath(); ctx.ellipse(-L * .05, 0, L * .3, W * .32, 0, 0, TAU); ctx.fill();
    }
    // flag streaming downwind from the stern
    ctx.save(); ctx.translate(-L * .46, 0); ctx.rotate(rel);
    ctx.fillStyle = this.state === 'surrendered' || this.state === 'captured' ? '#ffffff' : st.flag;
    ctx.beginPath(); ctx.moveTo(0, -2.5); ctx.lineTo(12, 0); ctx.lineTo(0, 2.5); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.6)'; ctx.lineWidth = .8; ctx.stroke();
    ctx.restore();
    ctx.restore();
  }
}

// ---------- particles ----------
class Particles {
  constructor() { this.a = []; }
  add(p) { if (this.a.length < 1500) { p.max = p.life; this.a.push(p); } }
  update(dt) {
    const a = this.a;
    for (let i = a.length - 1; i >= 0; i--) {
      const p = a[i]; p.life -= dt;
      if (p.life <= 0) { a[i] = a[a.length - 1]; a.pop(); continue; }
      p.x += p.vx * dt; p.y += p.vy * dt;
      const d = Math.max(0, 1 - (p.drag || 0) * dt); p.vx *= d; p.vy *= d;
      p.r += (p.grow || 0) * dt;
    }
  }
  draw(ctx, layer) {
    for (const p of this.a) {
      if (p.layer !== layer) continue;
      ctx.globalAlpha = p.al * (p.life / p.max);
      ctx.fillStyle = p.col; ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(.5, p.r), 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  smoke(x, y, ang, n = 3) {
    for (let i = 0; i < n; i++) {
      const a = ang + rand(-.35, .35), s = rand(20, 90);
      this.add({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, drag: 2, r: rand(3, 6), grow: rand(6, 12), life: rand(.8, 1.8), col: pick(['#ddd', '#bbb', '#eee']), al: .55, layer: 1 });
    }
    this.add({ x, y, vx: 0, vy: 0, r: 5, grow: -20, life: .12, col: '#ffd27a', al: 1, layer: 1 });
  }
  splash(x, y) {
    for (let i = 0; i < 5; i++) {
      const a = rand(TAU), s = rand(10, 45);
      this.add({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, drag: 3, r: rand(1.5, 3), grow: 3, life: rand(.3, .7), col: '#e8f6ff', al: .8, layer: 0 });
    }
  }
  debris(x, y, n = 6) {
    for (let i = 0; i < n; i++) {
      const a = rand(TAU), s = rand(30, 130);
      this.add({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, drag: 3, r: rand(1, 2.6), life: rand(.4, 1), col: pick(['#8a5a2e', '#5a3b1a', '#c9a45c', '#ff9d3a']), al: 1, layer: 1 });
    }
  }
  flames(x, y, n = 4) {
    for (let i = 0; i < n; i++) {
      const a = rand(TAU), sp = rand(5, 40);
      this.add({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 10, drag: 2, r: rand(2, 4), grow: rand(-2, 3), life: rand(.3, .8), col: pick(['#ff9d3a', '#ffcf5a', '#e2541c', '#fff0a0']), al: .9, layer: 1 });
    }
  }
  wake(s, dt) {
    s.wakeT -= dt;
    if (s.wakeT > 0 || s.speed < 14) return;
    s.wakeT = .07;
    const bx = s.x - Math.cos(s.heading) * s.c.len * .45, by = s.y - Math.sin(s.heading) * s.c.len * .45;
    this.add({ x: bx + rand(-3, 3), y: by + rand(-3, 3), vx: 0, vy: 0, r: s.c.wid * .25, grow: 5, life: 1.7, col: '#dff1fb', al: .3, layer: 0 });
  }
}
