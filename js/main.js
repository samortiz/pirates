'use strict';
const UP_COST = [600, 1400, 2800];
const UP_INFO = { hull: ['Oak bracing', '+15% hull'], sails: ['Fine canvas', '+7% speed'], guns: ['Gun drill', '-12% reload'] };
const KEYS_HTML = `<div class="keys">
  <b>A / D</b><span>Steer to port / starboard (arrow keys work too)</span>
  <b>W / S</b><span>Raise / lower sail — furled, half, full</span>
  <b>Q / E</b><span>Fire the port / starboard broadside</span>
  <b>R</b><span>Fire the bow chaser dead ahead (if your ship mounts one)</span>
  <b>Space</b><span>Fire whichever side faces the nearest enemy</span>
  <b>1 2 3</b><span>Round shot (hull) · chain shot (sails) · grapeshot (crew)</span>
  <b>B</b><span>Grapple and board an enemy when alongside at a matching speed</span>
  <b>1 2 3 (boarding)</b><span>Melee stance: charge · crossbow volley · shield wall — switch often, the enemy adapts</span>
  <b>Tab</b><span>Take command of the next ship in your fleet (multiplayer: watch another ship after yours is out)</span>
  <b>F</b><span>Fleet orders — in battle: engage at will · form on me; at sea: send ships to a port or recall them</span>
  <b>Enter</b><span>Dock when near a port</span>
  <b>C</b><span>Chart of the known world: coasts and ports, no ships (at sea; drag or WASD to pan, wheel or +/− to zoom)</span>
  <b>L</b><span>Captain's log: save, load and rename voyages (at sea)</span>
  <b>P · M · H</b><span>Pause · mute · this help</span></div>
  <p class="hint">Mind the wind: a ship flies on a broad reach, crawls close-hauled, and stalls pointing into it. Your guns only bear abeam — turn to bring a broadside on target.</p>
  <p class="hint">Ships that strike each other at speed both take damage — the heavier ship less. A ram on your bow multiplies the blow and spares your own planking. Flame cannon set ships afire; a full crew beats the flames out faster.</p>`;

const Game = {
  mode: 'title', battle: null, map: null, W: 0, H: 0, zoom: 1, dpr: 1, paused: false, t: 0,

  init() {
    this.cv = document.getElementById('c'); this.ctx = this.cv.getContext('2d');
    const resize = () => {
      this.dpr = Math.min(2, window.devicePixelRatio || 1);
      this.W = innerWidth; this.H = innerHeight;
      this.cv.width = this.W * this.dpr; this.cv.height = this.H * this.dpr;
      this.zoom = clamp(Math.min(this.W, this.H) / 780, .55, 1.5);
    };
    addEventListener('resize', resize); resize();
    Input.init(); UI.init(); this.title();
    let last = performance.now();
    const loop = now => { const dt = Math.min(.05, (now - last) / 1000); last = now; this.frame(dt); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  },

  frame(dt) {
    this.t += dt;
    if (Input.was('m')) Sfx.muted = !Sfx.muted;
    if (!UI.open && (this.mode === 'map' || this.mode === 'battle')) {
      if (Input.was('p')) this.paused = !this.paused;
      if (Input.was('h')) this.help();
      if (this.mode === 'map' && !ChartView.open && Input.was('l')) this.logBook();
      if (this.mode === 'map' && !ChartView.open && Input.was('f')) this.fleetOrders();
      if (this.mode === 'map' && !ChartView.open && Input.was('c')) { ChartView.show(this.map); Input.endFrame(); }
    }
    if (!UI.open && this.mode === 'mp' && Net.phase === 'battle' && Input.was('h')) this.help();
    if (!UI.open && !this.paused) {
      if (this.mode === 'battle') this.updateBattle(dt);
      else if (this.mode === 'map') ChartView.open ? ChartView.update(dt, this.W, this.H, this.map) : this.map.update(dt); // the world stands still while you study the chart
    }
    if (this.mode === 'mp') Net.update(dt); // the server never pauses
    const ctx = this.ctx, W = this.W, H = this.H;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (this.mode === 'battle' && this.battle) this.battle.view.draw(ctx, W, H, this.battle.sim, this.battleBanner());
    else if (this.mode === 'map' && this.map) ChartView.open ? ChartView.draw(ctx, W, H, this.map) : this.map.draw(ctx, W, H);
    else if (this.mode === 'mp') Net.draw(ctx, W, H);
    else drawWater(ctx, this.t * 30, this.t * 12, 1, W, H, this.t);
    if (this.paused) hudText(ctx, 'PAUSED — press P', W / 2, H / 2, 40, '#fff3c4', 'center', true);
    if (Sfx.muted) hudText(ctx, 'muted', W - 16, H - 12, 12, '#fff', 'right');
    Input.endFrame();
  },

  // ---------- menus ----------
  title() {
    this.mode = 'title';
    UI.show(`<h1>⚓ Corsairs of the Shattered Sea ⚓</h1>
      <h2>A tale of black powder, grey canvas and gold</h2>
      <p>You command a leaky cog and two dozen rogues. Prowl the sea lanes, plunder fat merchants, outfight rival pirates, and spend your spoils in port on guns, crew and bigger ships — until your legend is dark enough to draw out <b>Admiral Mordrake</b> himself.</p>
      ${KEYS_HTML}
      <div class="row"><button class="primary" data-a="new">New voyage</button>
      <button data-a="cont" ${Campaign.hasSave() ? '' : 'disabled'}>Continue voyage</button>
      <button data-a="load" ${Campaign.hasSave() ? '' : 'disabled'}>Load voyage</button>
      <button data-a="mp" ${Net.available() ? '' : 'disabled'}>⚔ Multiplayer battle</button></div>
      ${Net.available() ? '' : '<p class="hint">Multiplayer needs the game server: run <b>node server/server.js</b> and open the address it prints.</p>'}`,
      a => {
        if (a === 'mp') return this.mpName();
        if (a === 'new') return this.slotMenu('new');
        if (a === 'load') return this.slotMenu('load');
        const l = Campaign.latest(); // the newest save, manual or auto
        if (l && Campaign.load(l.i, l.auto)) this.startVoyage(false);
      });
  },
  startVoyage(isNew) {
    UI.hide(); ChartView.hide(); this.paused = false; this.map = new WorldMap(); this.mode = 'map';
    if (isNew) Campaign.saveManual(); // a new voyage starts with a manual save to come back to; loading saves nothing, so the other save survives
    if (isNew) this.map.msg(isMerchant() ? 'Dock at any port with ENTER to trade. Buy where goods are made, sell where they are wanted, and beware black sails. Press L for the captain\'s log.' : 'Dock at any port with ENTER. Merchants are easy prey. Press L for the captain\'s log.');
    else this.map.msg(`Voyage "${Campaign.name}" resumed`);
  },

  // ---------- save slots ----------
  slotLine(d, i, auto = false) {
    if (!d) return auto ? `<span><small><i>No autosave yet</i></small></span>` : `<span><b>Slot ${i + 1}</b> — <i>empty</i></span>`;
    const s = d.s, when = d.time ? new Date(d.time).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
    return `<span>${auto ? `<b>↳ Autosave</b>` : `<b>Slot ${i + 1}: ${esc(d.name)}</b>`}<br><small>${esc(s.ship.name)} (${SHIP_CLASSES[s.ship.cls].name}) · ${s.career === 'merchant' ? `merchant · standing ${s.trade || 0}` : `pirate · fame ${fameOf(s)}`} · day ${Math.floor(s.day)} · ${s.gold} gold aboard · saved ${esc(when)}</small></span>`;
  },
  // mode 'new' starts a voyage in a slot, 'save' saves the current one there, 'load' loads or deletes
  slotMenu(mode, back = () => this.title()) {
    const slots = Campaign.slots(), inGame = mode !== 'new' && this.mode === 'map';
    const head = { new: 'Choose a berth for your new voyage', save: 'Save your voyage to which slot?', load: 'Load which voyage?' }[mode];
    const rows = slots.map((d, i) => {
      const cur = inGame && i === Campaign.slot ? ' <i>(current)</i>' : '';
      const man = Campaign.readSlot(i), auto = Campaign.readAuto(i);
      if (mode !== 'load') return `<div class="item">${this.slotLine(man || auto, i)}${cur}<span><button data-a="pick_${i}">${d ? 'Overwrite' : 'Use'}</button></span></div>`;
      const autoRow = auto ? `<div class="item" style="margin-left:24px">${this.slotLine(auto, i, true)}<span><button data-a="loadauto_${i}">Load autosave</button></span></div>` : '';
      return `<div class="item">${man || !auto ? this.slotLine(man, i) : `<span><b>Slot ${i + 1}: ${esc(auto.name)}</b> — <i>no manual save</i></span>`}${cur}<span>`
        + `<button data-a="load_${i}" ${man ? '' : 'disabled'}>Load</button><button data-a="del_${i}" ${d ? '' : 'disabled'}>Delete</button></span></div>${autoRow}`;
    }).join('');
    UI.show(`<h1>📜 ${head}</h1>${rows}<div class="row"><button class="primary" data-a="back" data-k="Escape">Back</button></div>`, a => {
      if (a === 'back') return back();
      const [act, n] = a.split('_'), i = +n;
      if (act === 'load' || act === 'loadauto') { if (Campaign.load(i, act === 'loadauto')) this.startVoyage(false); return; }
      if (act === 'del') return this.confirm(`Delete <b>${esc(slots[i].name)}</b> from slot ${i + 1}, with its autosave? This cannot be undone.`, 'Delete it',
        () => { Campaign.remove(i); this.slotMenu(mode, back); }, () => this.slotMenu(mode, back));
      if (act === 'pick') this.nameVoyage(mode, i, slots[i], back);
    });
  },
  nameVoyage(mode, i, existing, back, onBack = () => this.slotMenu(mode, back)) {
    const def = mode === 'save' ? Campaign.name : existing ? existing.name : 'Voyage ' + (i + 1);
    const warn = existing && !(mode === 'save' && i === Campaign.slot) ? `<p class="hint">This will overwrite <b>${esc(existing.name)}</b>.</p>` : '';
    UI.show(`<h1>Name your voyage</h1>
      <p style="text-align:center"><input id="voyname" maxlength="24" value="${esc(def)}" style="font:inherit;font-size:18px;padding:6px;width:260px"></p>${warn}
      <div class="row"><button class="primary" data-a="ok">${mode === 'new' ? 'Set sail' : 'Save'}</button><button data-a="back" data-k="Escape">Back</button></div>`, a => {
      if (a === 'back') return onBack();
      const name = document.getElementById('voyname').value.trim().slice(0, 24) || 'Voyage ' + (i + 1);
      if (i !== Campaign.slot || mode === 'new') Campaign.removeAuto(i); // that slot's autosave belonged to the voyage being overwritten
      if (mode === 'new') return this.chooseCareer(i, name, () => this.nameVoyage(mode, i, existing, back, onBack));
      Campaign.slot = i; Campaign.name = name;
      const ok = Campaign.saveManual(); UI.hide();
      this.map.msg(ok ? `Saved "${name}" to slot ${i + 1}` : 'Could not save: browser storage is unavailable', ok ? '#bfe0a0' : '#ff9a8a');
    });
    setTimeout(() => { const el = document.getElementById('voyname'); if (el) { el.focus(); el.select(); } }, 30);
  },
  chooseCareer(i, name, onBack) {
    UI.show(`<h1>What manner of captain?</h1>
      <div class="item"><span><b>☠ Pirate</b> — take what you want from the merchants of the Shattered Sea. Plunder, ransom and tribute make you rich, but every navy patrol that sees you at it will hunt you, and pirate hunters will not leave you be. Grow your legend until Admiral Mordrake himself comes for you.</span></div>
      <div class="item"><span><b>⚖ Merchant</b> — buy cheap, sell dear and carry the Guild's cargoes. Guild members get better prices in every market and the navy and pirate hunters leave you alone, but pirates hunt you, the more so when your hold is full. Earn a seat on the Merchant Guild.</span></div>
      <p class="hint">You can change your colours later: a merchant who attacks an honest ship turns pirate, and a pirate can buy a royal pardon and a Guild charter in any port.</p>
      <div class="row"><button class="primary" data-a="pirate" data-k="1">[1] Pirate</button><button data-a="merchant" data-k="2">[2] Merchant</button><button data-a="back" data-k="Escape">Back</button></div>`, a => {
      if (a === 'back') return onBack();
      Campaign.newGame(i, name, a); this.startVoyage(true);
    });
  },
  // a merchant who falls on honest shipping is a pirate from then on
  turnPirate() {
    const s = Campaign.s; if (!isMerchant()) return;
    s.career = 'pirate'; Sfx.horn();
    this.map.msg('You run up the black flag. The Guild strikes your name from its rolls: you are a pirate now.', '#ff9a8a');
  },
  // what you give up by swapping your flagship for a smaller class, or null when it isn't a step down
  downgradeHtml(toCls) {
    const s = Campaign.s, a = SHIP_CLASSES[s.ship.cls], b = SHIP_CLASSES[toCls];
    if (b.cost >= a.cost) return null;
    const row = (label, x, y, more = true) => x === y ? '' : `<li>${label}: ${x} → <b>${y}</b>${(more ? y < x : y > x) ? ' ⚠' : ''}</li>`;
    const fired = s.ship.crew - b.crew, dump = holdUsed(s) - (holdCap(s) - a.cargo + b.cargo);
    return `<p>The <b>${b.name}</b> is a smaller ship than your <b>${a.name}</b>.</p><ul>
      ${row('Hull', a.hull, b.hull)}${row('Guns a side', a.guns, b.guns)}${row('Crew berths', a.crew, b.crew)}${row('Hold', a.cargo, b.cargo)}${row('Speed', a.speed, b.speed)}${row('Handling', a.turn, b.turn)}</ul>
      ${fired > 0 ? `<p><b>${fired}</b> of your ${s.ship.crew} crew won't fit and will be paid off.</p>` : ''}
      ${dump > 0 ? `<p><b>${dump}</b> crates of your cheapest cargo will go over the side.</p>` : ''}`;
  },
  confirm(html, yes, onYes, onNo) {
    UI.show(`<h1>Are you sure?</h1><p>${html}</p><div class="row"><button data-a="yes">${yes}</button><button class="primary" data-a="no" data-k="Escape">Cancel</button></div>`,
      a => a === 'yes' ? onYes() : onNo());
  },
  logBook() {
    const back = () => this.logBook();
    UI.show(`<h1>📖 Captain's log</h1>
      <div class="item">${this.slotLine(Campaign.readSlot(Campaign.slot), Campaign.slot)}</div>
      <div class="item" style="margin-left:24px">${this.slotLine(Campaign.readAuto(Campaign.slot), Campaign.slot, true)}</div>
      <p class="hint">The voyage autosaves whenever you dock or finish a battle. Autosaves are kept apart and never overwrite the save you make here.</p>
      ${Quests.logHtml()}${this.holdingsList()}
      <div class="row"><button class="primary" data-a="save">Save</button>
      <button data-a="saveas">Save to another slot…</button>
      <button data-a="rename">Rename</button>
      <button data-a="load">Load voyage…</button>
      <button data-a="quit">Save &amp; quit to title</button>
      <button data-a="close" data-k="Escape">Back to sea</button></div>`, a => {
      if (a === 'close') return UI.hide();
      if (a === 'save') { const ok = Campaign.saveManual(); UI.hide(); return this.map.msg(ok ? `Saved "${Campaign.name}"` : 'Could not save: browser storage is unavailable', ok ? '#bfe0a0' : '#ff9a8a'); }
      if (a === 'saveas') return this.slotMenu('save', back);
      if (a === 'rename') return this.nameVoyage('save', Campaign.slot, null, back, back);
      if (a === 'load') return this.slotMenu('load', back);
      if (a === 'quit') { Campaign.saveManual(); this.map = null; return this.title(); }
    });
  },
  mpName() {
    let name = '';
    try { name = localStorage.getItem('corsairs-name') || ''; } catch (e) { }
    UI.show(`<h1>⚔ Multiplayer battle</h1><p>What do they call you, Captain?</p>
      <p style="text-align:center"><input id="mpname" maxlength="16" value="${esc(name)}" style="font:inherit;font-size:18px;padding:6px;width:220px"></p>
      <div class="row"><button class="primary" data-a="go">Join the lobby</button><button data-a="back">Back</button></div>`,
      a => {
        if (a === 'back') return this.title();
        const n = document.getElementById('mpname').value.trim().slice(0, 16);
        try { localStorage.setItem('corsairs-name', n); } catch (e) { }
        this.mode = 'mp'; Net.start(n);
      });
    setTimeout(() => { const el = document.getElementById('mpname'); if (el) { el.focus(); el.select(); } }, 30);
  },
  help() {
    UI.show(`<h1>Captain's orders</h1>${KEYS_HTML}<div class="row"><button class="primary" data-a="ok">Aye</button></div>`, () => UI.hide());
  },

  // ---------- port ----------
  dock(port) {
    const s = Campaign.s, pi = PORTS.indexOf(port);
    const news = Quests.onDock(port); let err = '';
    for (const f of wingFleet(s)) { const l = sellCargo(f, port); if (l) news.push(esc(l)); } // what a recalled trade ship still had aboard
    const purses = wingFleet(s).reduce((a, f) => a + takePurse(s, f), 0); if (purses) news.push(`Your fleet's pursers bring <b>${purses}</b> gold across to your strongroom.`);
    const cons = collectConsign(s, pi); if (cons) news.push(cons);
    for (const f of hiredOf(s, 'escort')) { const c = SHIP_CLASSES[f.cls]; f.hull = c.hull; f.sailHp = 100; f.crew = c.crew; } // her owners mend and man her
    const interest = bankSettle(s, pi); if (interest) news.push(`Your counting house here has paid <b>${interest}</b> gold in interest.`);
    if (news.length) Sfx.coin();
    Campaign.save(); Sfx.horn();
    const btn = (a, label, ok = true) => `<button data-a="${a}" ${ok ? '' : 'disabled'}>${label}</button>`;
    const render = () => {
      const c = SHIP_CLASSES[s.ship.cls], maxH = Campaign.maxHull();
      const repair = Math.ceil((maxH - s.ship.hull) * 2 + (100 - s.ship.sailHp));
      const need = c.crew - s.ship.crew, used = holdUsed(s), room = holdCap(s) - used;
      const market = Object.keys(GOODS).filter(g => !GOODS[g].hidden && (g !== 'plunder' || s.hold[g])).map(g => {
        const sell = goodPrice(port, g), next = goodPrice(port, g, s.day + 1), buy = buyPrice(port, g), held = s.hold[g] || 0;
        const owed = Math.min(held, Quests.reserved(g)), have = held - owed; // contract cargo isn't yours to sell
        const tag = g === 'plunder' ? 'old booty: sell it off' : port.makes.includes(g) ? 'made here' : port.wants.includes(g) ? '<b>wanted here</b>' : '';
        const trend = next > sell ? '▲' : next < sell ? '▼' : '';
        const wanted = g === 'plunder' ? '' : ` title="Wanted in ${PORTS.filter(p => p.wants.includes(g)).map(p => p.name).join(', ')}"`;
        const canBuy = g !== 'plunder' && room > 0 && s.gold >= buy;
        return `<div class="item"${wanted}><span><b>${GOODS[g].name}</b>${tag ? ` <i>${tag}</i>` : ''} — sell ${sell}g${trend}${g === 'plunder' ? '' : ` · buy ${buy}g`}${held ? ` · aboard <b>${held}</b>` : ''}${owed ? ` <i>(${owed} under contract)</i>` : ''}</span>
          <span>${btn('sell1_' + g, 'Sell 1', have > 0)}${btn('sellall_' + g, have ? `All ${have * sell}g` : 'All', have > 0)}${g === 'plunder' ? '' : btn('buy1_' + g, 'Buy 1', canBuy) + btn('buy5_' + g, 'Buy 5', canBuy) + btn('buymax_' + g, 'Fill', canBuy)}</span></div>`;
      }).join('');
      const trade = Math.round(c.cost * .4);
      const ups = Object.keys(UP_INFO).map(k => {
        const lv = s.up[k], cost = UP_COST[lv];
        return `<div class="item"><span><b>${UP_INFO[k][0]}</b> ${'★'.repeat(lv)}${'☆'.repeat(3 - lv)} <i>${UP_INFO[k][1]} each</i></span>${lv >= 3 ? '<span>mastered</span>' : btn('up_' + k, cost + 'g', s.gold >= cost)}</div>`;
      }).join('');
      const fit = fitOf(s.ship);
      const arms = Object.keys(GUNS).map(k => {
        const G = GUNS[k], cost = gunCost(k, s.ship.cls);
        const stats = G.fire ? `range ${FIRE_SHOT.range}, sets fires` : `range ×${G.range}, damage ×${G.dmg}, reload ×${G.reload}`;
        return `<div class="item"><span><b>${G.name}</b> <i>${G.desc}</i><br><small>${stats} · ${c.guns} a side</small></span>${fit.gun === k ? '<span>fitted</span>' : btn('gun_' + k, cost ? cost + 'g' : 'Refit free', s.gold >= cost)}</div>`;
      }).join('') + `<div class="item"><span><b>Bow chaser</b> <i>one long gun firing dead ahead (R), for the chase</i></span>${fit.bow ? '<span>fitted</span>' : btn('bowgun', BOW_GUN.cost + 'g', s.gold >= BOW_GUN.cost)}</div>
        <div class="item"><span><b>Bronze ram</b> <i>strike bow-on to stave in their hull</i></span>${fit.ram ? '<span>fitted</span>' : btn('ramfit', ramCost(s.ship.cls) + 'g', s.gold >= ramCost(s.ship.cls))}</div>`;
      const yardHere = isShipyard(port), roomInFleet = ownFleet(s).length < fleetMax(s);
      const yard = Object.keys(SHIP_CLASSES).map(k => {
        const sc = SHIP_CLASSES[k], cost = sc.cost - trade;
        const fits = holdUsed(s) <= holdCap(s) - c.cargo + sc.cargo;
        const flag = k === s.ship.cls ? '<span style="margin-right:8px">yours</span>' : btn('buy_' + k, fits ? (cost >= 0 ? cost + 'g' : '+' + -cost + 'g') : 'Hold too full', s.gold >= cost && fits);
        const fleet = yardHere ? btn('flbuy_' + k, `Fleet ${sc.cost}g`, roomInFleet && s.gold >= sc.cost) : '';
        return `<div class="item"><span><b>${sc.name}</b> — hull ${sc.hull}, crew ${sc.crew}, ${sc.guns} guns a side, speed ${sc.speed}, hold ${sc.cargo}</span><span>${flag}${fleet}</span></div>`;
      }).join('');
      const yardNote = yardHere ? `<p class="hint">"Fleet" buys a ship at full price to sail beside you (${ownFleet(s).length}/${fleetMax(s)}). She comes with no crew: hire at least a quarter of her berths before she will fight.</p>`
        : `<p class="hint">Ships for your fleet are built only at the yards of ${SHIPYARD_PORTS.join(' and ')} (⚒ on the map).</p>`;
      const fleetRows = s.fleet.map((f, i) => {
        if (f.hired) return '';
        const fc = SHIP_CLASSES[f.cls], rep = fleetRepairCost(f), need = fc.crew - f.crew, min = fleetMinCrew(f), ready = fleetReady(f);
        const status = `<br><small>⚑ ${esc(taskText(f))}</small>`;
        if (!fleetHere(f, pi)) return `<div class="item"><span><b>${esc(f.name)}</b> (${fc.name}) — hull <b>${Math.ceil(f.hull)}/${fc.hull}</b> · crew <b>${f.crew}/${fc.crew}</b> <i>(away: dock where she lies to work on her)</i>${status}</span>
          <span>${f.task.type === 'recall' ? '' : btn('flcall_' + i, 'Recall')}</span></div>`;
        const orders = (inWing(f) ? btn('flstay_' + i, 'Station here', ready) : btn('fljoin_' + i, 'Join me') + btn('flgive_' + i, 'Purse +100g', s.gold > 0) + btn('fltake_' + i, `Take purse ${f.gold || 0}g`, f.gold > 0)) + btn('flroute_' + i, 'Trade route…', ready);
        return `<div class="item"><span><b>${esc(f.name)}</b> (${fc.name}) — hull <b>${Math.ceil(f.hull)}/${fc.hull}</b> · sails <b>${Math.round(f.sailHp)}%</b> · crew <b>${f.crew}/${fc.crew}</b> · chain ${f.ammo.chain} · grape ${f.ammo.grape}${f.crew < min ? ` <i style="color:#8b1a1a">needs ${min} hands to fight or sail alone</i>` : ''}${status}</span>
          <span>${orders}${btn('flrep_' + i, rep > 0 ? `Repair ${Math.min(rep, s.gold)}g` : 'Shipshape', rep > 0 && s.gold > 0)}${btn('flcrew5_' + i, '+5 hands', need > 0 && s.gold >= HAND_COST)}${btn('flfill_' + i, need > 0 ? `Man her ${need * HAND_COST}g` : 'Manned', need > 0 && s.gold >= HAND_COST)}${btn('flchain_' + i, `Chain +1 ${SHOT_COST}g`, s.gold >= SHOT_COST && f.ammo.chain < SHOT_MAX)}${btn('flgrape_' + i, `Grape +1 ${SHOT_COST}g`, s.gold >= SHOT_COST && f.ammo.grape < SHOT_MAX)}${btn('flsell_' + i, `Sell ${fleetSalePrice(f)}g`)}</span></div>`;
      }).join('');
      const present = ownFleet(s).filter(f => fleetHere(f, pi));
      const allRep = present.reduce((a, f) => a + fleetRepairCost(f), 0), allNeed = present.reduce((a, f) => a + SHIP_CLASSES[f.cls].crew - f.crew, 0);
      const pc = pardonCost(s), guildHtml = `<section style="grid-column:1/-1"><h3>The Merchant Guild</h3>${isMerchant()
        ? `<div class="item"><span>You sail under a <b>Guild charter</b>: better prices, and the navy and pirate hunters leave you be. Standing <b>${s.trade}</b>${s.guild ? ' · Master of the Guild' : `/${GUILD_GOAL}`}.</span></div>
           <div class="item"><span>Tear up your charter and go on the account</span>${btn('blackflag', 'Turn pirate')}</div>`
        : `<div class="item"><span>Buy a royal pardon and a <b>Guild charter</b>, and turn honest merchant. ${s.boss === 1 ? '<i>No pardon while Admiral Mordrake hunts you.</i>' : 'Navy patrols stop hunting you.'}</span>${btn('pardon', `Pardon ${pc}g`, s.gold >= pc && s.boss !== 1)}</div>`}</section>`;
      const fleetHtml = ownFleet(s).length ? `<section style="grid-column:1/-1"><h3>Your fleet <span style="font-size:12px;font-weight:normal">(${ownFleet(s).length}/${fleetMax(s)} · hands ${HAND_COST}g a head · shot ${SHOT_COST}g a volley)</span></h3>${fleetRows}
          <p class="hint">"Station here" leaves a ship in this port; a trade route sends her round the ports you choose, buying and selling out of her own purse. Ships away from you stay out of your battles. At sea, press F for fleet orders.</p>
          <div class="item"><span><i>Every ship in port</i></span><span>${btn('flrepall', allRep > 0 ? `Repair all ${Math.min(allRep, s.gold)}g` : 'All shipshape', allRep > 0 && s.gold > 0)}${btn('flfillall', allNeed > 0 ? `Man all ${allNeed * HAND_COST}g` : 'All manned', allNeed > 0 && s.gold >= HAND_COST)}</span></div></section>` : '';
      const sub = txt => `<span style="font-size:12px;font-weight:normal">${txt}</span>`;
      const offers = s.banned[pi] > s.day ? 0 : Quests.offers(pi).length;
      // the districts of the port, each its own page: [key, label, badge, flavour, sections]
      const districts = [
        ['docks', '⚓ Docks', '', `Stevedores sweat crates up and down the quay. ${port.name} makes ${port.makes.map(g => goodName(g).toLowerCase()).join(' and ')}, and pays well for ${port.wants.map(g => goodName(g).toLowerCase()).join(' and ')}.`,
          `<section style="grid-column:1/-1"><h3>Market ${sub("(prices per crate · ▲▼ tomorrow's drift · hover a good to see where it's wanted)")}</h3>${market}</section>`],
        ['tavern', '🍺 Tavern', offers ? `${offers}` : '', 'Smoke, song and spilled ale. Sailors looking for a berth, and the harbourmaster\'s notice board by the door.',
          `<section style="grid-column:1/-1"><h3>Taproom</h3>
            <div class="item"><span>Hire hands (${HAND_COST}g a head) — aboard <b>${s.ship.crew}/${c.crew}</b></span><span>${btn('crew5', '+5', need > 0 && s.gold >= HAND_COST)}${btn('crewfill', 'Fill', need > 0 && s.gold >= HAND_COST)}</span></div>
            ${Quests.tavernHtml(btn)}</section>
          ${Quests.boardHtml(pi, btn)}`],
        ['wright', '🔨 Shipwright', repair > 0 ? '!' : '', 'The smell of tar and fresh oak. The master shipwright looks your hull over with a critical eye.',
          `<section><h3>Repairs</h3>
            <div class="item"><span>Mend hull and sails — hull <b>${Math.ceil(s.ship.hull)}/${maxH}</b>, sails <b>${Math.round(s.ship.sailHp)}%</b></span>${btn('repair', repair > 0 ? `Repair ${Math.min(repair, s.gold)}g` : 'Shipshape', repair > 0 && s.gold > 0)}</div>
            <h3 style="margin-top:12px">Refits</h3>${ups}</section>
          <section><h3>Armament ${sub('(fitted to this ship: a new flagship comes with plain culverins)')}</h3>${arms}</section>
          <section><h3>Powder room</h3>
            <div class="item"><span>Chain shot — aboard: ${s.ammo.chain} volleys</span>${btn('chain', `+1 for ${SHOT_COST}g`, s.gold >= SHOT_COST && s.ammo.chain < SHOT_MAX)}</div>
            <div class="item"><span>Grapeshot — aboard: ${s.ammo.grape} volleys</span>${btn('grape', `+1 for ${SHOT_COST}g`, s.gold >= SHOT_COST && s.ammo.grape < SHOT_MAX)}</div></section>`],
        ['yard', yardHere ? '⚒ Shipyard' : '⛵ Shipyard', s.fleet.length ? `${s.fleet.length}` : '', yardHere ? 'Hulls stand on the slipways in every stage of building. Here you can buy ships for your fleet.' : 'A broker\'s office overlooking the harbour. He trades in flagships, but builds none.',
          `<section style="grid-column:1/-1"><h3>Ships for sale ${sub(`(flagship trade-in ${trade}g)`)}</h3>${yard}${yardNote}</section>${fleetHtml}${this.hireHtml(pi, btn)}`],
        ['guild', isMerchant() ? '⚖ Guild hall' : '📜 Guild hall', '', 'Ledgers, seals and sour-faced clerks. The Merchant Guild decides who trades honestly in these waters.', guildHtml],
        ['hold', '🏰 Holdings', s.hq === pi ? '★' : '', s.hq === pi ? `Your headquarters. Clerks and harbour pilots in your pay run your affairs from here.` : 'Land agents and moneylenders haunt the harbour office, eager to sell a captain a footing ashore.', this.holdingsHtml(pi, btn)],
      ];
      if (!districts.some(d => d[0] === tab)) tab = 'docks';
      const here = districts.find(d => d[0] === tab);
      const tabBar = districts.map(([k, label, badge], i) => `<button class="tab${k === tab ? ' on' : ''}" data-a="tab_${k}" data-k="${i + 1}">${label}${badge ? ` <span class="badge">${badge}</span>` : ''}</button>`).join('');
      UI.show(`<h1>⚓ ${port.name}</h1>
        ${news.length ? `<ul>${news.map(l => `<li>${l}</li>`).join('')}</ul>` : ''}${err ? `<p class="hint" style="color:#8b1a1a"><b>${err}</b></p>` : ''}
        <div class="stats"><b>${s.gold}</b> gold aboard · ${isMerchant() ? `standing <b>${s.trade}</b>` : `<span title="${s.fame} from your deeds, ${wealthFame(s)} from your wealth">fame <b>${fameOf(s)}</b></span>`} · <b>${s.ship.name}</b> (${c.name}) · hull <b>${Math.ceil(s.ship.hull)}/${maxH}</b> · sails <b>${Math.round(s.ship.sailHp)}%</b> · crew <b>${s.ship.crew}/${c.crew}</b> · hold <b>${used}/${holdCap(s)}</b>${ownWing(s).length ? ' <small>(with your fleet)</small>' : ''}${propsOf(s, pi).bank ? ` · banked here <b>${propsOf(s, pi).bank.gold}</b>` : ''}</div>
        <div class="tabs">${tabBar}</div>
        <p class="hint">${here[3]}</p>
        <div class="cols district">${here[4]}</div>
        <div class="row"><button class="primary" data-a="leave">Set sail</button> <span class="hint">1–6 switch district</span></div>`, act);
    };
    let sure = false; // the captain has already confirmed a downgrade
    let tab = this.portTab || 'docks'; // the district you were last in
    const act = a => {
      if (a.startsWith('tab_')) { tab = this.portTab = a.slice(4); return render(); }
      const c = SHIP_CLASSES[s.ship.cls], maxH = Campaign.maxHull();
      if (a.startsWith('buy_') && !sure && this.downgradeHtml(a.slice(4)))
        return this.confirm(this.downgradeHtml(a.slice(4)), 'Trade down', () => { sure = true; act(a); sure = false; }, render);
      if (a.startsWith('flsell_') && !sure) {
        const f = s.fleet[+a.slice(7)]; if (!f) return render();
        if (holdBlock(s, f)) { news.length = 0; err = holdBlock(s, f); return render(); }
        return this.confirm(`Sell the <b>${esc(f.name)}</b> (${SHIP_CLASSES[f.cls].name}) for <b>${fleetSalePrice(f)}g</b>? Her ${f.crew} crew are paid off and her shot is sold with her.`, 'Sell her',
          () => { sure = true; act(a); sure = false; }, render);
      }
      news.length = 0; err = '';
      if (a.startsWith('flroute_')) {
        const f = s.fleet[+a.slice(8)]; if (!f || !fleetHere(f, pi) || !fleetReady(f)) return render();
        if (holdBlock(s, f)) { err = holdBlock(s, f); return render(); }
        return this.routeMenu(f, pi, lines => { news.push(...lines.map(esc)); Campaign.save(); render(); }, true);
      }
      if (a === 'charter') return this.charterMenu(pi, lines => { news.push(...lines.map(esc)); Campaign.save(); render(); });
      const ha = this.hireAct(a, pi, news);
      if (ha !== null) { err = ha; Campaign.save(); return render(); }
      const hr = this.holdAct(a, pi, news, render);
      if (hr === false) return; // a sub-menu is open
      if (hr !== null) { err = hr; Campaign.save(); return render(); }
      const qr = Quests.portAct(a, pi);
      if (qr !== null) { err = qr; Campaign.save(); return render(); }
      if (a === 'leave') {
        s.x = port.sx; s.y = port.sy; s.heading = port.ang;
        Campaign.save(); UI.hide(); this.map.refreshShip(); this.map.safe = 2; return;
      }
      if (a === 'repair') {
        const cost = Math.ceil((maxH - s.ship.hull) * 2 + (100 - s.ship.sailHp)), pay = Math.min(cost, s.gold), f = pay / cost;
        s.ship.hull += (maxH - s.ship.hull) * f; s.ship.sailHp += (100 - s.ship.sailHp) * f; s.gold -= pay;
      } else if (a === 'crew5' || a === 'crewfill') {
        const n = Math.min(a === 'crew5' ? 5 : 999, c.crew - s.ship.crew, Math.floor(s.gold / HAND_COST));
        s.ship.crew += n; s.gold -= n * HAND_COST;
      } else if (a === 'chain' || a === 'grape') { s.ammo[a]++; s.gold -= SHOT_COST; }
      else if (a.startsWith('fl')) err = this.fleetAct(a, port) || '';
      else if (a === 'pardon' && !isMerchant() && s.boss !== 1 && s.gold >= pardonCost(s)) {
        s.gold -= pardonCost(s); s.career = 'merchant'; Sfx.coin();
        for (const n of this.map.npcs) if (n.kind === 'patrol') n.alert = 0;
      } else if (a === 'blackflag') {
        if (!sure) return this.confirm('Turn pirate? The Guild strikes your name from its rolls: you lose its prices, the navy and pirate hunters will come for you, and a royal pardon will cost gold to win back.', 'Run up the black flag', () => { sure = true; act(a); sure = false; }, render);
        s.career = 'pirate'; Sfx.horn();
      }
      else if (a.startsWith('sell1_') || a.startsWith('sellall_')) {
        const g = a.slice(a.indexOf('_') + 1), free = Math.max(0, (s.hold[g] || 0) - Quests.reserved(g)), n = a.startsWith('sell1_') ? Math.min(1, free) : free;
        if (g !== 'plunder' && !GOODS[g].hidden) addStanding(s, n * goodPrice(port, g) / GUILD_GOLD); // honest trade raises a merchant's standing
        s.gold += n * goodPrice(port, g); s.hold[g] -= n; if (!s.hold[g]) delete s.hold[g]; if (n) Sfx.coin();
      } else if (/^buy(1|5|max)_/.test(a)) {
        const g = a.slice(a.indexOf('_') + 1), p = buyPrice(port, g), want = { buy1: 1, buy5: 5, buymax: 1e9 }[a.slice(0, a.indexOf('_'))];
        s.gold -= stow(s, g, Math.min(want, Math.floor(s.gold / p))) * p;
      }
      else if (a.startsWith('gun_')) {
        const k = a.slice(4), cost = GUNS[k] ? gunCost(k, s.ship.cls) : Infinity;
        if (s.gold >= cost && fitOf(s.ship).gun !== k) { s.gold -= cost; s.ship.gun = k; Sfx.horn(); }
      } else if (a === 'bowgun' && !s.ship.bow && s.gold >= BOW_GUN.cost) { s.gold -= BOW_GUN.cost; s.ship.bow = true; }
      else if (a === 'ramfit' && !s.ship.ram && s.gold >= ramCost(s.ship.cls)) { s.gold -= ramCost(s.ship.cls); s.ship.ram = true; }
      else if (a.startsWith('up_')) {
        const k = a.slice(3); s.gold -= UP_COST[s.up[k]]; s.up[k]++;
        if (k === 'hull') s.ship.hull += Campaign.maxHull() - maxH;
      } else if (a.startsWith('buy_')) {
        const k = a.slice(4), n = SHIP_CLASSES[k];
        s.gold -= n.cost - Math.round(c.cost * .4);
        s.ship = { cls: k, name: s.ship.name, hull: 0, sailHp: 100, crew: Math.min(s.ship.crew, n.crew) };
        s.ship.hull = Campaign.maxHull();
      }
      Campaign.save(); render();
    };
    render();
  },
  // port orders for the fleet: buy (shipyards only), repair, man, arm and sell
  fleetAct(a, port) {
    const s = Campaign.s, [cmd, arg] = a.split('_'), pi = PORTS.indexOf(port), f = s.fleet[+arg];
    const mend = f => { const cost = fleetRepairCost(f), pay = Math.min(cost, s.gold), k = cost > 0 ? pay / cost : 0, mh = SHIP_CLASSES[f.cls].hull; f.hull += (mh - f.hull) * k; f.sailHp += (100 - f.sailHp) * k; s.gold -= pay; };
    const man = (f, most) => { const n = Math.max(0, Math.min(most, SHIP_CLASSES[f.cls].crew - f.crew, Math.floor(s.gold / HAND_COST))); f.crew += n; s.gold -= n * HAND_COST; };
    if (cmd === 'flbuy') {
      const sc = SHIP_CLASSES[arg];
      if (!sc || !isShipyard(port) || ownFleet(s).length >= fleetMax(s) || s.gold < sc.cost) return;
      s.gold -= sc.cost; s.fleet.push(newFleetShip(s, arg)); Sfx.coin();
    } else if (cmd === 'flrepall') ownFleet(s).filter(f => fleetHere(f, pi)).forEach(mend);
    else if (cmd === 'flfillall') ownFleet(s).filter(f => fleetHere(f, pi)).forEach(f => man(f, 999));
    else if (!f || f.hired) return;
    else if (cmd === 'flcall') { if (f.task) { f.task = { type: 'recall' }; f.at = null; } }
    else if (!fleetHere(f, pi)) return; // the rest needs her here in port
    else if ((cmd === 'flstay' || cmd === 'flsell') && holdBlock(s, f)) return holdBlock(s, f);
    else if (cmd === 'flstay') { if (inWing(f) && fleetReady(f)) Object.assign(f, { task: { type: 'station', port: pi }, at: pi, x: port.sx, y: port.sy, heading: port.ang, lie: 0 }); }
    else if (cmd === 'fljoin') { delete f.task; f.at = f.x = f.y = null; f.lie = 0; takePurse(s, f); boardCargo(s, f); }
    else if (cmd === 'flgive') { const n = Math.min(100, s.gold); s.gold -= n; f.gold = (f.gold || 0) + n; if (f.task && f.task.type === 'route') f.task.float = f.gold; }
    else if (cmd === 'fltake') { takePurse(s, f); if (f.task && f.task.type === 'route') f.task.float = 0; }
    else if (cmd === 'flrep') mend(f);
    else if (cmd === 'flcrew5' || cmd === 'flfill') man(f, cmd === 'flcrew5' ? 5 : 999);
    else if ((cmd === 'flchain' || cmd === 'flgrape') && s.gold >= SHOT_COST) { const k = cmd.slice(2); if (f.ammo[k] < SHOT_MAX) { f.ammo[k]++; s.gold -= SHOT_COST; } }
    else if (cmd === 'flsell') { takePurse(s, f); s.gold += fleetSalePrice(f); s.fleet.splice(+arg, 1); Sfx.coin(); }
  },

  // ---------- ships for hire (Shipyard district) ----------
  hireHtml(pi, btn) {
    const s = Campaign.s, o = hireOffers(s, pi), esc_ = hiredOf(s, 'escort'), fr = hiredOf(s, 'freight');
    const sub = txt => `<span style="font-size:12px;font-weight:normal">${txt}</span>`;
    const offers = o.escorts.map((e, k) => {
      const c = SHIP_CLASSES[e.cls], r = hireRate(e.cls);
      return `<div class="item"><span>⚔ <b>${esc(e.name)}</b> (${c.name}) — ${c.guns} guns a side, ${c.crew} crew · <b>${r}g</b> a day</span><span>${HIRE_DAYS.map(d => btn(`hire_${k}_${d}`, `${d} days ${r * d}g`, s.gold >= r * d && esc_.length < HIRE_MAX)).join('')}</span></div>`;
    }).join('') || '<p class="hint">No fighting ships want a contract today. Try again in a day or two.</p>';
    const mine = esc_.map(f => {
      const i = s.fleet.indexOf(f), r = f.hired.rate;
      return `<div class="item"><span><b>${esc(f.name)}</b> (${SHIP_CLASSES[f.cls].name}) — ${Math.max(0, Math.ceil(f.hired.until - s.day))} days left on her contract</span><span>${btn('hext_' + i, `+5 days ${r * 5}g`, s.gold >= r * 5)}${btn('hdis_' + i, 'Dismiss')}</span></div>`;
    }).join('');
    const fc = o.freight && SHIP_CLASSES[o.freight.cls];
    const charter = o.freight ? `<div class="item"><span>📦 Charter the <b>${esc(o.freight.name)}</b> (${fc.name}, hold ${fc.cargo}) to carry goods from your hold, and gold, to another port</span>${btn('charter', 'Charter…', fr.length < FREIGHT_MAX)}</div>`
      : '<p class="hint">No freighter is free for charter here today.</p>';
    const away = fr.map(f => `<li>The <b>${esc(f.name)}</b> — ${esc(taskText(f))}</li>`).join('');
    return `<section style="grid-column:1/-1"><h3>Ships for hire ${sub(`(escorts ${esc_.length}/${HIRE_MAX} · charters ${fr.length}/${FREIGHT_MAX})`)}</h3>${offers}${mine}${charter}${away ? `<ul>${away}</ul>` : ''}
      <p class="hint">A hired escort comes manned and gunned, sails in your wing and fights beside you until her contract runs out; her owners mend her in every port, but she is not yours to command, sell or send away. A charter sails alone to the port you name and lands what she carries in your counting house and warehouse there, or with the harbourmaster until you come for it. Pirates go after a laden charter, and she carries ${FREIGHT_INSURE * 100}% insurance on gold.</p></section>`;
  },
  // returns null if `a` isn't a hire action, else an error ('' if none)
  hireAct(a, pi, news) {
    const s = Campaign.s, [cmd, x, y] = a.split('_');
    if (cmd === 'hire') {
      const o = hireOffers(s, pi), e = o.escorts[+x], days = +y;
      if (!e || !HIRE_DAYS.includes(days)) return '';
      if (hiredOf(s, 'escort').length >= HIRE_MAX) return `You can hire at most ${HIRE_MAX} escorts.`;
      const r = hireRate(e.cls); if (s.gold < r * days) return 'You can\'t pay her.';
      s.gold -= r * days; o.escorts.splice(+x, 1);
      s.fleet.push(hiredShip(e.cls, e.name, { kind: 'escort', rate: r, until: s.day + days })); Sfx.coin();
      news.push(`The ${esc(e.name)} signs on to sail with you for ${days} days.`);
      return '';
    }
    if (cmd === 'hext' || cmd === 'hdis') {
      const f = s.fleet[+x]; if (!f || !f.hired || f.hired.kind !== 'escort') return '';
      if (cmd === 'hdis') { s.fleet.splice(+x, 1); news.push(`You pay off the ${esc(f.name)}, and she parts company.`); return ''; }
      if (s.gold < f.hired.rate * 5) return 'You can\'t pay for more days.';
      s.gold -= f.hired.rate * 5; f.hired.until += 5; Sfx.coin(); return '';
    }
    return null;
  },
  // load a chartered freighter with goods and gold for another port; done(lines) gets the news ([] if cancelled)
  charterMenu(pi, done) {
    const s = Campaign.s, port = PORTS[pi], o = hireOffers(s, pi), sh = o.freight;
    if (!sh || hiredOf(s, 'freight').length >= FREIGHT_MAX) return done([]);
    const c = SHIP_CLASSES[sh.cls], load = {}; let to = null, gold = 0;
    const free = g => Math.max(0, (s.hold[g] || 0) - Quests.reserved(g)), used = () => Object.values(load).reduce((a, n) => a + n, 0);
    const render = () => {
      gold = Math.max(0, Math.min(gold, s.gold));
      const fee = to == null ? 0 : freightFee(sh.cls, pi, to, gold), P = to == null ? {} : propsOf(s, to);
      const goods = Object.keys(s.hold).filter(g => GOODS[g] && !GOODS[g].hidden && free(g) > 0).map(g => {
        const n = load[g] || 0, room = c.cargo - used() > 0 && n < free(g);
        return `<div class="item"><span><b>${goodName(g)}</b> — loaded <b>${n}</b> of ${free(g)}</span><span><button data-a="l1_${g}" ${room ? '' : 'disabled'}>+1</button><button data-a="l5_${g}" ${room ? '' : 'disabled'}>+5</button><button data-a="la_${g}" ${room ? '' : 'disabled'}>All</button><button data-a="l0_${g}" ${n ? '' : 'disabled'}>None</button></span></div>`;
      }).join('') || '<p class="hint">Nothing in your hold to send.</p>';
      const ports = PORTS.map((p, j) => j === pi ? '' : `<button data-a="to_${j}" ${j === to ? 'class="on"' : ''}>${j === to ? '▶ ' : ''}${p.name}</button>`).join('');
      const where = to == null ? '' : `<p>To <b>${PORTS[to].name}</b>: gold goes ${P.bank ? 'into your counting house' : 'to the harbourmaster'}; goods go ${P.ware ? 'into your warehouse (as room allows)' : 'to the harbourmaster'} until you collect them.</p>`;
      const ok = to != null && (used() > 0 || gold > 0) && s.gold >= fee + gold;
      UI.show(`<h1>📦 Charter the ${esc(sh.name)}</h1>
        <p>${c.name} out of ${port.name}, hold ${used()}/${c.cargo}. Choose her port, then load her.</p>
        <div class="row" style="flex-wrap:wrap">${ports}</div>${where}
        <h3>Cargo</h3>${goods}
        <h3>Gold</h3><div class="item"><span>Sending <b>${gold}</b> of the ${s.gold} gold aboard</span><span><button data-a="g_100">+100</button><button data-a="g_1000">+1000</button><button data-a="g_all">All but the fee</button><button data-a="g_0">None</button></span></div>
        <div class="stats">Charter fee ${to == null ? '—' : `<b>${fee}g</b>`}${to != null && gold ? ` (includes ${Math.ceil(gold * FREIGHT_INSURE)}g insurance on the gold)` : ''}${to != null && s.gold < fee + gold ? ' · <b style="color:#8b1a1a">you can\'t cover the fee and the gold</b>' : ''}</div>
        <div class="row"><button class="primary" data-a="go" ${ok ? '' : 'disabled'}>Sign the charter</button><button data-a="back" data-k="Escape">Cancel</button></div>`, act);
    };
    const act = a => {
      if (a === 'back') return done([]);
      if (a.startsWith('to_')) { to = +a.slice(3); return render(); }
      if (a.startsWith('g_')) {
        const v = a.slice(2);
        if (v === 'all') { // everything aboard that leaves enough for the fee (its insurance grows with the gold)
          const base = to == null ? 0 : freightFee(sh.cls, pi, to, 0);
          gold = Math.max(0, Math.floor((s.gold - base - 1) / (1 + FREIGHT_INSURE)));
          while (gold > 0 && to != null && gold + freightFee(sh.cls, pi, to, gold) > s.gold) gold--;
        }
        else gold = v === '0' ? 0 : gold + +v;
        return render();
      }
      if (/^l[150a]_/.test(a)) {
        const g = a.slice(3), k = a[1], n = load[g] || 0, room = c.cargo - used();
        load[g] = k === '0' ? 0 : Math.min(free(g), n + Math.min(room, k === 'a' ? 1e9 : +k));
        if (!load[g]) delete load[g];
        return render();
      }
      if (a === 'go') {
        if (to == null || hiredOf(s, 'freight').length >= FREIGHT_MAX) return render();
        gold = Math.max(0, Math.min(gold, s.gold)); const fee = freightFee(sh.cls, pi, to, gold);
        if (s.gold < fee + gold || (!used() && !gold)) return render();
        s.gold -= fee + gold;
        for (const g in load) { s.hold[g] -= load[g]; if (!s.hold[g]) delete s.hold[g]; }
        const f = hiredShip(sh.cls, sh.name, { kind: 'freight', rate: fee });
        Object.assign(f, { task: { type: 'freight', to, from: pi }, at: null, lie: 0, x: port.sx, y: port.sy, heading: port.ang, cargo: Object.assign({}, load), gold });
        s.fleet.push(f); o.freight = null; Sfx.coin();
        return done([`The ${f.name} is chartered for ${fee}g and sails for ${PORTS[to].name} with ${freightText(f)}.`]);
      }
    };
    render();
  },

  // ---------- holdings: property ashore and your headquarters (Holdings district) ----------
  holdingsHtml(pi, btn) {
    const s = Campaign.s, port = PORTS[pi], P = propsOf(s, pi), c = SHIP_CLASSES[s.ship.cls];
    const sub = txt => `<span style="font-size:12px;font-weight:normal">${txt}</span>`;
    let html = '';
    const forSale = Object.keys(PROP_INFO).filter(k => !P[k]).map(k => {
      const I = PROP_INFO[k];
      return `<div class="item"><span>${I.icon} <b>${I.name}</b> — ${I.what}</span>${btn('ppbuy_' + k, `Buy ${I.cost}g`, s.gold >= I.cost)}</div>`;
    }).join('');
    if (forSale) html += `<section style="grid-column:1/-1"><h3>Property for sale in ${port.name}</h3>${forSale}
      <p class="hint">What you keep ashore is safe if your ship goes down, but you can only reach it here.</p></section>`;
    if (P.bank) {
      const b = P.bank.gold;
      html += `<section><h3>🏦 Counting house ${sub(`(${BANK_RATE * 100}% a day)`)}</h3>
        <div class="item"><span>On deposit <b>${b}</b> gold · aboard <b>${s.gold}</b></span></div>
        <div class="item"><span>Deposit</span><span>${btn('ppdep_100', '100', s.gold >= 100)}${btn('ppdep_all', 'All', s.gold > 0)}</span></div>
        <div class="item"><span>Withdraw</span><span>${btn('ppwd_100', '100', b >= 100)}${btn('ppwd_all', 'All', b > 0)}</span></div></section>`;
    }
    if (P.ware) {
      const used = wareUsed(P.ware), room = holdCap(s) - holdUsed(s);
      const goods = [...new Set([...Object.keys(s.hold), ...Object.keys(P.ware)])].filter(g => GOODS[g] && !GOODS[g].hidden);
      const rows = goods.map(g => {
        const free = Math.max(0, (s.hold[g] || 0) - Quests.reserved(g)), kept = P.ware[g] || 0, put = free > 0 && used < WARE_CAP, get = kept > 0 && room > 0;
        return `<div class="item"><span><b>${goodName(g)}</b> — aboard ${s.hold[g] || 0} · stored <b>${kept}</b></span><span>${btn('ppput1_' + g, 'Store 1', put)}${btn('ppputall_' + g, 'Store all', put)}${btn('ppget1_' + g, 'Load 1', get)}${btn('ppgetall_' + g, 'Load all', get)}</span></div>`;
      }).join('');
      html += `<section><h3>📦 Warehouse ${sub(`(${used}/${WARE_CAP} crates · hold ${holdUsed(s)}/${holdCap(s)})`)}</h3>${rows || '<p class="hint">Empty, and nothing in your hold to store.</p>'}
        <p class="hint">Cargo under contract stays aboard.</p></section>`;
    }
    if (P.dock) {
      const rows = P.dock.map((f, j) => {
        const fc = SHIP_CLASSES[f.cls], fits = holdUsed(s) <= holdCap(s) - c.cargo + fc.cargo;
        return `<div class="item"><span><b>${esc(f.name)}</b> (${fc.name}) — hull ${Math.ceil(f.hull)}/${fc.hull} · sails ${Math.round(f.sailHp)}% · crew ${f.crew}/${fc.crew}</span>
          <span>${btn('ppout_' + j, 'Join fleet', ownFleet(s).length < fleetMax(s))}${btn('ppswap_' + j, fits ? 'Take command' : 'Hold too full', fits)}</span></div>`;
      }).join('');
      const layup = s.fleet.map((f, i) => fleetHere(f, pi) && !f.hired ? `<div class="item"><span><b>${esc(f.name)}</b> (${SHIP_CLASSES[f.cls].name}) — ${esc(taskText(f))}</span>${btn('ppin_' + i, 'Lay up', P.dock.length < DOCK_CAP)}</div>` : '').join('');
      html += `<section style="grid-column:1/-1"><h3>⛵ Private dock ${sub(`(${P.dock.length}/${DOCK_CAP} berths · fleet ${ownFleet(s).length}/${fleetMax(s)})`)}</h3>${rows || '<p class="hint">No ships laid up.</p>'}
        ${layup ? `<h3 style="margin-top:12px">Your fleet in port</h3>${layup}` : ''}
        <p class="hint">Laid-up ships keep their crew and shot, stay out of your battles, and don't count against your fleet. "Take command" moves your flag, your powder and as many hands as she berths across to her, and lays up your old ship in her place.</p></section>`;
    }
    const hq = s.hq === pi;
    html += `<section style="grid-column:1/-1"><h3>🏰 Headquarters</h3>${hq
      ? `<div class="item"><span><b>${port.name}</b> is your headquarters: your fleet may number ${fleetMax(s)} ships, you can command every one of them from here, and if you are lost at sea you are carried home here${P.dock ? ' to the best ship in your dock' : ''}.</span></div>${this.admiraltyHtml(pi, btn)}`
      : `<div class="item"><span>${s.hq != null ? `Move your headquarters here from <b>${PORTS[s.hq].name}</b>.` : `Make ${port.name} your headquarters: command your whole fleet from here, +${HQ_FLEET} ships in your fleet, and be carried home here if you are lost at sea.`}${ownsAt(s, pi) ? '' : ' <i>Buy property here first.</i>'}</span>${btn('pphq', `${s.hq != null ? 'Move' : 'Establish'} ${HQ_COST}g`, ownsAt(s, pi) && s.gold >= HQ_COST)}</div>`}
      ${this.holdingsList(pi)}</section>`;
    return html;
  },
  // the fleet ships away from you, with orders you can send from headquarters
  admiraltyHtml(pi, btn) {
    const s = Campaign.s, away = s.fleet.map((f, i) => [f, i]).filter(([f]) => f.task && !f.hired);
    if (!away.length) return `<p class="hint">${ownFleet(s).length ? 'Your whole fleet sails with you.' : 'You have no fleet yet.'} Ships you send away can be commanded from here wherever they are.</p>`;
    const rows = away.map(([f, i]) => {
      const T = f.task, ready = fleetReady(f), isHome = T.type === 'station' && T.port === pi;
      return `<div class="item"><span><b>${esc(f.name)}</b> (${SHIP_CLASSES[f.cls].name}) — hull ${Math.ceil(f.hull)}/${SHIP_CLASSES[f.cls].hull} · crew ${f.crew}/${SHIP_CLASSES[f.cls].crew}<br><small>⚑ ${esc(taskText(f))}</small></span>
        <span>${T.type === 'recall' ? '' : btn('ppcall_' + i, 'Recall')}${isHome ? '' : btn('pphome_' + i, 'Sail home')}${btn('ppsend_' + i, 'Send to port…')}${btn('pproute_' + i, 'Trade route…', ready)}</span></div>`;
    }).join('');
    return `<h3 style="margin-top:12px">Admiralty ${'<span style="font-size:12px;font-weight:normal">(orders reach your ships by fast pinnace)</span>'}</h3>${rows}
      <div class="item"><span><i>Every ship away</i></span><span>${btn('ppcallall', 'Recall all')}${btn('pphomeall', 'All home')}</span></div>`;
  },
  // what you own ashore, port by port (skipping `except`)
  holdingsList(except) {
    const s = Campaign.s, rows = PORTS.map((p, i) => {
      if (i === except || (!ownsAt(s, i) && s.hq !== i && !s.consign[i])) return '';
      const P = propsOf(s, i), bits = [], C = s.consign[i];
      if (P.bank) bits.push(`🏦 ${P.bank.gold} gold`);
      if (P.ware) bits.push(`📦 ${wareUsed(P.ware)} crates`);
      if (P.dock) bits.push(`⛵ ${P.dock.length ? P.dock.map(f => esc(f.name)).join(', ') : 'empty dock'}`);
      if (C) bits.push(`📜 with the harbourmaster: ${[C.gold && C.gold + ' gold', wareUsed(C.goods) && wareUsed(C.goods) + ' crates'].filter(Boolean).join(', ')}`);
      return `<li><b>${p.name}</b>${s.hq === i ? ' 🏰 <i>headquarters</i>' : ''} — ${bits.join(' · ')}</li>`;
    }).join('');
    return rows ? `<h3>${except != null ? 'Your holdings elsewhere' : 'Holdings ashore'}</h3><ul>${rows}</ul>` : '';
  },
  // Holdings district actions (all start 'pp'). Returns null if `a` isn't one, false if a sub-menu took over, else an error ('' if none).
  holdAct(a, pi, news, render) {
    if (!a.startsWith('pp')) return null;
    const s = Campaign.s, port = PORTS[pi], P = s.props[pi] || (s.props[pi] = {});
    const cut = a.indexOf('_'), cmd = cut < 0 ? a : a.slice(0, cut), arg = cut < 0 ? '' : a.slice(cut + 1), f = s.fleet[+arg];
    if (cmd === 'ppbuy') {
      const I = PROP_INFO[arg]; if (!I || P[arg] || s.gold < I.cost) return '';
      s.gold -= I.cost; P[arg] = arg === 'bank' ? { gold: 0, day: Math.floor(s.day) } : arg === 'ware' ? {} : []; Sfx.coin();
      news.push(`You buy a ${I.name.toLowerCase()} in ${port.name}.`);
    } else if (cmd === 'ppdep' && P.bank) { const n = arg === 'all' ? s.gold : Math.min(100, s.gold); s.gold -= n; P.bank.gold += n; if (n) Sfx.coin(); }
    else if (cmd === 'ppwd' && P.bank) { const n = arg === 'all' ? P.bank.gold : Math.min(100, P.bank.gold); P.bank.gold -= n; s.gold += n; if (n) Sfx.coin(); }
    else if ((cmd === 'ppput1' || cmd === 'ppputall') && P.ware && GOODS[arg] && !GOODS[arg].hidden) {
      const free = Math.max(0, (s.hold[arg] || 0) - Quests.reserved(arg)), n = Math.min(free, WARE_CAP - wareUsed(P.ware), cmd === 'ppput1' ? 1 : 1e9);
      if (n > 0) { s.hold[arg] -= n; if (!s.hold[arg]) delete s.hold[arg]; P.ware[arg] = (P.ware[arg] || 0) + n; }
    } else if ((cmd === 'ppget1' || cmd === 'ppgetall') && P.ware && P.ware[arg]) {
      const k = stow(s, arg, Math.min(P.ware[arg], cmd === 'ppget1' ? 1 : 1e9));
      P.ware[arg] -= k; if (!P.ware[arg]) delete P.ware[arg];
      if (!k) return 'Your hold is full.';
    } else if (cmd === 'ppin' && P.dock && f && !f.hired && fleetHere(f, pi)) {
      if (P.dock.length >= DOCK_CAP) return 'Your dock is full.';
      if (holdBlock(s, f)) return holdBlock(s, f);
      const sold = sellCargo(f, port); if (sold) news.push(esc(sold)); takePurse(s, f);
      delete f.task; f.at = f.x = f.y = null; f.lie = 0;
      s.fleet.splice(+arg, 1); P.dock.push(f); news.push(`The ${esc(f.name)} is laid up in your dock.`);
    } else if (cmd === 'ppout' && P.dock && P.dock[+arg]) {
      if (ownFleet(s).length >= fleetMax(s)) return `Your fleet is full (${fleetMax(s)} ships).`;
      const d = P.dock.splice(+arg, 1)[0]; s.fleet.push(d); boardCargo(s, d); news.push(`The ${esc(d.name)} joins your fleet.`);
    } else if (cmd === 'ppswap' && P.dock && P.dock[+arg]) {
      const d = P.dock[+arg], dc = SHIP_CLASSES[d.cls], oc = SHIP_CLASSES[s.ship.cls];
      if (holdUsed(s) > holdCap(s) - oc.cargo + dc.cargo) return `The ${esc(d.name)}'s hold is too small for your cargo.`;
      const hands = s.ship.crew + d.crew, mine = Math.max(1, Math.min(dc.crew, hands));
      P.dock[+arg] = { cls: s.ship.cls, name: s.ship.name, hull: Math.max(1, Math.min(s.ship.hull, oc.hull)), sailHp: s.ship.sailHp, crew: Math.min(oc.crew, hands - mine), ammo: s.ammo, ...fitOf(s.ship) };
      s.ship = { cls: d.cls, name: d.name, hull: Math.max(1, d.hull), sailHp: d.sailHp, crew: mine, ...fitOf(d) }; s.ammo = d.ammo || { chain: 0, grape: 0 };
      news.push(`You hoist your colours aboard the ${esc(d.name)}, and the ${esc(P.dock[+arg].name)} is laid up in her place.`); Sfx.horn();
    } else if (cmd === 'pphq') {
      if (!ownsAt(s, pi) || s.gold < HQ_COST || s.hq === pi) return '';
      s.gold -= HQ_COST; s.hq = pi; Sfx.horn(); news.push(`${port.name} is your headquarters now.`);
    } else if (s.hq !== pi) return ''; // the rest are admiralty orders, given only from headquarters
    else if (cmd === 'ppcallall' || cmd === 'pphomeall') {
      for (const x of s.fleet) if (x.task && !x.hired) {
        if (cmd === 'ppcallall') { x.task = { type: 'recall' }; x.at = null; }
        else { x.at = x.at === pi ? pi : null; x.task = { type: 'station', port: pi }; }
      }
    } else if (!f || !f.task || f.hired) return '';
    else if (cmd === 'ppcall') { f.task = { type: 'recall' }; f.at = null; }
    else if (cmd === 'pphome') { f.at = f.at === pi ? pi : null; f.task = { type: 'station', port: pi }; }
    else if (cmd === 'ppsend') {
      this.pickPort(`Send the ${esc(f.name)} to which port?`, j => { f.at = f.at === j ? j : null; f.task = { type: 'station', port: j }; Campaign.save(); render(); }, render);
      return false;
    } else if (cmd === 'pproute' && fleetReady(f)) {
      this.routeMenu(f, f.at, lines => { news.push(...lines.map(esc)); Campaign.save(); render(); }, f.at === pi);
      return false;
    }
    this.map.syncOwn();
    return '';
  },

  // ---------- squadrons: orders for fleet ships sailing on their own ----------
  fleetOrders() {
    const s = Campaign.s, map = this.map;
    if (!s.fleet.length) return map.msg(`You have no fleet to command. Ships for one are built at ${SHIPYARD_PORTS.join(' and ')}.`);
    const rows = s.fleet.map((f, i) => {
      const fc = SHIP_CLASSES[f.cls], T = f.task;
      if (f.hired) return `<div class="item"><span><b>${esc(f.name)}</b> (${fc.name}) — hull ${Math.ceil(f.hull)}/${fc.hull}<br><small>⚑ ${esc(taskText(f))}</small></span><span><i>hired: not yours to command</i></span></div>`;
      const home = s.hq != null && !(T && T.type === 'station' && T.port === s.hq) && (T || fleetReady(f)) ? `<button data-a="home_${i}">Sail home to ${PORTS[s.hq].name}</button>` : '';
      const btns = (!T ? `<button data-a="send_${i}" ${fleetReady(f) ? '' : 'disabled'}>${fleetReady(f) ? 'Send to port…' : 'Too few hands'}</button>`
        : (T.type === 'recall' ? '' : `<button data-a="call_${i}">Recall</button>`) + (T.type === 'route' ? `<button data-a="hold_${i}">Hold at ${f.at != null ? 'this' : 'next'} port</button>` : '')) + home;
      return `<div class="item"><span><b>${esc(f.name)}</b> (${fc.name}) — hull ${Math.ceil(f.hull)}/${fc.hull} · crew ${f.crew}/${fc.crew}<br><small>⚑ ${esc(taskText(f))}</small></span><span>${btns}</span></div>`;
    }).join('');
    UI.show(`<h1>⚑ Fleet orders</h1>${rows}
      <p class="hint">A ship sent away sails on her own and stays out of your battles. Dock where she lies to repair her, man her, or give her a trade route (Shipyard district). Laden trade ships are prey for pirates: well-gunned, well-manned ships beat them off more often.${s.hq != null ? ` From your headquarters at ${PORTS[s.hq].name} (Holdings district) you can command every ship wherever she is.` : ''}</p>
      <div class="row"><button data-a="callall" ${s.fleet.some(f => f.task && !f.hired && f.task.type !== 'recall') ? '' : 'disabled'}>Recall all</button><button class="primary" data-a="close" data-k="Escape">Back to sea</button></div>`, a => {
      if (a === 'close') return UI.hide();
      const [cmd, n] = a.split('_'), f = s.fleet[+n];
      if (cmd === 'callall') { for (const x of s.fleet) if (x.task && !x.hired) { x.task = { type: 'recall' }; x.at = null; } }
      else if (!f || f.hired) return;
      else if ((cmd === 'home' || cmd === 'send') && !f.task && holdBlock(s, f)) return UI.show(`<h1>⚑ Fleet orders</h1><p>${holdBlock(s, f)}</p><div class="row"><button class="primary" data-a="ok">Back</button></div>`, () => this.fleetOrders());
      else if (cmd === 'call' && f.task) { f.task = { type: 'recall' }; f.at = null; }
      else if (cmd === 'home' && s.hq != null && (f.task || fleetReady(f))) { f.at = f.at === s.hq ? s.hq : null; f.task = { type: 'station', port: s.hq }; map.syncOwn(); }
      else if (cmd === 'hold' && f.task && f.task.type === 'route') f.task = { type: 'station', port: f.at != null ? f.at : f.task.stops[f.task.leg] };
      else if (cmd === 'send' && !f.task && fleetReady(f)) return this.pickPort(`Send the ${esc(f.name)} to which port?`, pi => { f.task = { type: 'station', port: pi }; f.at = null; map.syncOwn(); this.fleetOrders(); }, () => this.fleetOrders());
      this.fleetOrders();
    });
  },
  pickPort(title, onPick, onBack) {
    const here = this.map.ship;
    const rows = PORTS.map((p, i) => `<div class="item"><span><b>${p.name}</b>${isShipyard(p) ? ' ⚒' : ''} — makes ${p.makes.map(goodName).join(', ')} · wants ${p.wants.map(goodName).join(', ')} · ${Math.round(dist(p, here) / 100)} leagues</span><button data-a="p_${i}">Send her</button></div>`).join('');
    UI.show(`<h1>⚑ ${title}</h1>${rows}<div class="row"><button class="primary" data-a="back" data-k="Escape">Back</button></div>`, a => a === 'back' ? onBack() : onPick(+a.slice(2)));
  },
  // plan a trade route starting from this port; done(lines) gets the news of her first cargo ([] if cancelled)
  // here: you are in port with her, so you can fill her purse from your strongroom
  routeMenu(f, pi, done, here = false) {
    const s = Campaign.s, stops = pi == null ? [] : [pi], fc = SHIP_CLASSES[f.cls];
    let give = here ? Math.min(s.gold, 500) : 0;
    const render = () => {
      give = Math.max(0, Math.min(give, s.gold));
      const purse = here ? `<div class="item"><span>Her purse: <b>${(f.gold || 0) + give}</b> gold${give ? ` (${give} from the ${s.gold} aboard your flagship)` : ''}. She buys cargo only with what she carries${Object.values(s.props).some(p => p.bank) ? ', and settles with your counting houses on the way' : ''}.</span>
        <span><button data-a="g_100">+100</button><button data-a="g_500">+500</button><button data-a="g_all">All</button><button data-a="g_0">None</button></span></div>`
        : `<p class="hint">Her purse: <b>${f.gold || 0}</b> gold. You are not in port with her, so you can't send her more.</p>`;
      const last = stops[stops.length - 1];
      const legs = stops.length < 2 ? '<li><i>Add at least one more port.</i></li>' : stops.map((a, j) => {
        const b = stops[(j + 1) % stops.length], best = routeGood(PORTS[a], PORTS[b]);
        return `<li>${PORTS[a].name} → ${PORTS[b].name}: ${best ? `${goodName(best.g)}, about <b>+${best.margin}g</b> a crate at today's prices` : '<i>nothing pays today: she would sail in ballast</i>'}</li>`;
      }).join('');
      const adds = PORTS.map((p, j) => `<button data-a="add_${j}" ${j === last || j === stops[0] || stops.length >= ROUTE_MAX ? 'disabled' : ''}>${p.name}</button>`).join('');
      UI.show(`<h1>⚑ Trade route for the ${esc(f.name)}</h1>
        <p><b>Route:</b> ${stops.map(i => PORTS[i].name).join(' → ')}${stops.length > 1 ? ` → <i>back to ${PORTS[stops[0]].name}</i>` : ''}</p><ul>${legs}</ul>
        <p class="hint">Add up to ${ROUTE_MAX} ports. At each stop her factor sells what she carries and buys, out of her purse, up to ${fc.cargo} crates of whichever good fetches the best price at the next stop. Where you own a counting house she banks her takings above the purse you give her, or draws on it to make the purse up. She sails on her own, and pirates prey on a laden ship.</p>
        ${purse}<div class="row" style="flex-wrap:wrap">${adds}</div>
        <div class="row"><button class="primary" data-a="go" ${stops.length < 2 ? 'disabled' : ''}>Set her on the route</button><button data-a="undo" ${stops.length < 2 ? 'disabled' : ''}>Undo last port</button><button data-a="back" data-k="Escape">Cancel</button></div>`, a => {
        if (a === 'back') return done([]);
        if (a.startsWith('g_')) { const v = a.slice(2); give = v === 'all' ? s.gold : v === '0' ? 0 : give + +v; return render(); }
        if (a === 'undo') { if (stops.length > 1) stops.pop(); return render(); }
        if (a.startsWith('add_')) { const j = +a.slice(4); if (j !== last && j !== stops[0] && stops.length < ROUTE_MAX) stops.push(j); return render(); }
        if (a === 'go' && stops.length > 1) {
          give = Math.max(0, Math.min(give, s.gold)); s.gold -= give; f.gold = (f.gold || 0) + give;
          const float = f.gold;
          if (pi == null) { // ordered from headquarters while she is away: she sails for the first stop and trades from there
            Object.assign(f, { task: { type: 'route', stops: stops.slice(), leg: 0, profit: 0, trips: 0, float }, at: null, lie: 0 });
            return done([`The ${f.name} is ordered onto the route, and sails for ${PORTS[stops[0]].name}`]);
          }
          const port = PORTS[pi];
          Object.assign(f, { task: { type: 'route', stops: stops.slice(), leg: 0, profit: 0, trips: 0, float }, at: pi, lie: 0 });
          if (f.x == null) Object.assign(f, { x: port.sx, y: port.sy, heading: port.ang });
          return done(routeTrade(f, pi));
        }
      });
    };
    render();
  },

  // ---------- meeting ships at sea ----------
  encounter(npc) {
    const s = Campaign.s, hostile = this.map.hostileTo(npc);
    const list = npc.fleet.map(o => `<li><b>${o.name}</b> — ${SHIP_CLASSES[o.cls].name}, ${Math.max(1, Math.round(SHIP_CLASSES[o.cls].guns * (o.gunsMul || 1)))} guns a side${o.gun && o.gun !== 'culverin' ? ` of ${GUNS[o.gun].name.toLowerCase()}` : ''}${o.bow ? ', a bow chaser' : ''}${o.ram ? ', <b>a ram</b>' : ''}</li>`).join('');
    const fastest = Math.max(...npc.fleet.map(o => SHIP_CLASSES[o.cls].speed * (o.speedMul || 1)));
    const chance = clamp(.45 + (SHIP_CLASSES[s.ship.cls].speed - fastest) / 80, .15, .85);
    const intro = { merchant: npc.laden ? `A merchantman wallows ahead, low in the water with a hold full of ${goodName(npc.fleet[0].loot.good).toLowerCase()}.` : 'A merchantman rides high in ballast, bound for port to buy. Her hold is near empty, but she carries a purse.', pirate: npc.laden ? `Black sails! Rival pirates bear down on you, riding low and sluggish with stolen ${goodName(npc.fleet[0].loot.good).toLowerCase()}.` : 'Black sails! Rival pirates bear down on you, light and hungry.', hunter: 'Pirate hunters flying the royal banner have run you down.', patrol: npc.alert > 0 ? 'A navy patrol has run you down. They saw what you did, and mean to see you hang for it.' : 'A navy patrol keeps watch over the sea lanes. Her captain eyes your colours, but has no quarrel with you, unless you give him one.', boss: 'The Iron Leviathan looms out of the haze. Admiral Mordrake has found you.' }[npc.kind];
    const flag = npc.home != null && (npc.kind === 'merchant' || npc.kind === 'patrol') ? `<p>She flies the colours of <b>${PORTS[npc.home].name}</b>.${Quests.legal(npc) ? ' Fair game under your letter of marque: no navy will hold it against you.' : ''}</p>` : '';
    const turns = isMerchant() && !hostile && !Quests.legal(npc); // attacking her would make you a pirate
    const tribute = npc.kind === 'merchant' && !npc.paid ? `<button data-a="tribute" data-k="3">[3] Demand tribute (${Math.round(Quests.tributeChance(npc) * 100)}%)${isMerchant() ? ' — turn pirate' : ''}</button>` : '';
    const intro2 = isMerchant() && npc.kind === 'hunter' ? 'Pirate hunters flying the royal banner hail you. They see an honest merchant\'s colours and sheer off to look for pirates.'
      : isMerchant() && npc.kind === 'merchant' ? `A fellow merchant dips her colours to you in greeting.${npc.laden ? ` She is low in the water with ${goodName(npc.fleet[0].loot.good).toLowerCase()}.` : ''}`
      : isMerchant() && npc.kind === 'patrol' && !hostile ? 'A navy patrol keeps watch over the sea lanes. Her captain knows a Guild ship when he sees one, and waves you on.' : null;
    UI.show(`<h1>${npc.info.label}</h1><p>${intro2 || intro}</p>${flag}<ul>${list}</ul>
      <p class="hint">Your fleet: ${s.ship.name} (${SHIP_CLASSES[s.ship.cls].name}, ${s.ship.crew} crew)${wingFleet(s).map(f => `, ${esc(f.name)} (${SHIP_CLASSES[f.cls].name}${fleetReady(f) ? '' : ', too few hands to fight'})`).join('')}</p>
      <div class="row"><button class="primary" data-a="fight" data-k="1">[1] ${hostile ? 'Beat to quarters!' : turns ? 'Attack her — turn pirate!' : 'Run up the black flag!'}</button>
      <button data-a="leave" data-k="2">[2] ${hostile ? `Try to slip away (${Math.round(chance * 100)}%)` : (npc.kind === 'patrol' ? 'Dip your colours and sail on' : 'Let her pass')}</button>${tribute}</div>`,
      a => {
        UI.hide();
        if (a === 'tribute') return this.demandTribute(npc);
        if (a === 'fight' || (hostile && Math.random() > chance)) {
          if (a !== 'fight') Sfx.horn();
          this.startBattle(npc);
        } else { npc.cool = hostile ? 14 : 8; this.map.msg(hostile ? 'You slip away into the swell.' : npc.kind === 'patrol' ? 'The patrol lets you pass.' : 'You let her pass.'); }
      });
  },
  demandTribute(npc) {
    const s = Campaign.s;
    npc.paid = true;
    if (!Quests.legal(npc)) { this.map.witness(npc); this.turnPirate(); } // extortion in sight of the navy is still piracy
    if (Math.random() < Quests.tributeChance(npc)) {
      const g = Quests.tribute(npc); s.gold += g; npc.cool = 40; Sfx.coin(); Campaign.save();
      UI.show(`<h1>Tribute paid</h1><p>Her master takes one look at your guns and sends over a chest: <b>${g} gold</b> to be left in peace.</p><div class="row"><button class="primary" data-a="ok">Let her go</button></div>`, () => UI.hide());
    } else UI.show(`<h1>Refused!</h1><p>Her master runs up his colours and tells you to go hang.</p>
      <div class="row"><button class="primary" data-a="fight" data-k="1">[1] Then we take it all</button><button data-a="leave" data-k="2">[2] Let her go</button></div>`,
      a => { UI.hide(); if (a === 'fight') this.startBattle(npc); else { npc.cool = 8; this.map.msg('You let her pass.'); } });
  },
  startBattle(npc) {
    const s = Campaign.s;
    const fleet = [{ cls: s.ship.cls, style: 'player', isPlayer: true, human: true, commandable: true, stock: s.ammo, name: s.ship.name, hull: s.ship.hull, sailHp: s.ship.sailHp, crew: s.ship.crew, up: s.up, ...fitOf(s.ship) }]
      .concat(wingFleet(s).filter(fleetReady).map(f => ({ cls: f.cls, style: 'ally', commandable: !f.hired, name: f.name, hull: f.hull, sailHp: f.sailHp, crew: f.crew, stock: f.ammo, ref: f, ...fitOf(f) })));
    if (!this.map.hostileTo(npc) && !Quests.legal(npc)) { this.map.witness(npc); this.turnPirate(); } // falling on a merchant (or a peaceable patrol) in sight of the navy
    const sim = new Battle({ teams: [fleet, npc.fleet] });
    sim.player = sim.ships.find(x => x.isPlayer);
    this.battle = { sim, npc, view: new BattleView(sim.player), done: false };
    this.mode = 'battle';
  },
  updateBattle(dt) {
    const b = this.battle, sim = b.sim;
    const mates = sim.ships.filter(o => o.commandable && o.state === 'active');
    if (!sim.over && mates.length > 1) {
      if (Input.was('Tab')) { // take command of the next ship in the line
        const next = mates[(mates.indexOf(sim.helm) + 1) % mates.length];
        if (sim.takeHelm(next)) b.view.msg(`You take command of the ${next.name}`);
      }
      if (Input.was('f')) {
        sim.fleetOrder = sim.fleetOrder === 'form' ? 'engage' : 'form';
        b.view.msg(sim.fleetOrder === 'form' ? 'Signal flown: form on me!' : 'Signal flown: engage at will!');
      }
      b.view.fleetHint = `Tab: command another ship (${mates.length} in your fleet) · F: fleet orders — ${sim.fleetOrder === 'form' ? 'form on me' : 'engage at will'}`;
    } else b.view.fleetHint = null;
    const p = sim.helm;
    if (p.state === 'active' && !sim.over) readBattleKeys(p.ctrl, p);
    else p.ctrl.rudder = 0;
    sim.update(dt);
    for (const ev of sim.events.splice(0)) b.view.event(ev, sim);
    b.view.update(dt, sim);
    if (sim.finished && !b.done) {
      b.done = true;
      sim.result = this.battleResult(sim);
      sim.routed = sim.result === 'victory' && sim.ships.every(x => x.team !== 1 || x.state === 'escaped');
      this.endBattle(sim, b.npc);
    }
  },
  // after a battle: fleet ships that fought keep their damage, losses and spent shot; sunk or taken ones are gone.
  // Returns how many were lost. Undermanned ships stayed out of it and are untouched.
  settleFleet(b) {
    const s = Campaign.s, before = s.fleet.length;
    s.fleet = s.fleet.filter(f => {
      const sh = b.ships.find(x => x.src.ref === f); if (!sh) return true;
      if (sh.state !== 'active' && sh.state !== 'escaped') return false;
      f.hull = Math.max(1, sh.hull); f.sailHp = sh.sailHp; f.crew = Math.max(0, Math.round(sh.crew)); return true;
    });
    const had = holdUsed(s); trimHold(s, holdCap(s)); // the ships that went down took their share of the cargo with them
    if (had > holdUsed(s)) this.map.msg(`${had - holdUsed(s)} crates of cargo went down with your lost ships.`, '#ff9a8a');
    return before - s.fleet.length;
  },
  battleResult(sim) {
    const p = sim.helm; // the ship the captain is aboard when it ends
    return p.state === 'escaped' ? 'fled' : p.state !== 'active' ? 'defeat' : 'victory';
  },
  battleBanner() {
    const sim = this.battle.sim;
    if (!sim.over) return null;
    const r = this.battleResult(sim);
    if (r === 'victory' && sim.ships.every(x => x.team !== 1 || x.state === 'escaped')) return { text: 'THEY GOT AWAY' };
    return { victory: { text: 'VICTORY' }, defeat: { text: 'DEFEAT', col: '#ff7a6a' }, fled: { text: 'ESCAPED' } }[r];
  },
  endBattle(b, npc) {
    const s = Campaign.s, p = b.player, map = this.map;
    this.battle = null; this.mode = 'map'; map.safe = 3;
    const back = () => { UI.hide(); map.refreshShip(); Campaign.save(); };

    const lostFleet = this.settleFleet(b);
    if (b.result === 'defeat') {
      if (ownWing(s).length) { // the flagship is gone, but the captain gets across to what is left of the fleet
        const old = s.ship.name, f = ownWing(s).sort((x, y) => SHIP_CLASSES[y.cls].cost - SHIP_CLASSES[x.cls].cost || y.hull - x.hull)[0];
        s.fleet.splice(s.fleet.indexOf(f), 1);
        s.ship = { cls: f.cls, name: f.name, hull: Math.max(1, f.hull), sailHp: f.sailHp, crew: Math.max(6, f.crew), ...fitOf(f) };
        const sunk = Math.ceil(s.gold / 2); s.gold -= sunk; takePurse(s, f);
        s.ammo = f.ammo; s.hold = {}; Quests.onDefeat(); npc.cool = 20;
        UI.show(`<h1>The ${esc(old)} is lost</h1><p>Your flagship is gone, and her hold with her${sunk ? `, and ${sunk} gold of what was in her strongroom` : ''}. In the smoke you and a handful of hands get across to the <b>${esc(f.name)}</b> (${SHIP_CLASSES[f.cls].name}) and break away. She flies your colours now.</p>${lostFleet ? `<p>${lostFleet} more of your fleet went down or struck.</p>` : ''}${wingFleet(s).length ? `<p>Still sailing with you: ${wingFleet(s).map(x => esc(x.name)).join(', ')}.</p>` : ''}<div class="row"><button class="primary" data-a="ok">Sail on</button></div>`, back);
        return;
      }
      const home = s.hq != null, port = home ? PORTS[s.hq] : PORTS.slice().sort((a, c) => dist(a, s) - dist(c, s))[0], lost = s.gold - Math.floor(s.gold / 2);
      s.gold -= lost; s.hold = {}; Quests.onDefeat();
      s.fleet = s.fleet.filter(f => !f.hired || f.hired.kind !== 'escort'); // hired escorts don't stay to fish you out
      const laid = home ? propsOf(s, s.hq).dock || [] : [], spare = laid.slice().sort((x, y) => SHIP_CLASSES[y.cls].cost - SHIP_CLASSES[x.cls].cost || y.hull - x.hull)[0];
      if (spare) { // a ship laid up at headquarters is waiting for you
        laid.splice(laid.indexOf(spare), 1);
        s.ship = { cls: spare.cls, name: spare.name, hull: Math.max(1, spare.hull), sailHp: spare.sailHp, crew: Math.max(6, spare.crew), ...fitOf(spare) }; s.ammo = spare.ammo;
      } else { s.ship = { cls: 'cog', name: 'Driftwood', hull: 0, sailHp: 100, crew: 18 }; s.ship.hull = Campaign.maxHull(); }
      s.x = port.sx; s.y = port.sy; s.heading = port.ang; npc.cool = 20;
      const banked = bankTotal(s);
      UI.show(`<h1>Lost at sea</h1><p>Your ship is gone. ${home ? `Fishermen pull you from the water and carry you home to your headquarters at <b>${port.name}</b>` : `You wash ashore near <b>${port.name}</b> clinging to a spar`}, ${lost} gold lighter and your hold at the bottom of the sea.</p>
        <p>${spare ? `The <b>${esc(spare.name)}</b> (${SHIP_CLASSES[spare.cls].name}) lies ready in your dock. You hoist your colours aboard her.` : 'A sympathetic smuggler sells you a battered cog and a scratch crew on credit.'} The sea is not done with you yet.</p>
        ${banked ? `<p class="hint">The ${banked} gold in your counting houses is safe ashore.</p>` : ''}<div class="row"><button class="primary" data-a="ok">Begin again</button></div>`, back);
      return;
    }
    let flagNote = '';
    if (p.state === 'active' || p.state === 'escaped') { s.ship.hull = Math.max(1, p.hull); s.ship.sailHp = p.sailHp; s.ship.crew = Math.max(1, p.crew); }
    else { // the flagship went down (or struck) but the fight went on: the ship the captain ended aboard flies his colours now
      const old = s.ship.name, h = b.helm.src.ref;
      const f = s.fleet.includes(h) && !h.hired ? h : ownWing(s).sort((x, y) => SHIP_CLASSES[y.cls].cost - SHIP_CLASSES[x.cls].cost || y.hull - x.hull)[0];
      s.fleet.splice(s.fleet.indexOf(f), 1);
      s.ship = { cls: f.cls, name: f.name, hull: Math.max(1, f.hull), sailHp: f.sailHp, crew: Math.max(1, f.crew), ...fitOf(f) };
      const sunk = Math.ceil(s.gold / 2); s.gold -= sunk; takePurse(s, f);
      s.ammo = f.ammo; s.hold = {}; Quests.onDefeat();
      flagNote = `The ${old} is lost with her hold${sunk ? ` and ${sunk} gold` : ''}. The ${f.name} is your flagship now.`;
    }
    const lostEsc = lostFleet;
    if (b.result === 'fled') {
      npc.cool = 14; map.refreshShip(); Campaign.save();
      map.msg('You run before the wind and lose them.' + (lostEsc ? ` ${lostEsc} of your fleet lost.` : '') + (flagNote ? ' ' + flagNote : ''));
      return;
    }
    // victory: count the spoils
    let gold = 0, cargo = 0, stowed = 0, fame = 0, press = 0, won = false;
    const lines = [], prizes = [];
    for (const e of b.ships.filter(x => x.team === 1)) {
      const c = e.c;
      if (e.state === 'sunk' || e.state === 'sinking') {
        const g = Math.round(e.loot.gold * .3); gold += g; fame += c.fame;
        lines.push(`<b>${e.name}</b> (${c.name}) sunk — ${g} gold salvaged from the wreckage`);
        if (e.boss) won = true;
      } else if (e.state === 'captured' || e.state === 'surrendered') {
        const prize = Math.round(c.cost * .25);
        gold += e.loot.gold + prize; fame += c.fame + 2; press += Math.round(e.crew * .3);
        if (!e.loot.good) e.loot.good = pick(TRADE_GOODS); // a fleet saved in a job from before pirates carried real goods
        const k = stow(s, e.loot.good, e.loot.cargo); cargo += e.loot.cargo; stowed += k;
        prizes.push({ e, prize, stowed: k });
        lines.push(`<b>${e.name}</b> (${c.name}) taken — ${e.loot.gold} gold${e.loot.cargo ? `, ${e.loot.cargo} crates of ${goodName(e.loot.good).toLowerCase()}` : ''}, hull sold as a prize for ${prize}`);
        if (e.boss) won = true;
      } else lines.push(`<b>${e.name}</b> escaped`);
    }
    npc.fleet = npc.fleet.filter(o => b.ships.some(x => x.src === o && (x.state === 'escaped' || x.state === 'active')));
    if (npc.fleet.length) { npc.cool = 25; npc.ship = npcShip(npc); }
    else map.npcs = map.npcs.filter(n => n !== npc);
    lines.push(...Quests.afterBattle(npc, b, prizes));
    if (flagNote) lines.push(esc(flagNote));
    let joined = Math.min(press, SHIP_CLASSES[s.ship.cls].crew - s.ship.crew);
    const held = Math.min(press - joined, SHIP_CLASSES[s.ship.cls].crew); // the rest go below in irons
    s.prisoners.men += held;
    const merit = npc.kind === 'pirate' ? addStanding(s, fame) : 0; // a merchant who beats off pirates is well thought of
    s.gold += gold; s.fame += fame; s.ship.crew += joined;
    if (won && s.boss !== 2) s.boss = 2; else won = false;
    Sfx.coin();
    let taken = false, dumped = 0;
    const render = () => UI.show(`<h1>${b.routed ? 'They got away' : 'Victory!'}</h1><ul>${lines.map(l => `<li>${l}</li>`).join('')}</ul>
      <div class="stats">+<b>${gold}</b> gold · +<b>${stowed}</b> crates stowed${stowed < cargo ? ' (hold full!)' : ''} · +<b>${fame}</b> fame${merit ? ` · +<b>${merit}</b> guild standing` : ''}${joined ? ` · <b>${joined}</b> prisoners join your crew` : ''}${s.prisoners.men + s.prisoners.officers ? ` · <b>${s.prisoners.men + s.prisoners.officers}</b> held for ransom` : ''}${lostEsc ? ` · <b>${lostEsc}</b> of your fleet lost` : ''}</div>
      ${taken ? `<p class="hint">You hoist your colours aboard the ${s.ship.name}.${dumped ? ` Her hold is smaller: ${dumped} crates of the cheapest cargo go over the side.` : ''}</p>` : prizes.filter(z => z.e.cls !== s.ship.cls).map(z => `<div class="item"><span>Keep the <b>${z.e.name}</b> (${z.e.c.name}) as your flagship instead of selling her? Your old ship is sold.</span><button data-a="take${prizes.indexOf(z)}">Take her</button></div>`).join('')}
      <div class="row"><button class="primary" data-a="ok">Sail on</button>${joined ? `<button data-a="ransom">Hold the ${joined} pressed men for ransom instead</button>` : ''}</div>`,
      onAct);
    const onAct = a => {
      if (a === 'ransom') { s.ship.crew -= joined; s.prisoners.men += joined; joined = 0; render(); return; }
      if (a.startsWith('take')) {
        const sure = a.startsWith('take!'), { e, prize } = prizes[+a.slice(sure ? 5 : 4)];
        if (!sure && this.downgradeHtml(e.cls))
          return this.confirm(this.downgradeHtml(e.cls) + '<p>Your old ship is sold.</p>', 'Take her anyway', () => onAct('take!' + a.slice(4)), render);
        s.gold += Math.round(SHIP_CLASSES[s.ship.cls].cost * .25) - prize;
        s.ship = { cls: e.cls, name: e.name, hull: Math.max(e.hull, e.c.hull * .3), sailHp: Math.max(e.sailHp, 30), crew: Math.min(s.ship.crew, e.c.crew), ...fitOf(e) };
        const had = holdUsed(s); trimHold(s, holdCap(s)); dumped = had - holdUsed(s); taken = true; render(); return;
      }
      back();
      if (won) UI.show(`<h1>Scourge of the Shattered Sea</h1><p>The Iron Leviathan is no more, and Admiral Mordrake's banner hangs in your cabin. From Lisbon to Calcutta, no flag flies without your leave.</p><p>You have won — but the sea lanes are still full of fat merchants, and the voyage goes on for as long as you wish.</p><div class="row"><button class="primary" data-a="ok">Sail on</button></div>`, () => UI.hide());
    };
    render();
  },
};
addEventListener('load', () => Game.init());
