'use strict';
// Draws a battle and plays its effects. `src` is anything shaped like a Battle:
// { ships, wind, R, grapples:[{a,b,log}], t } — the live simulation in single player,
// or the mirror built from server snapshots in multiplayer.
class BattleView {
  constructor(me) {
    this.me = me; this.parts = new Particles(); this.shots = []; this.msgs = []; this.shake = 0; this.t = 0;
    this.follow = null; this.fleetHint = null;
  }
  get myTeam() { const c = this.me || this.follow; return c ? c.team : 0; }
  cam(src) {
    if (this.me && this.me.state !== 'sunk' && this.me.state !== 'escaped') return this.me;
    const ok = s => s && s.state === 'active';
    if (!ok(this.follow)) {
      const t = this.me ? this.me.team : null, act = src.ships.filter(ok);
      this.follow = act.find(s => s.human && s.team === t) || act.find(s => s.team === t) || act[0] || this.follow || src.ships[0];
    }
    return this.follow;
  }
  cycleFollow(src) {
    const act = src.ships.filter(s => s.state === 'active');
    if (act.length) this.follow = act[(act.indexOf(this.follow) + 1) % act.length];
  }
  vol(src, o) { const c = this.cam(src); return c ? clamp(1 - dist(o, c) / 1500, 0, 1) : .5; }
  msg(text, col) { this.msgs.push({ text, t: 3.5, col }); if (this.msgs.length > 4) this.msgs.shift(); }

  event(ev, src) {
    const ship = ev.ship != null ? src.ships[ev.ship] : null;
    switch (ev.t) {
      case 'shot':
        this.shots.push({ id: ev.id, x: ev.x, y: ev.y, vx: ev.vx, vy: ev.vy, life: ev.life, ammo: ev.ammo, spin: rand(TAU) });
        this.parts.smoke(ev.x, ev.y, ev.sa);
        Sfx.cannon(this.vol(src, ev) * .8);
        break;
      case 'hit': {
        const i = this.shots.findIndex(b => b.id === ev.id);
        if (i >= 0) this.shots.splice(i, 1);
        if (ev.ammo === 'fire') this.parts.flames(ev.x, ev.y, 7);
        else this.parts.debris(ev.x, ev.y, ev.ammo === 'round' ? 7 : 4);
        Sfx.hit(this.vol(src, ev) * .7);
        if (ship) { ship.flash = .08; if (ship === this.me) this.shake = Math.min(9, this.shake + 3); }
        break;
      }
      case 'sink':
        if (!ship) break;
        this.parts.debris(ship.x, ship.y, 26);
        for (let i = 0; i < 8; i++) this.parts.smoke(ship.x + rand(-15, 15), ship.y + rand(-15, 15), rand(TAU), 2);
        Sfx.hit(this.vol(src, ship) * 1.4);
        break;
      case 'ram': { // hulls struck together
        const a = src.ships[ev.a], b = src.ships[ev.b];
        this.parts.debris(ev.x, ev.y, Math.min(30, 6 + ev.hard | 0));
        for (let i = 0; i < 4; i++) this.parts.splash(ev.x + rand(-10, 10), ev.y + rand(-10, 10));
        Sfx.hit(this.vol(src, ev) * Math.min(1.6, .5 + ev.hard / 15)); Sfx.tone(90, 40, .3, Math.min(.4, ev.hard / 40) * this.vol(src, ev), 'square');
        if (this.me && (a === this.me || b === this.me)) this.shake = Math.min(14, this.shake + 2 + ev.hard / 4);
        break;
      }
      case 'board': case 'melee': {
        const a = src.ships[ev.a];
        if (a) { Sfx.hit(this.vol(src, a) * .6); this.parts.debris(a.x, a.y, 3); }
        break;
      }
      case 'helm': // the captain has moved to another ship
        if (ship) this.me = ship;
        break;
      case 'msg':
        if (ev.to != null && (!this.me || ev.to !== this.me.id)) break;
        this.msg(ev.text, ev.team == null ? null : ev.team === this.myTeam ? '#ff9a8a' : '#b6f0a0');
        break;
    }
  }

  update(dt, src) {
    this.t += dt; this.shake = Math.max(0, this.shake - dt * 14);
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const b = this.shots[i];
      b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt; b.spin += dt * 14;
      if (b.life <= 0) { this.parts.splash(b.x, b.y); Sfx.splash(this.vol(src, b)); this.shots.splice(i, 1); }
    }
    for (const s of src.ships) {
      if (s.state === 'sunk' || s.state === 'escaped') continue;
      s.flash = Math.max(0, (s.flash || 0) - dt);
      this.parts.wake(s, dt);
      if (s.state === 'sinking' && Math.random() < dt * 14) this.parts.splash(s.x + rand(-20, 20), s.y + rand(-20, 20));
      if (s.burn > 0 && s.state !== 'sinking' && Math.random() < dt * 22) { // flames and black smoke from somewhere on deck
        const along = rand(-.35, .35) * s.c.len, across = rand(-.3, .3) * s.c.wid;
        const fx = s.x + Math.cos(s.heading) * along - Math.sin(s.heading) * across, fy = s.y + Math.sin(s.heading) * along + Math.cos(s.heading) * across;
        this.parts.flames(fx, fy, 1);
        if (Math.random() < .4) this.parts.add({ x: fx, y: fy, vx: Math.cos(src.wind.dir) * 25, vy: Math.sin(src.wind.dir) * 25, r: 3, grow: 10, life: 1.8, col: '#2a2420', al: .45, layer: 1 });
      }
      if (s.state === 'active' && s.hull < s.maxHull * .4 && Math.random() < dt * 5)
        this.parts.add({ x: s.x, y: s.y, vx: rand(-10, 10), vy: rand(-10, 10), r: 3, grow: 8, life: 1.4, col: '#333', al: .45, layer: 1 });
    }
    this.parts.update(dt);
    for (const m of this.msgs) m.t -= dt;
    this.msgs = this.msgs.filter(m => m.t > 0);
  }

  draw(ctx, W, H, src, banner) {
    const z = Game.zoom, c = this.cam(src);
    if (!c) return;
    const cx = c.x + rand(-1, 1) * this.shake, cy = c.y + rand(-1, 1) * this.shake, me = this.me;
    drawWater(ctx, cx, cy, z, W, H, this.t);
    ctx.save(); ctx.translate(W / 2, H / 2); ctx.scale(z, z); ctx.translate(-cx, -cy);
    ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.setLineDash([18, 14]); ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(0, 0, src.R, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
    this.parts.draw(ctx, 0);
    if (me && me.state === 'active' && !me.grapple) { // broadside firing arcs
      for (const side of me.bow ? ['L', 'R', 'F'] : ['L', 'R']) {
        const sa = side === 'F' ? me.heading : me.sideAngle(side), rng = me.shot(me.ammo, side).range, w = side === 'F' ? BOW_GUN.arc : .2;
        ctx.beginPath(); ctx.moveTo(me.x, me.y); ctx.arc(me.x, me.y, rng, sa - w, sa + w); ctx.closePath();
        ctx.fillStyle = me.reload[side] > 0 ? 'rgba(255,255,255,.03)' : side === 'F' ? 'rgba(255,210,140,.08)' : GUNS[me.gun].fire ? 'rgba(255,150,60,.12)' : 'rgba(255,240,180,.09)'; ctx.fill();
      }
    }
    for (const s of src.ships) s.draw(ctx, src.wind);
    ctx.strokeStyle = '#3a2a14'; ctx.lineWidth = 1.5; // grappling lines
    for (const g of src.grapples) {
      for (let k = -1; k <= 1; k++) { ctx.beginPath(); ctx.moveTo(g.a.x + k * 8, g.a.y - k * 4); ctx.lineTo(g.b.x - k * 6, g.b.y + k * 6); ctx.stroke(); }
    }
    for (const b of this.shots) {
      ctx.fillStyle = '#16161a';
      if (b.ammo === 'fire') {
        ctx.fillStyle = 'rgba(255,140,30,.35)'; ctx.beginPath(); ctx.arc(b.x, b.y, 6, 0, TAU); ctx.fill();
        ctx.fillStyle = '#ffd25a'; ctx.beginPath(); ctx.arc(b.x, b.y, 3, 0, TAU); ctx.fill();
        if (Math.random() < .5) this.parts.add({ x: b.x, y: b.y, vx: rand(-8, 8), vy: rand(-8, 8), r: 2.5, grow: 3, life: .35, col: pick(['#ff9d3a', '#ffcf5a', '#e2541c']), al: .8, layer: 1 });
      } else if (b.ammo === 'round') { ctx.beginPath(); ctx.arc(b.x, b.y, 2.7, 0, TAU); ctx.fill(); }
      else if (b.ammo === 'chain') {
        const ox = Math.cos(b.spin) * 4, oy = Math.sin(b.spin) * 4;
        ctx.strokeStyle = '#16161a'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(b.x - ox, b.y - oy); ctx.lineTo(b.x + ox, b.y + oy); ctx.stroke();
        ctx.beginPath(); ctx.arc(b.x - ox, b.y - oy, 2, 0, TAU); ctx.arc(b.x + ox, b.y + oy, 2, 0, TAU); ctx.fill();
      } else for (let k = 0; k < 3; k++) { ctx.beginPath(); ctx.arc(b.x + Math.cos(b.spin + k * 2.1) * 3, b.y + Math.sin(b.spin + k * 2.1) * 3, 1.3, 0, TAU); ctx.fill(); }
    }
    this.parts.draw(ctx, 1);
    const team = this.myTeam;
    for (const s of src.ships) { // status bars over other ships
      if (s === me || !s.afloat) continue;
      const w = 46, x = s.x - w / 2, y = s.y - s.c.len / 2 - 24;
      ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(x - 1, y - 1, w + 2, 9);
      ctx.fillStyle = s.team === team ? '#6fbf5f' : '#d9534f'; ctx.fillRect(x, y, w * s.hull / s.maxHull, 4);
      ctx.fillStyle = '#e8e0c8'; ctx.fillRect(x, y + 5, w * s.sailHp / 100, 2);
      const tag = s.state === 'active' ? `${s.human ? '☠ ' : ''}${s.name} · ${s.crew}⚔` : s.state === 'captured' ? 'CAPTURED' : 'SURRENDERED';
      hudText(ctx, tag, s.x, y - 9, 11, s.state !== 'active' ? '#b6f0a0' : s.human ? '#ffd24a' : '#fff', 'center');
    }
    ctx.restore();
    this.hud(ctx, W, H, src, c, banner);
  }

  hud(ctx, W, H, src, c, banner) {
    const me = this.me, live = me && me.state === 'active';
    const p = live ? me : c;
    const sy = TouchUI.on ? 158 : H; // on a touch screen the ship's state moves to the top left, out from under your thumbs
    hudPanel(ctx, 12, sy - 124, 250, 112);
    hudText(ctx, `${p.name} — ${p.c.name}`, 24, sy - 107, 14, '#f5e9c8', 'left', true);
    hudBar(ctx, 24, sy - 94, 226, 16, p.hull / p.maxHull, '#a8322a', `Hull ${Math.ceil(p.hull)}/${p.maxHull}`);
    hudBar(ctx, 24, sy - 74, 226, 16, p.sailHp / 100, '#8a8a6a', `Sails ${Math.round(p.sailHp)}%`);
    hudBar(ctx, 24, sy - 54, 226, 16, p.crew / p.maxCrew, '#3f6f9f', `Crew ${p.crew}/${p.maxCrew}`);
    hudText(ctx, `Canvas: ${['Furled', 'Half sail', 'Full sail'][Math.round(p.sail * 2)]}   ${(p.speed / 10).toFixed(1)} kn`, 24, sy - 25, 13);
    if (live && !me.grapple) {
      const gx = W / 2 - 200, gy = H - 82, rt = me.reloadTime('L'), G = GUNS[me.gun];
      hudPanel(ctx, gx, gy, 400, 70);
      hudBar(ctx, gx + 12, gy + 10, 120, 18, 1 - me.reload.L / rt, me.reload.L > 0 ? '#8a6a2a' : '#3f8f3f', me.reload.L > 0 ? 'Port … loading' : '[Q] Port READY');
      hudBar(ctx, gx + 268, gy + 10, 120, 18, 1 - me.reload.R / rt, me.reload.R > 0 ? '#8a6a2a' : '#3f8f3f', me.reload.R > 0 ? 'Stbd … loading' : '[E] Stbd READY');
      hudText(ctx, `${me.effGuns()} ${G.name.toLowerCase()}`, W / 2, gy + (me.bow ? 14 : 19), 12, G.fire ? '#ffb070' : '#f5e9c8', 'center');
      if (me.bow) {
        const rf = me.reloadTime('F');
        hudBar(ctx, gx + 145, gy + 24, 110, 14, 1 - me.reload.F / rf, me.reload.F > 0 ? '#8a6a2a' : '#3f8f3f', me.reload.F > 0 ? 'Chaser …' : '[R] Chaser READY');
      }
      if (G.fire && !me.bow) hudText(ctx, '🔥 Fire pots — close in: they reach only a short way', W / 2, gy + 50, 13, '#ffb070', 'center');
      else {
        let i = 0;
        for (const k in AMMO) {
          const A = AMMO[k], sel = me.ammo === k, n = k === 'round' || !me.stock ? '∞' : me.stock[k];
          hudText(ctx, `[${A.key}] ${A.name} ${n}`, gx + 70 + i * 130, gy + 50, 13, sel ? '#ffd24a' : (n === 0 ? '#887' : '#f5e9c8'), 'center', sel);
          i++;
        }
        if (G.fire) hudText(ctx, 'shot for the chaser · broadsides throw fire pots', W / 2, gy + 63, 10, '#ffb070', 'center');
      }
    }
    if (live && me.grapple) { // boarding melee panel
      const g = me.grapple, foe = g.a === me ? g.b : g.a, bw = Math.min(560, W - 24), bx = W / 2 - bw / 2, by = H - 150;
      hudPanel(ctx, bx, by, bw, 138);
      hudText(ctx, 'BOARDING ACTION', W / 2, by + 18, 17, '#ffd24a', 'center', true);
      hudText(ctx, `Your crew ${me.crew}   ⚔   ${foe.name}: ${foe.crew}`, W / 2, by + 44, 16, '#fff', 'center', true);
      hudText(ctx, g.log || '', W / 2, by + 68, 12, '#f5e9c8', 'center');
      STANCES.forEach((k, i) => {
        const sel = me.ctrl.stance === k;
        hudText(ctx, `[${i + 1}] ${STANCE_NAME[k]}`, bx + bw / 2 + (i - 1) * 170, by + 96, 15, sel ? '#ffd24a' : '#f5e9c8', 'center', sel);
      });
      hudText(ctx, 'Charge beats crossbows · crossbows break a shield wall · a shield wall stops a charge', W / 2, by + 122, 11, 'rgba(245,233,200,.8)', 'center');
    }
    drawWindRose(ctx, W - 60, 60, src.wind, p.heading);
    const mx = W - 60, my = 180, mr = 50;
    hudPanel(ctx, mx - 54, my - 54, 108, 108);
    ctx.strokeStyle = 'rgba(255,255,255,.4)'; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.arc(mx, my, mr, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
    const team = this.myTeam;
    for (const s of src.ships) {
      if (!s.afloat) continue;
      ctx.fillStyle = s === me ? '#fff' : s.state !== 'active' ? '#aaa' : s.team === team ? (s.human ? '#ffd24a' : '#6fbf5f') : '#ff5a4a';
      ctx.beginPath(); ctx.arc(mx + s.x / src.R * mr, my + s.y / src.R * mr, s === me ? 3 : 2.5, 0, TAU); ctx.fill();
    }
    const left = src.ships.filter(s => s.team !== team && s.state === 'active').length;
    hudText(ctx, `Enemy ships fighting: ${left}`, 16, 22, 15, '#f5e9c8', 'left', true);
    if (TouchUI.on) { if (!live) hudText(ctx, `Spectating ${c.name} — ⇆ to watch another ship`, W / 2, 96, 14, 'rgba(245,233,200,.85)', 'center'); }
    else hudText(ctx, live ? `A/D steer · W/S sails · Q/E broadsides${me.bow ? ' · R bow chaser' : ''} · Space fire at nearest · 1-3 shot · B board${me.ram ? ' · ram them bow-on' : ''} · H help`
      : `Spectating ${c.name} — Tab to watch another ship`, 16, 44, 12, 'rgba(245,233,200,.75)');
    if (live && this.fleetHint && !TouchUI.on) hudText(ctx, this.fleetHint, 16, 62, 12, '#ffd24a');
    drawMessages(ctx, this.msgs, W);
    if (live && !banner) {
      const bt = !me.grapple && src.ships.find(e => e.team !== me.team && e.state === 'active' && !e.grapple && canBoard(me, e));
      if (bt) hudText(ctx, `${TouchUI.on ? 'Tap ⚓ board' : 'Press B'} to board the ${bt.name}`, W / 2, H - 110, 20, '#ffd24a', 'center', true);
      if (Math.hypot(me.x, me.y) > src.R - 260) hudText(ctx, 'Cross the line to flee the battle', W / 2, H / 2 - 90, 18, '#ffb0a0', 'center', true);
      if (me.burn > 0) hudText(ctx, '🔥 Fire aboard! Your crew are fighting it', W / 2, H / 2 + 116, 17, '#ffb070', 'center', true);
      if (windFactor(me.heading, src.wind.dir) < .3 && me.sail > 0) hudText(ctx, 'In irons — turn away from the wind!', W / 2, H / 2 + 90, 16, '#ffe9a0', 'center');
    }
    if (banner) hudText(ctx, banner.text, W / 2, H / 2 - 30, 64, banner.col || '#ffd24a', 'center', true);
  }
}

// Reads the keyboard into a ship's orders. Used by single player and the network client alike.
function readBattleKeys(ctrl, ship) {
  ctrl.rudder = (Input.is('d', 'ArrowRight') ? 1 : 0) - (Input.is('a', 'ArrowLeft') ? 1 : 0);
  if (Input.was('w', 'ArrowUp')) ctrl.sail = Math.min(1, ctrl.sail + .5);
  if (Input.was('s', 'ArrowDown')) ctrl.sail = Math.max(0, ctrl.sail - .5);
  if (Input.was('q')) ctrl.acts.push('L');
  if (Input.was('e')) ctrl.acts.push('R');
  if (Input.was('r') && ship.bow) ctrl.acts.push('F');
  if (Input.was(' ')) ctrl.acts.push('near');
  if (Input.was('b')) ctrl.acts.push('board');
  const ammoKeys = Object.keys(AMMO);
  ['1', '2', '3'].forEach((k, i) => {
    if (!Input.was(k)) return;
    if (ship.grapple) ctrl.stance = STANCES[i]; else ctrl.ammo = ammoKeys[i];
  });
}
