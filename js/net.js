'use strict';
// Multiplayer client: the server runs the battle; this sends our orders and
// renders the server's snapshots through the same BattleView as single player.
const TEAM_NAMES = ['Red Banner', 'Black Banner'];
const STATE_CODES = ['active', 'sinking', 'sunk', 'surrendered', 'captured', 'escaped'];

const Net = {
  ws: null, id: null, lobby: null, phase: 'off', mirror: null, view: null, me: null, ctrl: null,
  sentIn: '', sendT: 0, snapDt: 1 / 15, lastSnapAt: 0, interpT: 1, pendingEv: [], resultsOpen: false, endBanner: null,

  available() { return location.protocol === 'http:' || location.protocol === 'https:'; },

  // ---------- connection ----------
  start(name) {
    this.phase = 'connecting'; this.lobby = null; this.mirror = null;
    UI.show(`<h1>Hailing the harbour…</h1><p class="hint">Connecting to ${esc(location.host)}</p>`, () => { });
    const ws = this.ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    ws.onopen = () => this.send({ t: 'hello', name });
    ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch (err) { return; } this.handle(m); };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null; this.phase = 'off';
      UI.show(`<h1>Connection lost</h1><p>The link to the server was cut. If the host restarted the server or tunnel, ask them for the new invite link.</p><div class="row"><button class="primary" data-a="ok">Back to title</button></div>`, () => { UI.hide(); Game.title(); });
    };
  },
  leave() { const ws = this.ws; this.ws = null; this.phase = 'off'; if (ws) ws.close(); Game.title(); },
  send(o) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); },

  handle(m) {
    switch (m.t) {
      case 'welcome': this.id = m.id; this.phase = 'lobby'; break;
      case 'lobby':
        this.lobby = m;
        if (this.phase !== 'battle' && !this.resultsOpen) this.renderLobby();
        break;
      case 'note':
        if (this.view) this.view.msg(m.text, '#ffd24a');
        else if (this.phase === 'lobby' && !this.resultsOpen) { this.note = m.text; this.renderLobby(); }
        break;
      case 'start': this.startBattle(m); break;
      case 'snap': if (this.mirror) this.snap(m); break;
      case 'end': this.endBattle(m); break;
    }
  },

  // ---------- lobby ----------
  renderLobby() {
    const L = this.lobby; if (!L) return;
    const me = L.players.find(p => p.id === this.id) || {};
    const host = !!me.host, inBattle = L.phase === 'battle';
    const teamCol = team => {
      const ps = L.players.filter(p => p.team === team).map(p =>
        `<div class="item"><span>☠ <b>${esc(p.name)}</b>${p.host ? ' (host)' : ''}${p.id === this.id ? ' — you' : ''}</span><span>${SHIP_CLASSES[p.cls].name}${GUNS[p.gun] ? ` · ${GUNS[p.gun].name}` : ''}${p.bow ? ' · chaser' : ''}${p.ram ? ' · ram' : ''}</span></div>`);
      const ai = L.ai.map((a, i) => a.team !== team ? '' :
        `<div class="item"><span>⚙ AI captain</span><span>${SHIP_CLASSES[a.cls].name}${host && !inBattle ? ` <button data-a="del_${i}">✕</button>` : ''}</span></div>`);
      const add = host && !inBattle && L.ai.length < L.maxAI ? `<div class="item"><span>Add AI:</span><span>${Object.keys(SHIP_CLASSES).map(k => `<button data-a="add_${team}_${k}">${SHIP_CLASSES[k].name}</button>`).join('')}</span></div>` : '';
      return `<section><h3>${team ? '🏴' : '🚩'} ${TEAM_NAMES[team]}</h3>${ps.join('')}${ai.join('')}${ps.length + ai.filter(Boolean).length ? '' : '<p class="hint">no ships</p>'}${add}</section>`;
    };
    const sides = [0, 1].map(t => L.players.some(p => p.team === t) || L.ai.some(a => a.team === t));
    const canStart = sides[0] && sides[1];
    UI.show(`<h1>⚔ Multiplayer battle</h1>
      ${L.invite ? `<p class="stats">Invite link for friends: <b>${esc(L.invite)}</b></p>` : `<p class="hint">Friends join at this page's address. Start the server with <b>--tunnel</b> to get a public invite link.</p>`}
      ${this.note ? `<p class="hint">${esc(this.note)}</p>` : ''}
      <div class="cols">${teamCol(0)}${teamCol(1)}</div>
      ${inBattle ? '<p class="hint">A battle is under way — you will join the next one.</p>' : `
      <div class="item"><span><b>Your ship</b></span><span>${Object.keys(SHIP_CLASSES).map(k => `<button data-a="cls_${k}" ${me.cls === k ? 'disabled' : ''}>${SHIP_CLASSES[k].name}</button>`).join('')}</span></div>
      <div class="item"><span><b>Your guns</b></span><span>${Object.keys(GUNS).map(k => `<button data-a="gun_${k}" title="${esc(GUNS[k].desc)}" ${me.gun === k ? 'disabled' : ''}>${GUNS[k].name}</button>`).join('')}</span></div>
      <div class="item"><span><b>Fittings</b></span><span><button data-a="bow_${me.bow ? 0 : 1}">${me.bow ? '☑' : '☐'} Bow chaser</button><button data-a="ram_${me.ram ? 0 : 1}">${me.ram ? '☑' : '☐'} Ram</button></span></div>
      <div class="item"><span><b>Your side</b></span><span>${[0, 1].map(t => `<button data-a="team_${t}" ${me.team === t ? 'disabled' : ''}>${TEAM_NAMES[t]}</button>`).join('')}</span></div>
      <p class="hint">Same side = fight together against AI ships · opposite sides = fight each other</p>`}
      <div class="row">${host ? `<button class="primary" data-a="start" ${canStart && !inBattle ? '' : 'disabled'}>Start battle</button>` : `<span class="hint">${inBattle ? '' : 'Waiting for the host to start the battle…'}</span>`}
      <button data-a="leave">Leave</button></div>
      ${host && !canStart && !inBattle ? '<p class="hint">Each side needs at least one ship — move a player across or add AI ships.</p>' : ''}`,
      a => {
        this.note = null;
        if (a === 'leave') return this.leave();
        if (a === 'start') return this.send({ t: 'start' });
        const [k, x, y] = a.split('_');
        if (k === 'cls') this.send({ t: 'set', cls: x });
        else if (k === 'team') this.send({ t: 'set', team: +x });
        else if (k === 'gun') this.send({ t: 'set', gun: x });
        else if (k === 'bow' || k === 'ram') this.send({ t: 'set', [k]: x === '1' });
        else if (k === 'add') this.send({ t: 'addAI', team: +x, cls: y });
        else if (k === 'del') this.send({ t: 'delAI', i: +x });
      });
  },

  // ---------- battle ----------
  startBattle(m) {
    const ships = m.ships.map(o => {
      const s = new Ship({ cls: o.cls, style: o.style, name: o.name, team: o.team, gun: o.gun, bow: o.bow, ram: o.ram });
      Object.assign(s, { id: o.id, guns: o.guns, maxHull: o.maxHull, hull: o.maxHull, maxCrew: o.maxCrew, crew: o.maxCrew, reloadBase: o.reloadBase, human: o.human, boss: o.boss, grapple: null });
      return s;
    });
    this.mirror = { ships, wind: { dir: 0, str: 1 }, R: m.R, grapples: [], t: 0 };
    this.me = m.you != null ? ships[m.you] : null;
    this.ctrl = { rudder: 0, sail: 1, ammo: 'round', stance: 'charge', acts: [] };
    if (this.me) this.me.ctrl = this.ctrl;
    this.view = new BattleView(this.me);
    this.pendingEv = []; this.interpT = 1; this.lastSnapAt = 0; this.sentIn = ''; this.endBanner = null; this.first = true;
    this.phase = 'battle'; Game.mode = 'mp';
    if (!this.resultsOpen) UI.hide();
    if (!this.me) this.view.msg('Spectating — you will join the next battle', '#ffd24a');
  },
  snap(m) {
    const mi = this.mirror, now = performance.now() / 1000;
    for (const ev of this.pendingEv.splice(0)) this.view.event(ev, mi); // flush the previous snapshot's events
    if (this.lastSnapAt) this.snapDt = clamp(lerp(this.snapDt, now - this.lastSnapAt, .2), 1 / 30, .25);
    this.lastSnapAt = now; this.interpT = 0;
    mi.t = m.time; mi.wind.dir = m.w[0]; mi.wind.str = m.w[1];
    m.s.forEach((d, i) => {
      const s = mi.ships[i]; if (!s) return;
      const [x, y, h, sp, sail, sailHp, hull, crew, st, sinkT, rl, rr, am, stock, rf, burn] = d;
      s.p0 = this.first ? { x, y, h } : { x: s.x, y: s.y, h: s.heading };
      s.p1 = { x, y, h };
      if (this.first) { s.x = x; s.y = y; s.heading = h; }
      Object.assign(s, { speed: sp, sail, sailHp, hull, crew, state: STATE_CODES[st], sinkT, ammo: Object.keys(AMMO)[am] });
      s.reload.L = rl; s.reload.R = rr; s.reload.F = rf || 0; s.burn = burn || 0;
      if (stock) s.stock = { chain: stock[0], grape: stock[1] };
      s.grapple = null;
    });
    mi.grapples = m.g.map(([a, b, log]) => ({ a: mi.ships[a], b: mi.ships[b], log }));
    for (const g of mi.grapples) g.a.grapple = g.b.grapple = g;
    this.pendingEv.push(...m.ev);
    const me = this.me; // our shot locker ran dry: fall back to round shot instead of re-asking
    if (me && me.stock && this.ctrl.ammo !== 'round' && me.stock[this.ctrl.ammo] <= 0 && me.ammo === 'round') this.ctrl.ammo = 'round';
    if (m.over && !this.endBanner) this.endBanner = this.banner(m.winner);
    this.first = false;
  },
  banner(winner) {
    if (winner == null) return { text: 'NO VICTOR', col: '#f5e9c8' };
    if (!this.me) return { text: `${TEAM_NAMES[winner].toUpperCase()} WINS`, col: '#ffd24a' };
    return winner === this.me.team ? { text: 'VICTORY', col: '#ffd24a' } : { text: 'DEFEAT', col: '#ff7a6a' };
  },
  update(dt) {
    if (this.phase !== 'battle' || !this.mirror) return;
    const mi = this.mirror, me = this.me;
    this.interpT += dt / this.snapDt;
    const k = Math.min(this.interpT, 1.3);
    for (const s of mi.ships) {
      if (!s.p1) continue;
      s.x = lerp(s.p0.x, s.p1.x, k); s.y = lerp(s.p0.y, s.p1.y, k);
      s.heading = s.p0.h + angDiff(s.p1.h, s.p0.h) * k;
      s.reload.L = Math.max(0, s.reload.L - dt); s.reload.R = Math.max(0, s.reload.R - dt); s.reload.F = Math.max(0, s.reload.F - dt);
    }
    if (this.interpT >= 1) for (const ev of this.pendingEv.splice(0)) this.view.event(ev, mi);
    // orders
    const c = this.ctrl;
    if (me && me.state === 'active' && !UI.open && !this.endBanner) readBattleKeys(c, me);
    else c.rudder = 0;
    if (c.acts.length) { this.send({ t: 'act', a: c.acts.splice(0, 8) }); c.acts.length = 0; }
    this.sendT -= dt;
    const st = JSON.stringify([c.rudder, c.sail, c.ammo, c.stance]);
    if (me && (st !== this.sentIn || this.sendT <= 0)) {
      this.sentIn = st; this.sendT = .5;
      this.send({ t: 'in', r: c.rudder, s: c.sail, a: c.ammo, st: c.stance });
    }
    if (Input.was('Tab') && !UI.open) this.view.cycleFollow(mi);
    this.view.update(dt, mi);
  },
  draw(ctx, W, H) {
    if (this.mirror && this.view) this.view.draw(ctx, W, H, this.mirror, this.endBanner);
    else drawWater(ctx, Game.t * 30, Game.t * 12, 1, W, H, Game.t);
  },
  endBattle(m) {
    this.phase = 'lobby'; this.resultsOpen = true;
    const title = m.winner == null ? 'No victor' : `${TEAM_NAMES[m.winner]} is victorious!`;
    const mine = this.me ? (m.winner === this.me.team ? '<p>Your side carried the day.</p>' : m.winner == null ? '' : '<p>Your side was beaten.</p>') : '';
    const word = { active: 'still fighting', sinking: 'sunk', sunk: 'sunk', surrendered: 'surrendered', captured: 'captured', escaped: 'fled' };
    UI.show(`<h1>${esc(title)}</h1>${mine}
      <div class="cols">${[0, 1].map(t => `<section><h3>${TEAM_NAMES[t]}</h3>${m.ships.filter(s => s.team === t).map(s =>
        `<div class="item"><span>${s.human ? '☠ ' : ''}<b>${esc(s.name)}</b> (${SHIP_CLASSES[s.cls].name})</span><span>${word[s.state]}</span></div>`).join('')}</section>`).join('')}</div>
      <div class="row"><button class="primary" data-a="ok">Back to the lobby</button></div>`,
      () => {
        this.resultsOpen = false;
        if (this.phase === 'battle') { UI.hide(); return; } // the host already started the next one
        this.mirror = null; this.view = null; this.me = null; this.renderLobby();
      });
  },
};
