'use strict';
// On-screen controls for touch screens. They only appear on a device whose main pointer is coarse (a phone or
// tablet), or once the screen is first touched, so desktop browsers keep the keyboard and mouse as they were.
// Every button simply presses a key in `Input`, so the overworld, battles, the chart and multiplayer read touch
// exactly as they read the keyboard.
const TouchUI = {
  on: false, el: null, btns: {}, held: new Map(), layout: '', labels: '',

  init() {
    const coarse = window.matchMedia && matchMedia('(pointer: coarse)').matches;
    if (coarse || navigator.maxTouchPoints > 0 && !matchMedia('(pointer: fine)').matches) this.enable();
    else addEventListener('pointerdown', e => { if (e.pointerType === 'touch') this.enable(); });
  },
  enable() {
    if (this.on) return;
    this.on = true; document.body.classList.add('touch');
    this.build(); Game.resize();
  },

  // [id, label, key, group, hold] — a held button keeps its key down until released (steering, chart zoom)
  DEFS: [
    ['up', '▲<small>sail</small>', 'w', 'pad'], ['down', '▼<small>sail</small>', 's', 'pad'],
    ['left', '◀', 'a', 'pad', true], ['right', '▶', 'd', 'pad', true],
    ['a1', '1', '1', 'ammo'], ['a2', '2', '2', 'ammo'], ['a3', '3', '3', 'ammo'],
    ['board', '⚓<small>board</small>', 'b', 'guns'], ['bow', '➹<small>chaser</small>', 'r', 'guns'],
    ['port', '◀<small>port</small>', 'q', 'guns'], ['fire', '💥<small>fire</small>', ' ', 'guns'], ['stbd', '▶<small>stbd</small>', 'e', 'guns'],
    ['menu', '☰', 'Escape', 'util'], ['chart', '🗺', 'c', 'util'], ['pause', '⏸', 'p', 'util'], ['help', '?', 'h', 'util'],
    ['tab', '⇆', 'Tab', 'util'], ['fleet', '⚑', 'f', 'util'], ['mute', '🔊', 'm', 'util'], ['full', '⛶', null, 'util'],
    ['dock', '⚓ Dock', 'Enter', 'dock'],
    ['zin', '+', '+', 'zoom', true], ['zout', '−', '-', 'zoom', true], ['find', '⌖', ' ', 'zoom'], ['close', '✕', 'Escape', 'zoom'],
  ],
  build() {
    const root = this.el = document.createElement('div'); root.id = 'touch';
    const groups = {};
    for (const g of ['pad', 'ammo', 'guns', 'util', 'dock', 'zoom']) { groups[g] = document.createElement('div'); groups[g].className = 'tg tg-' + g; root.appendChild(groups[g]); }
    for (const [id, label, key, group, hold] of this.DEFS) {
      const b = document.createElement('button'); b.className = 'tb tb-' + id; b.innerHTML = label;
      this.btns[id] = b; groups[group].appendChild(b);
      const up = e => { const k = this.held.get(e.pointerId); if (k) { this.held.delete(e.pointerId); this.release(k); b.classList.remove('on'); } };
      b.addEventListener('pointerdown', e => {
        e.preventDefault(); e.stopPropagation(); // the chart must not take this for a drag
        Sfx.init();
        if (id === 'full') return this.fullscreen();
        this.press(key); b.classList.add('on');
        if (hold) this.held.set(e.pointerId, key);
        else setTimeout(() => { this.release(key); b.classList.remove('on'); }, 90);
      });
      for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) b.addEventListener(ev, up);
      b.addEventListener('contextmenu', e => e.preventDefault());
    }
    this.groups = groups;
    document.body.appendChild(root);
  },
  press(k) { if (!Input.down.has(k)) Input.hit.add(k); Input.down.add(k); },
  release(k) { Input.down.delete(k); },
  releaseAll() { for (const k of this.held.values()) this.release(k); this.held.clear(); for (const id in this.btns) this.btns[id].classList.remove('on'); },
  fullscreen() {
    const d = document, el = d.documentElement;
    if (d.fullscreenElement || d.webkitFullscreenElement) return (d.exitFullscreen || d.webkitExitFullscreen).call(d);
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!req) return;
    const p = req.call(el);
    if (p && p.then) p.then(() => screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape').catch(() => {})).catch(() => {});
  },

  // the ship you are steering in a battle, if any
  myShip() {
    if (Game.mode === 'battle' && Game.battle) return Game.battle.sim.helm;
    if (Game.mode === 'mp') return Net.me;
    return null;
  },
  // Called every frame: works out which buttons belong on screen and only touches the DOM when that changes.
  update() {
    if (!this.on) return;
    const mode = Game.mode;
    let lay = '';
    if (!UI.open) {
      if (mode === 'map' && Game.map) lay = ChartView.open ? 'chart' : 'map';
      else if (mode === 'battle' && Game.battle) lay = 'battle';
      else if (mode === 'mp' && Net.phase === 'battle' && Net.mirror) lay = 'battle';
    }
    const me = this.myShip(), live = lay === 'battle' && me && me.state === 'active';
    const grap = live && !!me.grapple;
    const fleet = mode === 'battle' && Game.battle && Game.battle.sim.ships.filter(o => o.commandable && o.state === 'active').length > 1;
    const show = {
      pad: lay === 'map' || live && !grap, ammo: live, guns: live && !grap, dock: lay === 'map' && !!Game.map.nearPort,
      util: lay === 'map' || lay === 'battle', zoom: lay === 'chart',
    };
    const vis = {
      menu: lay === 'map', chart: lay === 'map', pause: mode === 'battle', help: lay === 'battle',
      tab: lay === 'battle' && (mode === 'mp' || fleet), fleet: lay === 'map' || fleet, bow: live && !!me.bow,
      full: !!(document.fullscreenEnabled || document.webkitFullscreenEnabled),
    };
    const key = lay + JSON.stringify(show) + JSON.stringify(vis);
    if (key !== this.layout) {
      if (lay !== this.layout.split('{')[0]) this.releaseAll(); // nothing stays held across a change of scene
      this.layout = key;
      this.el.className = lay ? 'lay-' + lay + (grap ? ' grap' : '') : 'hidden';
      for (const g in show) this.groups[g].style.display = show[g] ? '' : 'none';
      for (const id in vis) this.btns[id].style.display = vis[id] ? '' : 'none';
    }
    // labels that follow the game: shot or stance names, mute, the dock's port, where the util row sits
    const ammoKeys = Object.keys(AMMO);
    const names = grap ? STANCES.map(k => STANCE_NAME[k].split(' ')[0]) : ammoKeys.map(k => AMMO[k].name.split(' ')[0]);
    const sel = !live ? -1 : grap ? STANCES.indexOf(me.ctrl.stance) : ammoKeys.indexOf(me.ammo);
    const lab = names.join() + sel + Sfx.muted + (show.dock ? Game.map.nearPort.name : '') + Game.paused + Math.round(Game.uiS * 100);
    if (lab !== this.labels) {
      this.labels = lab;
      names.forEach((n, i) => { const b = this.btns['a' + (i + 1)]; b.innerHTML = `${i + 1}<small>${n}</small>`; b.classList.toggle('sel', i === sel); });
      this.btns.mute.textContent = Sfx.muted ? '🔇' : '🔊';
      this.btns.pause.textContent = Game.paused ? '▶' : '⏸';
      if (show.dock) this.btns.dock.innerHTML = `⚓ Dock at ${esc(Game.map.nearPort.name)}`;
      // the row of small buttons sits just under the stats panel in the top-left corner
      this.groups.util.style.top = `calc(env(safe-area-inset-top, 0px) + ${Math.round((lay === 'map' ? 166 : 154) * Game.uiS)}px)`;
    }
  },
  // a screen point (CSS px) in the game's own coordinates, which are scaled down on small screens
  pt(e) { return { x: e.clientX / Game.uiS, y: e.clientY / Game.uiS }; },
};
