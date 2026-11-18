'use strict';
// Battle simulation only: no drawing, sound or DOM, so the same code runs in the
// browser (single player) and on the multiplayer server. Anything the renderer
// needs to show (cannon fire, hits, sinkings, messages) goes out through this.events.
const STANCES = ['charge', 'volley', 'hold'];
const STANCE_NAME = { charge: 'Charge', volley: 'Crossbow volley', hold: 'Shield wall' };
const STANCE_BEATS = { charge: 'volley', volley: 'hold', hold: 'charge' };

class Battle {
  // cfg: { teams: [[shipOpts], [shipOpts]], R? }
  // shipOpts may set human:true (controlled through ship.ctrl) and stock:{chain,grape}.
  constructor(cfg) {
    this.cfg = cfg; this.ships = []; this.timers = []; this.events = []; this.grapples = [];
    this.t = 0; this.R = cfg.R || 2600; this.over = false; this.overT = 0; this.winner = null;
    this.shotId = 0; this.shots = []; this.helm = null; this.fleetOrder = 'engage';
    const ax = rand(TAU), hd = ax + Math.PI / 2;
    this.wind = { dir: hd + rand(-1, 1), str: rand(.9, 1.12), drift: rand(-.015, .015) };
    cfg.teams.forEach((list, team) => list.forEach((o, i) => {
      const sign = team === 0 ? -1 : 1;
      const along = (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 160, back = sign * (520 + (i ? 70 : 0) + Math.floor(i / 5) * 140);
      const s = new Ship(Object.assign({}, o, {
        team, heading: hd,
        x: Math.cos(ax) * back + Math.cos(hd) * along, y: Math.sin(ax) * back + Math.sin(hd) * along,
      }));
      s.id = this.ships.length; s.src = o; s.human = !!o.human; s.stock = o.stock || null;
      s.commandable = !!o.commandable; // a campaign fleet ship the captain can take command of
      if (s.human && s.commandable && !this.helm) this.helm = s;
      s.speed = s.c.speed * .4; s.boardCool = 3; s.grapple = null;
      s.ctrl = { rudder: 0, sail: s.sail, ammo: 'round', stance: 'charge', acts: [] };
      this.ships.push(s);
    }));
    const nEnemy = cfg.teams[1].length;
    this.msg(cfg.intro || (nEnemy > 1 ? `${nEnemy} enemy sail sighted!` : 'Enemy sail sighted!'));
  }
  emit(t, o) { this.events.push(Object.assign({ t }, o)); }
  // A message: `ship` (if any) lets each viewer colour it as good or bad news; `to` limits it to one ship's captain.
  msg(text, ship, to) { this.emit('msg', { text, team: ship ? ship.team : null, to: to != null ? to.id : undefined }); }
  enemiesOf(s) { return this.ships.filter(o => o.team !== s.team && o.state === 'active'); }
  nearestEnemy(s) {
    let best = null, bd = 1e9;
    for (const o of this.ships) { if (o.team === s.team || o.state !== 'active') continue; const d = dist(s, o); if (d < bd) { bd = d; best = o; } }
    return best;
  }

  // ---------- gunnery ----------
  // side: 'L' / 'R' broadside, 'F' the bow chaser
  fire(ship, side) {
    if (ship.state !== 'active' || ship.grapple || ship.reload[side] > 0 || (side === 'F' && !ship.bow)) return false;
    let ammo = ship.ammo;
    const pots = side !== 'F' && GUNS[ship.gun].fire; // a flame battery throws fire pots whatever is loaded
    if (ship.stock && ammo !== 'round' && !pots) {
      if (ship.stock[ammo] <= 0) { this.msg(`Out of ${AMMO[ammo].name.toLowerCase()}!`, null, ship); ship.ammo = ship.ctrl.ammo = ammo = 'round'; }
      else if (side !== 'F') ship.stock[ammo]--; // the chaser's single ball comes out of the same locker for free
    }
    ship.reload[side] = ship.reloadTime(side);
    const n = side === 'F' ? 1 : ship.effGuns();
    for (let i = 0; i < n; i++) this.timers.push({ t: i * .06 + rand(.05), fn: () => this.shoot(ship, side, i, n, ammo) });
    return true;
  }
  shoot(ship, side, i, n, ammo) {
    if (ship.state !== 'active') return;
    const A = ship.shot(ammo, side), ch = Math.cos(ship.heading), sh = Math.sin(ship.heading);
    let x, y, sa;
    if (side === 'F') { sa = ship.heading; x = ship.x + ch * ship.c.len * .52; y = ship.y + sh * ship.c.len * .52; }
    else {
      sa = ship.sideAngle(side);
      const along = lerp(-ship.c.len * .28, ship.c.len * .25, (i + .5) / n);
      x = ship.x + ch * along + Math.cos(sa) * ship.c.wid * .5;
      y = ship.y + sh * along + Math.sin(sa) * ship.c.wid * .5;
    }
    const ang = sa + rand(-A.spread, A.spread), sp = A.speed * rand(.94, 1.06);
    const b = { id: ++this.shotId, x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, life: A.range / A.speed * rand(.9, 1.05), ammo: A.ammo, team: ship.team, A };
    this.shots.push(b);
    this.emit('shot', { id: b.id, x: r1(x), y: r1(y), vx: r1(b.vx), vy: r1(b.vy), life: +b.life.toFixed(3), ammo: A.ammo, sa: +sa.toFixed(3), bow: side === 'F' ? 1 : undefined });
  }
  // A: shot stats from Ship.shot()
  damage(s, A) {
    let k = A.crew * rand(.4, 1.6); k = Math.floor(k) + (Math.random() < k % 1 ? 1 : 0);
    if (A.ignite && Math.random() < A.ignite) this.ignite(s, rand(5, 8));
    this.hurt(s, A.hull * rand(.8, 1.25), A.sail * 60 / s.c.hull * rand(.7, 1.3), k);
  }
  ignite(s, secs) {
    if (!s.afloat) return;
    if (s.burn <= 0) this.msg(`Fire aboard the ${s.name}!`, s);
    s.burn = Math.min(14, s.burn + secs);
  }
  // Every kind of harm (shot, fire, ramming) goes through here, which decides whether she sinks, strikes or runs.
  // `blow` is false for the steady harm of a fire, which only tests the crew's nerve now and then.
  hurt(s, hull, sail, crew, blow = true) {
    if (!s.afloat) return;
    s.hull -= hull;
    s.sailHp = Math.max(0, s.sailHp - sail);
    s.crew = Math.max(0, s.crew - crew);
    if (blow) s.flash = .08;
    if (s.hull <= 0) { s.hull = 0; this.sink(s); }
    else if (s.state !== 'active') return;
    else if (s.crew <= 0) this.surrender(s, 'has no one left to fight');
    else if (!s.human && !s.boss && blow) {
      const bad = s.hull < s.maxHull * .2 || s.crew < s.maxCrew * .15;
      if (bad && !s.noFlee && Math.random() < .14) this.surrender(s, 'strikes her colours');
      else if (!s.noFlee && s.hull < s.maxHull * .35 && !s.ai.fleeChecked) { s.ai.fleeChecked = true; if (Math.random() < .35) s.ai.mode = 'flee'; }
    }
  }
  sink(s) {
    s.state = 'sinking'; s.sinkT = 0; s.burn = 0;
    if (s.grapple) this.endGrapple(s.grapple);
    this.msg(`${s.name} is going down!`, s);
    this.emit('sink', { ship: s.id });
  }
  // The captain moves to another commandable ship: she becomes human-controlled and the one left behind goes to the AI.
  takeHelm(to) {
    const from = this.helm;
    if (!to || to === from || !to.commandable || to.state !== 'active') return false;
    if (from) { from.human = false; from.ai.t = 0; from.ctrl.acts.length = 0; }
    to.human = true; to.ctrl = { rudder: 0, sail: to.sail, ammo: to.ammo, stance: 'charge', acts: [] };
    this.helm = to; this.emit('helm', { ship: to.id });
    return true;
  }
  // AI steering for a fleet ship ordered to form on the captain: hold an echelon station astern of him.
  formOn(s, lead) {
    const mates = this.ships.filter(o => o.commandable && o !== lead && o.state === 'active');
    const slot = Math.max(0, mates.indexOf(s)), side = slot % 2 ? 1 : -1, rank = 1 + (slot >> 1);
    const ch = Math.cos(lead.heading), sh = Math.sin(lead.heading), bx = -rank * 140, by = side * rank * 80;
    const px = lead.x + ch * bx - sh * by, py = lead.y + sh * bx + ch * by, d = Math.hypot(px - s.x, py - s.y);
    if (d > 110) { s.sail = 1; return Math.atan2(py - s.y, px - s.x); }
    const ahead = (px - s.x) * ch + (py - s.y) * sh; // >0: the station is ahead of us
    s.sail = ahead > 30 ? 1 : ahead < -30 ? Math.max(0, lead.sail - .5) : lead.sail;
    return lead.heading + clamp(angDiff(Math.atan2(py - s.y, px - s.x), lead.heading), -.4, .4) * Math.min(1, d / 60);
  }
  surrender(s, why) { s.state = 'surrendered'; s.sail = 0; this.msg(`${s.name} ${why}!`, s); }

  // ---------- AI captain ----------
  ai(s, dt) {
    const a = s.ai; a.t -= dt;
    if (a.t <= 0 || !a.target || a.target.state !== 'active') { a.t = 1.2; a.target = this.nearestEnemy(s); }
    const tg = a.target;
    if (!tg) { s.rudder = 0; s.sail = .5; return; }
    const d = dist(s, tg), bearing = Math.atan2(tg.y - s.y, tg.x - s.x), A = s.shot(s.ammo, 'L');
    let desired;
    const lead = s.commandable && this.fleetOrder === 'form' && this.helm && this.helm !== s && this.helm.state === 'active' ? this.helm : null;
    if (lead && a.mode !== 'flee') desired = this.formOn(s, lead);
    else if (a.mode === 'flee') {
      desired = bearing + Math.PI; desired += angDiff(this.wind.dir, desired) * .35; s.sail = 1;
    } else if (s.ram && a.mode === 'aggr' && !tg.grapple && d < 380 && s.hull > s.maxHull * .4
      && Math.abs(angDiff(bearing, s.heading)) < 1.1 && windFactor(s.heading, this.wind.dir) > .45) { // drive the ram home
      const tt = d / Math.max(40, s.speed);
      desired = Math.atan2(tg.y + tg.vy * tt * .8 - s.y, tg.x + tg.vx * tt * .8 - s.x); s.sail = 1;
    } else if (d > A.range * .8) { desired = bearing; s.sail = 1; }
    else { // turn to present a broadside, opening the range if too close
      const side = angDiff(bearing, s.heading) > 0 ? 1 : -1, close = d < A.range * .4;
      desired = bearing - side * (close ? 1.72 : 1.45); s.sail = close ? 1 : .5; // edge away, guns still bearing
    }
    if (a.mode !== 'flee' && Math.hypot(s.x, s.y) > this.R - 350) desired = Math.atan2(-s.y, -s.x);
    // never point straight into the wind: tack instead
    const upwind = this.wind.dir + Math.PI, du = angDiff(desired, upwind);
    if (Math.abs(du) < .7) { if (Math.abs(du) > .15) a.tack = du > 0 ? 1 : -1; desired = upwind + a.tack * .8; }
    s.rudder = clamp(angDiff(desired, s.heading) * 2.5, -1, 1);

    a.ammoT -= dt;
    if (a.ammoT <= 0) {
      a.ammoT = 5; const r = Math.random();
      const am = d < 270 && r < .35 ? 'grape' : (tg.sailHp > 40 && r > .82 ? 'chain' : 'round');
      s.ammo = am !== 'round' && s.stock && s.stock[am] <= 0 ? 'round' : am; // a ship with its own powder room can run dry
    }
    const foes = this.enemiesOf(s);
    for (const side of s.bow ? ['L', 'R', 'F'] : ['L', 'R']) {
      if (s.reload[side] > 0) continue;
      const sa = side === 'F' ? s.heading : s.sideAngle(side), F = s.shot(s.ammo, side), arc = side === 'F' ? BOW_GUN.arc * .8 : .2;
      for (const o of foes) {
        const dd = dist(s, o); if (dd > F.range * .95) continue;
        const tt = dd / F.speed, b = Math.atan2(o.y + o.vy * tt - s.y, o.x + o.vx * tt - s.x);
        if (Math.abs(angDiff(b, sa)) < arc) { this.fire(s, side); break; }
      }
    }
    if (a.mode === 'aggr' && !lead && !s.grapple && !tg.grapple && s.boardCool <= 0 && this.canBoard(s, tg) && s.crew > tg.crew * 1.25) this.board(s, tg);
  }

  // ---------- boarding: a real-time melee fought in rounds ----------
  canBoard(a, b) { return canBoard(a, b); }
  boardTargetFor(s) {
    if (s.state !== 'active' || s.grapple) return null;
    return this.enemiesOf(s).find(e => !e.grapple && this.canBoard(s, e)) || null;
  }
  board(a, b) {
    const g = { a, b, t: 1.4, round: 0, log: `${a.name} grapples the ${b.name}!`, a0: a.crew, b0: b.crew };
    a.grapple = b.grapple = g; a.boardCool = b.boardCool = 6;
    this.grapples.push(g);
    this.msg(`${a.name} boards the ${b.name}!`);
    this.emit('board', { a: a.id, b: b.id });
  }
  stanceOf(s, foe) {
    if (s.human) return s.ctrl.stance;
    // AI: half the time counter whatever the enemy used last round
    if (foe.lastStance && Math.random() < .5) return STANCES.find(k => STANCE_BEATS[k] === foe.lastStance);
    return pick(STANCES);
  }
  updateGrapples(dt) {
    for (const g of this.grapples.slice()) {
      const { a, b } = g;
      if (a.state !== 'active' || b.state !== 'active') { this.endGrapple(g); continue; }
      a.speed *= Math.max(0, 1 - dt * 1.2); b.speed *= Math.max(0, 1 - dt * 1.2);
      if (a.burn > 0 && b.burn <= 0 && Math.random() < dt * .12) this.ignite(b, 4); // lashed together, the fire jumps across
      else if (b.burn > 0 && a.burn <= 0 && Math.random() < dt * .12) this.ignite(a, 4);
      const d = dist(a, b), want = (a.c.wid + b.c.wid) * .55 + 6;
      if (d > want && d > .01) { // haul the hulls together
        const k = Math.min(1, dt * 1.5) * (d - want) / d / 2, dx = (b.x - a.x) * k, dy = (b.y - a.y) * k;
        a.x += dx; a.y += dy; b.x -= dx; b.y -= dy;
      }
      g.t -= dt;
      if (g.t > 0) continue;
      g.t = 1.6; g.round++;
      const sa = this.stanceOf(a, b), sb = this.stanceOf(b, a);
      a.lastStance = sa; b.lastStance = sb;
      let am = 1, bm = 1;
      if (STANCE_BEATS[sa] === sb) { am = 1.6; bm = .5; } else if (STANCE_BEATS[sb] === sa) { am = .5; bm = 1.6; }
      const toB = Math.round((1.5 + a.crew * .13) * rand(.75, 1.25) * am * a.meleeMul);
      const toA = Math.round((1.5 + b.crew * .13) * rand(.75, 1.25) * bm * b.meleeMul);
      a.crew = Math.max(0, a.crew - toA); b.crew = Math.max(0, b.crew - toB);
      g.log = `${a.name}: ${STANCE_NAME[sa]} vs ${b.name}: ${STANCE_NAME[sb]} — ${am > 1 ? a.name + ' carries the deck!' : bm > 1 ? b.name + ' drives them back!' : 'steel rings on steel'} (−${toA} / −${toB})`;
      this.emit('melee', { a: a.id, b: b.id });
      const broken = (s, s0) => s.crew <= (s.noFlee ? 0 : Math.max(1, Math.floor(s0 * (s.human ? .15 : .2)))); // noFlee crews fight to the last
      const loser = broken(b, g.b0) ? b : broken(a, g.a0) ? a : null;
      if (loser) {
        const winner = loser === a ? b : a;
        loser.state = loser.human ? 'surrendered' : 'captured'; loser.sail = 0;
        this.msg(loser.human ? `${loser.name} is overwhelmed and surrenders!` : `${loser.name} captured by the ${winner.name}!`, loser);
        this.endGrapple(g);
      }
    }
  }
  endGrapple(g) {
    this.grapples = this.grapples.filter(x => x !== g);
    if (g.a.grapple === g) g.a.grapple = null;
    if (g.b.grapple === g) g.b.grapple = null;
  }

  // ---------- orders from a human captain ----------
  applyControls(s) {
    const c = s.ctrl;
    s.rudder = clamp(+c.rudder || 0, -1, 1);
    s.sail = [0, .5, 1].includes(c.sail) ? c.sail : s.sail;
    if (c.ammo !== s.ammo && AMMO[c.ammo]) {
      if (c.ammo !== 'round' && s.stock && s.stock[c.ammo] <= 0) { this.msg(`No ${AMMO[c.ammo].name.toLowerCase()} aboard`, null, s); c.ammo = s.ammo; }
      else s.ammo = c.ammo;
    }
    if (!STANCE_NAME[c.stance]) c.stance = 'charge';
    for (const act of c.acts.splice(0)) {
      if (act === 'L' || act === 'R' || act === 'F') this.fire(s, act);
      else if (act === 'near') {
        const e = this.nearestEnemy(s);
        if (e) this.fire(s, angDiff(Math.atan2(e.y - s.y, e.x - s.x), s.heading) > 0 ? 'R' : 'L');
      } else if (act === 'board') {
        const e = this.boardTargetFor(s);
        if (e) this.board(s, e);
      }
    }
  }

  // ---------- simulation step ----------
  update(dt) {
    this.t += dt; this.wind.dir += this.wind.drift * dt;
    for (const s of this.ships) {
      if (s.state === 'sunk' || s.state === 'escaped') continue;
      s.boardCool -= dt;
      if (s.burn > 0) { if (this.halted) s.burn = 0; else this.burnStep(s, dt); }
      if (this.halted) { // the battle is won: every ship lies still (sinking ones still go down)
        s.ctrl.acts.length = 0; s.speed = 0; s.rudder = s.rudderS = 0;
        const { x, y, heading } = s; s.update(dt, this.wind); s.x = x; s.y = y; s.heading = heading; s.speed = 0;
        continue;
      }
      if (s.state === 'active') {
        if (s.human) this.applyControls(s); else this.ai(s, dt);
      } else if (s.human) s.ctrl.acts.length = 0;
      s.update(dt, this.wind);
      if (s.state === 'active' && Math.hypot(s.x, s.y) > this.R) {
        s.state = 'escaped'; if (s.grapple) this.endGrapple(s.grapple);
        this.msg(`${s.name} has escaped`);
      }
    }
    this.updateGrapples(dt);
    for (let i = this.timers.length - 1; i >= 0; i--) {
      const tm = this.timers[i]; tm.t -= dt;
      if (tm.t <= 0) { this.timers.splice(i, 1); tm.fn(); }
    }
    // cannonballs
    const shots = this.shots;
    for (let i = shots.length - 1; i >= 0; i--) {
      const b = shots[i];
      b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
      let hit = null;
      for (const s of this.ships) {
        if (s.team === b.team || s.state !== 'active') continue;
        const dx = b.x - s.x, dy = b.y - s.y, c = Math.cos(s.heading), sn = Math.sin(s.heading);
        const lx = (dx * c + dy * sn) / (s.c.len / 2), ly = (-dx * sn + dy * c) / (s.c.wid / 2 + 2);
        if (lx * lx + ly * ly < 1) { hit = s; break; }
      }
      if (hit) {
        this.emit('hit', { id: b.id, ship: hit.id, x: r1(b.x), y: r1(b.y), ammo: b.ammo });
        this.damage(hit, b.A); shots.splice(i, 1);
      } else if (b.life <= 0) shots.splice(i, 1);
    }
    // hulls shoulder each other aside, and a hard enough blow stoves in planking
    if (!this.halted) for (let i = 0; i < this.ships.length; i++) for (let j = i + 1; j < this.ships.length; j++) {
      const a = this.ships[i], b = this.ships[j];
      if (!a.afloat || !b.afloat) continue;
      const r = (a.c.len + b.c.len) * .3, d = dist(a, b);
      if (d < r && d > .01) {
        const nx = (a.x - b.x) / d, ny = (a.y - b.y) / d, push = (r - d) / 2;
        if (!(a.grapple && a.grapple === b.grapple)) this.collide(a, b, -nx, -ny);
        a.x += nx * push; a.y += ny * push; b.x -= nx * push; b.y -= ny * push;
        a.speed *= .985; b.speed *= .985;
      }
    }
    if (!this.over && this.helm && this.helm.state !== 'active' && this.helm.state !== 'escaped') {
      // the captain's ship is lost: he gets across to another ship of his fleet and fights on
      const next = this.ships.find(o => o.commandable && o.state === 'active');
      if (next && this.takeHelm(next)) this.msg(`You get across to the ${next.name} and take command!`, null, next);
    }
    if (!this.over) {
      const teams = new Set(this.ships.filter(s => s.state === 'active').map(s => s.team));
      const humans = this.ships.filter(s => s.human);
      const noHumans = humans.length > 0 && !humans.some(s => s.state === 'active');
      if (teams.size <= 1 || noHumans) {
        this.over = true; this.winner = teams.size === 1 ? [...teams][0] : null;
        this.overT = humans.some(s => s.state === 'escaped') && noHumans ? .5 : 2.6;
        this.halted = this.winner !== null && humans.some(s => s.team === this.winner && s.state === 'active'); // a player's victory
      }
    } else this.overT -= dt;
  }
  get finished() { return this.over && this.overT <= 0; }

  // Fire aboard: it eats hull, canvas and the odd hand until the crew beat it out (more hands, faster).
  burnStep(s, dt) {
    if (!s.afloat) { s.burn = 0; return; }
    const hands = clamp(s.crew / (s.maxCrew * .6), 0, 1);
    s.burn = Math.max(0, s.burn - dt * (.5 + 1.1 * hands));
    const hurtCrew = Math.random() < dt * .35 ? 1 : 0;
    this.hurt(s, dt * 1.7 * (s.c.hull / 130) ** .5, dt * 2.2, hurtCrew, Math.random() < dt * .7);
    if (s.burn <= 0 && s.afloat) this.msg(`The fire aboard the ${s.name} is out`, null, s);
  }
  // Two hulls touching. n is the unit vector from a to b. Damage comes from the closing speed, scaled by
  // how heavy each ship is; striking bow-first with a ram multiplies what is dealt and spares the rammer.
  collide(a, b, nx, ny) {
    const closing = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
    if (closing < 28) return;
    const key = a.id < b.id ? a.id + ':' + b.id : b.id + ':' + a.id;
    this.bumps = this.bumps || {};
    if (this.bumps[key] > this.t) return; // one blow per contact
    this.bumps[key] = this.t + 1.2;
    const foes = a.team !== b.team;
    const aBow = Math.cos(a.heading) * nx + Math.sin(a.heading) * ny > .75 && a.speed > 20; // a's cutwater is pointed at b
    const bBow = -(Math.cos(b.heading) * nx + Math.sin(b.heading) * ny) > .75 && b.speed > 20;
    const aRam = foes && aBow && a.ram && a.state === 'active', bRam = foes && bBow && b.ram && b.state === 'active';
    const base = closing * .09 * (foes ? 1 : .5);
    const toB = base * Math.sqrt(a.maxHull / b.maxHull) * (aRam ? RAM.deal : 1) * (bRam ? RAM.take : 1) * (aBow && !bBow ? 1.25 : 1);
    const toA = base * Math.sqrt(b.maxHull / a.maxHull) * (bRam ? RAM.deal : 1) * (aRam ? RAM.take : 1) * (bBow && !aBow ? 1.25 : 1);
    const men = v => Math.floor(v * rand(.05, .15));
    // the blow takes the way off both ships, the striker most
    a.speed *= aBow ? .35 : .7; b.speed *= bBow ? .35 : .7;
    const x = r1((a.x + b.x) / 2), y = r1((a.y + b.y) / 2);
    if (aRam || bRam) {
      const [r, v] = aRam ? [a, b] : [b, a];
      this.msg(`${r.name} rams the ${v.name}!`, v);
    } else if (Math.max(toA, toB) > 6) this.msg(`${a.name} and ${b.name} collide!`);
    this.emit('ram', { a: a.id, b: b.id, x, y, hard: +(Math.max(toA, toB)).toFixed(1) });
    this.hurt(b, toB, toB * .3, men(toB));
    this.hurt(a, toA, toA * .3, men(toA));
  }
}
function canBoard(a, b) {
  return dist(a, b) < (a.c.len + b.c.len) * .42 + 16 && Math.hypot(a.vx - b.vx, a.vy - b.vy) < 75;
}
const r1 = v => Math.round(v * 10) / 10;
