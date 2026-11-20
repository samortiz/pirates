'use strict';
// Ways to earn a living besides plunder: notice-board contracts, letters of marque, prisoners for ransom,
// dock work, tribute, plus the things you find at sea (wreckage, fish, buried treasure).
// Campaign only: nothing here runs on the server.

const CAPTAINS = ['Black Annis', 'Red Rorik', 'Mad Tam Gallow', 'Saltjaw Morwen', 'Ivo the Gaunt', 'Long Seren', 'Grisel Hookhand', 'Old Brannagh', 'Cutthroat Wynn', 'Hollow Jack'];
const QUEST_INFO = {
  deliver: { icon: '📦', name: 'Delivery contract' },
  courier: { icon: '✉', name: 'Courier run' },
  bounty:  { icon: '☠', name: 'Bounty' },
  recover: { icon: '⚖', name: 'Recover stolen cargo' },
  escort:  { icon: '⛵', name: 'Escort' },
  smuggle: { icon: '🗝', name: 'Smuggling run' },
  marque:  { icon: '📜', name: 'Letter of marque' },
};
const SMUGGLER_PORTS = ['Port Royal', 'Algiers']; // always have a smuggling job; other ports only sometimes
const FISH_EVERY = 8, DIG_TIME = 3, SEARCH_RANGE = 240;

const Quests = {
  MAX: 5,
  ensure(s) { // fill in fields that saves from before quests lack
    s.quests = s.quests || []; s.offers = s.offers || {}; s.banned = s.banned || {}; s.seize = s.seize || [];
    s.prisoners = s.prisoners || { men: 0, officers: 0, value: 0 }; s.maps = s.maps || []; s.qid = s.qid || 1;
  },
  travel(a, b) { return portDist(a, b) / 2200 + .4; }, // rough days under sail between two ports
  tier() { return 1 + renown() / 60; },
  marque() { const m = Campaign.s.quests.find(q => q.type === 'marque'); return m && m.due >= Campaign.s.day ? m : null; },
  legal(npc) { const m = this.marque(); return !!m && npc.kind === 'merchant' && npc.home === m.against; },
  rival(npc) { const m = this.marque(); return !!m && npc.kind === 'patrol' && npc.home === m.against; },
  reserved(g) { return Campaign.s.quests.filter(q => q.type === 'deliver' && q.good === g).reduce((a, q) => a + q.n, 0); },
  merit(n) { const k = addStanding(Campaign.s, n); return k ? `, +${k} guild standing` : ''; }, // honest work counts toward a merchant's seat on the Guild
  daysLeft(q) { return Math.max(0, q.due - Campaign.s.day); },

  // ---------- the notice board ----------
  offers(i) {
    const s = Campaign.s, bucket = Math.floor(s.day / 2); // the board changes every two days
    if (s.banned[i] > s.day) return [];
    const o = s.offers[i];
    if (o && o.day === bucket) return o.list;
    const list = [], n = randInt(2, 3);
    if (SMUGGLER_PORTS.includes(PORTS[i].name)) list.push(this.gen(i, 'smuggle'));
    const types = [['deliver', 3], ['courier', 2], ['bounty', 1.5], ['recover', 1], ['escort', 1.5], ['smuggle', .4]];
    if (!this.marque()) types.push(['marque', .8]);
    while (list.length < n + (list.length && list[0].type === 'smuggle' ? 1 : 0)) {
      let r = rand(types.reduce((a, t) => a + t[1], 0)), t = types[0][0];
      for (const [k, w] of types) { if ((r -= w) <= 0) { t = k; break; } }
      if (t === 'marque' && list.some(q => q.type === 'marque')) continue;
      list.push(this.gen(i, t));
    }
    s.offers[i] = { day: bucket, list };
    return list;
  },
  gen(i, type) {
    const s = Campaign.s, port = PORTS[i], tier = this.tier();
    const others = PORTS.map((p, j) => j).filter(j => j !== i);
    const q = { type, from: i };
    if (type === 'deliver') {
      q.good = pick(port.makes);
      const dests = others.filter(j => PORTS[j].wants.includes(q.good));
      q.to = pick(dests.length ? dests : others); q.n = randInt(6, 14);
      const t = this.travel(i, q.to);
      q.pay = Math.round((q.n * GOODS[q.good].base * .5 + t * 60) * tier); q.dur = t * 2 + 1.5;
    } else if (type === 'courier') {
      q.to = pick(others); const t = this.travel(i, q.to);
      q.pay = Math.round((50 + t * 70) * tier); q.fast = t + .5; q.dur = t * 1.6 + 1;
    } else if (type === 'smuggle') {
      q.to = pick(others); q.n = randInt(5, 10); const t = this.travel(i, q.to);
      q.pay = Math.round((q.n * 45 + t * 50) * tier); q.dur = t * 1.8 + 1.5;
    } else if (type === 'escort') {
      q.to = pick(others); q.good = pick(port.makes); const t = this.travel(i, q.to);
      const f = genFleet('merchant', renown())[0]; f.loot = merchantLoot(f.cls, true, q.good); q.fleet = [f];
      q.pay = Math.round((80 + t * 90) * tier); q.dur = t * 3 + 2;
    } else if (type === 'bounty' || type === 'recover') {
      q.captain = pick(CAPTAINS); q.fleet = genFleet('pirate', renown() + 15);
      q.fleet[0].name = q.captain.split(' ').pop() + "'s " + pick(['Revenge', 'Fury', 'Widow', 'Gallows', 'Ruin']);
      if (type === 'recover') {
        q.good = pick(TRADE_GOODS); q.n = randInt(8, 16);
        q.fleet[0].loot = { gold: q.fleet[0].loot.gold, cargo: q.n, good: q.good };
        for (const f of q.fleet) Object.assign(f, LADEN_WEIGHT);
        q.per = Math.round(GOODS[q.good].base * 1.5 * tier);
      } else q.pay = Math.round((150 + 130 * q.fleet.length) * tier);
      q.dur = 6;
      const pt = this.seaNear(port, 1800); q.x = pt.x; q.y = pt.y;
    } else if (type === 'marque') {
      q.against = pick(others); q.per = Math.round(90 * tier); q.dur = 6; q.earned = 0;
    }
    return q;
  },
  seaNear(port, r) {
    for (let k = 0; k < 80; k++) {
      const a = rand(TAU), d = rand(500, r), pt = { x: port.sx + Math.cos(a) * d, y: port.sy + Math.sin(a) * d };
      pt.x = wrapX(pt.x); if (pt.y < 150 || pt.y > WORLD.H - 150) continue;
      if (onLand(pt.x, pt.y, 80) || !seaOK(pt.x, pt.y)) continue;
      return pt;
    }
    return { x: port.sx, y: port.sy };
  },
  describe(q) {
    const to = q.to != null ? `<b>${PORTS[q.to].name}</b>` : '', from = `<b>${PORTS[q.from].name}</b>`;
    const days = d => `${Math.max(1, Math.round(d))} day${Math.round(d) === 1 ? '' : 's'}`;
    const due = q.due != null ? days(this.daysLeft(q)) + ' left' : days(q.dur);
    switch (q.type) {
      case 'deliver': return `Carry ${q.n} crates of ${goodName(q.good).toLowerCase()} to ${to} — ${q.pay}g on delivery (${due}). Cargo provided; the merchant's agents seize it if you fail.`;
      case 'courier': return `Carry sealed letters to ${to} — up to ${q.pay}g, less the slower you are (${due}).`;
      case 'smuggle': return `Run ${q.n} crates of contraband to ${to} — ${q.pay}g. Keep clear of navy patrols: they search ships that come close (${due}).`;
      case 'escort': return `See the merchantman <b>${esc(q.fleet[0].name)}</b> safe to ${to} — ${q.pay}g when she arrives (${due}).`;
      case 'bounty': return `Sink or take <b>${q.captain}</b>'s pirates, last seen off ${from} — ${q.pay}g, claim here (${due}).`;
      case 'recover': return `<b>${q.captain}</b> stole ${q.n} crates of ${goodName(q.good).toLowerCase()} from ${from}'s merchants. Take her ship and bring it back — ${q.per}g a crate (${due}).`;
      case 'marque': return `A letter of marque against <b>${PORTS[q.against].name}</b>: take her merchants with the law on your side, ${q.per}g each from ${from}'s treasury. ${PORTS[q.against].name}'s navy will hunt you (${due}).`;
    }
  },
  accept(i, k) {
    const s = Campaign.s, list = this.offers(i), o = list[k];
    if (!o) return 'That job is gone.';
    if (s.quests.length >= this.MAX) return `You already have ${this.MAX} jobs.`;
    if ((o.type === 'deliver' || o.type === 'smuggle') && holdCap(s) - holdUsed(s) < o.n) return 'Not enough room in your hold.';
    if (o.type === 'escort' && s.quests.some(q => q.type === 'escort')) return 'You can only escort one ship at a time.';
    if (o.type === 'marque' && this.marque()) return 'You already sail under a letter of marque.';
    const q = Object.assign(JSON.parse(JSON.stringify(o)), { id: s.qid++, start: s.day, due: s.day + o.dur });
    list.splice(k, 1); s.quests.push(q);
    if (q.type === 'deliver') stow(s, q.good, q.n);
    if (q.type === 'smuggle') stow(s, 'contraband', q.n);
    if (q.type === 'escort') { const p = PORTS[i]; q.x = p.sx; q.y = p.sy; }
    if (q.fleet) Game.map.spawnQuest(q);
    return null;
  },
  remove(q) { const s = Campaign.s; s.quests = s.quests.filter(x => x !== q); },
  fail(q, why, map = Game.map) {
    const s = Campaign.s;
    this.remove(q);
    if (q.type !== 'marque') s.banned[q.from] = s.day + 4; // that port's board won't deal with you for a while
    if (q.type === 'deliver') s.seize.push({ good: q.good, n: q.n, from: q.from });
    if (q.type === 'smuggle') s.seize.push({ good: 'contraband', n: q.n, from: q.from });
    if (map) for (const n of map.npcs) if (n.q === q.id) { n.q = null; if (n.charge) n.dead = true; }
    if (map) map.msg(`${QUEST_INFO[q.type].name} failed: ${why}`, '#ff9a8a');
  },

  // ---------- arriving in port: hand in, get paid, get caught out ----------
  onDock(port) {
    const s = Campaign.s, i = PORTS.indexOf(port), news = [];
    for (const z of s.seize.splice(0)) {
      const k = Math.min(z.n, s.hold[z.good] || 0);
      if (k) { s.hold[z.good] -= k; if (!s.hold[z.good]) delete s.hold[z.good]; news.push(`Agents from ${PORTS[z.from].name} are waiting on the quay. They seize ${k} crates of ${goodName(z.good).toLowerCase()} you failed to deliver.`); }
    }
    const take = (g, n) => { s.hold[g] -= n; if (!s.hold[g]) delete s.hold[g]; };
    for (const q of s.quests.slice()) {
      if (q.type === 'deliver' && q.to === i) {
        if ((s.hold[q.good] || 0) >= q.n) { take(q.good, q.n); s.gold += q.pay; this.remove(q); news.push(`📦 Delivered ${q.n} crates of ${goodName(q.good).toLowerCase()}: <b>+${q.pay}g</b>${this.merit(3)}`); }
        else { this.fail(q, 'you arrived short of cargo', null); news.push(`📦 You are short of the ${goodName(q.good).toLowerCase()} you were hired to deliver. The contract is void.`); }
      } else if (q.type === 'courier' && q.to === i) {
        const late = s.day - q.start - q.fast, span = q.due - q.start - q.fast;
        const pay = Math.round(q.pay * (late <= 0 ? 1 : clamp(1 - .6 * late / span, .4, 1)));
        s.gold += pay; this.remove(q); news.push(`✉ Letters delivered${late > 0 ? ', a little late' : ' in good time'}: <b>+${pay}g</b>${this.merit(2)}`);
      } else if (q.type === 'smuggle' && q.to === i) {
        if ((s.hold.contraband || 0) >= q.n) { take('contraband', q.n); s.gold += q.pay; this.remove(q); news.push(`🗝 The contraband slips ashore by night: <b>+${q.pay}g</b>`); }
        else { this.fail(q, 'the contraband is gone', null); news.push('🗝 You have lost the contraband. The smugglers want nothing more to do with you.'); }
      } else if (q.type === 'escort' && q.to === i && q.arrived) {
        s.gold += q.pay; this.remove(q); news.push(`⛵ The ${esc(q.fleet[0].name)} came safe to harbour: <b>+${q.pay}g</b>${this.merit(4)}`);
      } else if (q.type === 'bounty' && q.from === i && q.done) {
        s.gold += q.pay; s.fame += 3; this.remove(q); news.push(`☠ Bounty on ${q.captain} paid: <b>+${q.pay}g</b>, +3 fame${this.merit(3)}`);
      } else if (q.type === 'recover' && q.from === i && q.done) {
        const k = Math.min(q.got || 0, s.hold[q.good] || 0);
        if (k) take(q.good, k);
        s.gold += k * q.per; this.remove(q);
        news.push(`⚖ ${k ? `Returned ${k} crates of ${goodName(q.good).toLowerCase()}: <b>+${k * q.per}g</b>` : `${q.captain} is dealt with, but you brought none of the cargo back. No reward.`}`);
      } else if (q.type === 'marque' && q.from === i && q.earned) {
        s.gold += q.earned; news.push(`📜 The treasury pays for your prizes under the letter of marque: <b>+${q.earned}g</b>`); q.earned = 0;
        if (q.due < s.day) this.remove(q);
      }
    }
    return news;
  },
  // board + tavern extras shown in the port menu
  boardHtml(i, btn) {
    const s = Campaign.s, offers = this.offers(i);
    const mine = s.quests.map(q => `<div class="item"><span>${QUEST_INFO[q.type].icon} ${this.describe(q)}${q.done ? ' <b>Done: collect your pay.</b>' : q.arrived ? ' <b>She has arrived.</b>' : ''}</span>${btn('drop_' + q.id, 'Abandon')}</div>`).join('');
    const board = s.banned[i] > s.day ? `<p class="hint">The harbourmaster remembers the last job you botched. No work here for ${Math.ceil(s.banned[i] - s.day)} more days.</p>`
      : offers.map((q, k) => `<div class="item"><span>${QUEST_INFO[q.type].icon} <b>${QUEST_INFO[q.type].name}.</b> ${this.describe(q)}</span>${btn('take_' + k, 'Accept', s.quests.length < this.MAX)}</div>`).join('') || '<p class="hint">Nothing posted. Come back in a day or two.</p>';
    return `<section style="grid-column:1/-1"><h3>Notice board <span style="font-size:12px;font-weight:normal">(${s.quests.length}/${this.MAX} jobs taken)</span></h3>${board}
      ${mine ? `<h3 style="margin-top:10px">Your jobs</h3>${mine}` : ''}</section>`;
  },
  tavernHtml(btn) {
    const s = Campaign.s, P = s.prisoners, ransom = P.men * 10 + P.value;
    return `<div class="item"><span>Prisoners in the hold: ${P.men} sailors, ${P.officers} officers</span>${btn('ransom', P.men + P.officers ? `Ransom ${ransom}g` : 'None', P.men + P.officers > 0)}</div>
      <div class="item"><span>Work the docks for three days (only for the desperate)</span>${this.workWait() > 0
        ? btn('work', `Rested in ${Math.ceil(this.workWait() / 60000)} min`, false) : btn('work', '+45g', s.gold < 150)}</div>`;
  },
  WORK_REST: 5 * 60 * 1000, // real time (ms) before you can work the docks again
  workWait() { return Math.min(this.WORK_REST, Math.max(0, (Campaign.s.workAt || 0) + this.WORK_REST - Date.now())); }, // capped, should the clock be set back
  // returns an error string, '' when handled, or null when the action isn't ours
  portAct(a, i) {
    const s = Campaign.s;
    if (a.startsWith('take_')) return this.accept(i, +a.slice(5)) || '';
    if (a.startsWith('drop_')) {
      const q = s.quests.find(x => x.id === +a.slice(5));
      if (q) { if (q.done || q.arrived) this.remove(q); else this.fail(q, 'abandoned'); }
      return '';
    }
    if (a === 'ransom') { s.gold += s.prisoners.men * 10 + s.prisoners.value; s.prisoners = { men: 0, officers: 0, value: 0 }; Sfx.coin(); return ''; }
    if (a === 'work') { if (this.workWait() > 0) return 'Your back still aches from the last shift.'; s.gold += 45; s.day += 3; s.workAt = Date.now(); Sfx.coin(); return ''; }
    return null;
  },
  logHtml() {
    const s = Campaign.s;
    const jobs = s.quests.map(q => `<li>${QUEST_INFO[q.type].icon} ${this.describe(q)}</li>`).join('');
    const maps = s.maps.length ? `<li>🗺 ${s.maps.length} treasure map${s.maps.length > 1 ? 's' : ''}: sail to the ✕ on your chart and stop there to dig.</li>` : '';
    const P = s.prisoners, pris = P.men + P.officers ? `<li>⛓ ${P.men} sailors and ${P.officers} officers held for ransom (any tavern)</li>` : '';
    return jobs || maps || pris ? `<h3>Orders &amp; contracts</h3><ul>${jobs}${maps}${pris}</ul>` : '<p class="hint">No jobs taken. Look for the notice board in any port.</p>';
  },

  // ---------- after a battle ----------
  // npc: the fleet you fought. caps: [{ e, stowed }] for each ship you captured. Returns lines for the results screen.
  afterBattle(npc, b, caps) {
    const s = Campaign.s, lines = [], q = npc.q && s.quests.find(x => x.id === npc.q), m = this.marque();
    if (q && q.type === 'recover') q.got = (q.got || 0) + caps.filter(c => c.e.loot.good === q.good).reduce((a, c) => a + c.stowed, 0);
    if (q && !npc.fleet.length) { q.done = true; lines.push(`${QUEST_INFO[q.type].icon} ${q.captain} is finished. Claim your reward in ${PORTS[q.from].name}.`); }
    if (m && this.legal(npc)) {
      const k = b.ships.filter(e => e.team === 1 && e.src.style === 'merchant' && e.state !== 'active' && e.state !== 'escaped').length;
      if (k) { m.earned += k * m.per; lines.push(`📜 ${k} lawful prize${k > 1 ? 's' : ''} under your letter of marque: ${k * m.per}g owed in ${PORTS[m.from].name}`); }
    }
    for (const c of caps) {
      s.prisoners.officers++; s.prisoners.value += 30 + c.e.c.fame * 10; // every prize gives up an officer worth a ransom
      if (c.e.boss || Math.random() < .15) { const mp = this.newMap(); s.maps.push(mp); lines.push(`🗺 Among the ${esc(c.e.name)}'s papers you find a treasure map! It marks a spot on ${mp.isl}.`); }
    }
    return lines;
  },
  onDefeat() {
    const s = Campaign.s;
    for (const q of s.quests.slice()) if (q.type === 'deliver' || q.type === 'smuggle') this.fail(q, 'the cargo went down with your ship');
    s.seize = []; s.prisoners = { men: 0, officers: 0, value: 0 };
  },
  newMap() {
    for (let tries = 0; tries < 60; tries++) { // a cove on some coast: an island two times in three
      const pool = LAND.polys.filter(P => P.small === Math.random() < .67), P = pick(pool.length ? pool : LAND.polys), [vx, vy] = pick(P.pts);
      const [nx, ny] = landNormal(vx, vy), x = wrapX(vx + nx * 30), y = vy + ny * 30;
      if (y < 100 || y > WORLD.H - 100 || onLand(x, y, 8)) continue;
      if (![[0, 0], [70, 0], [-70, 0], [0, 70], [0, -70]].some(([ox, oy]) => seaOK(x + nx * 60 + ox, y + ny * 60 + oy))) continue; // a ship must be able to get there
      const near = PORTS.slice().sort((p1, p2) => dist(p1, { x, y }) - dist(p2, { x, y }))[0];
      return { x, y, gold: Math.round(randInt(300, 900) * this.tier()), isl: P.small ? `${P.name}, near ${near.name}` : `the coast of ${coastName(P, x)} near ${near.name}`, dig: 0 };
    }
    return { x: PORTS[0].sx, y: PORTS[0].sy, gold: 300, isl: `the shore by ${PORTS[0].name}`, dig: 0 };
  },

  // ---------- at sea, every frame ----------
  update(map, dt) {
    const s = Campaign.s, p = map.ship;
    for (const q of s.quests.slice()) { // deadlines
      if (q.type === 'marque') { if (q.due < s.day && !q.earned) { this.remove(q); map.msg('Your letter of marque has expired.', '#ffd24a'); } continue; }
      if (q.due < s.day && !q.done && !q.arrived) this.fail(q, 'you ran out of time', map);
    }
    for (const n of map.npcs) if (n.charge) { const q = s.quests.find(x => x.id === n.q); if (q) { q.x = wrapX(n.x); q.y = n.y; } }
    // fishing: sails furled, lying still, out at sea
    if (p.sail === 0 && p.speed < 12 && !map.nearPort) {
      map.fishT = (map.fishT || 0) + dt;
      if (map.fishT >= FISH_EVERY) {
        map.fishT = 0;
        if (stow(s, 'fish', 1)) map.msg('Your crew hauls in a catch: +1 crate of salt fish', '#bfe0ff');
        else if (!map.fullWarned) { map.fullWarned = true; map.msg('Your hold is full: no room for the catch', '#ff9a8a'); }
      }
    } else { map.fishT = 0; map.fullWarned = false; }
    // treasure: stop at the spot to dig
    for (const mp of s.maps.slice()) {
      if (dist(mp, p) < 70 && p.speed < 20) {
        mp.dig += dt;
        if (mp.dig >= DIG_TIME) { s.gold += mp.gold; s.maps = s.maps.filter(x => x !== mp); Sfx.coin(); map.msg(`Your crew digs up a buried chest: +${mp.gold} gold!`, '#ffd24a'); Campaign.save(); }
      } else mp.dig = 0;
    }
    // wreckage and flotsam
    map.wrecks = map.wrecks || []; map.flotT = (map.flotT || 20) - dt;
    if (map.flotT <= 0) {
      map.flotT = rand(25, 45);
      if (map.wrecks.length < 6) {
        const pt = map.seaPoint(600), goods = Math.random() < .6;
        map.wrecks.push({ x: pt.x, y: pt.y, t: 180, kind: 'Flotsam', gold: goods ? 0 : randInt(10, 40), good: pick(TRADE_GOODS), n: goods ? randInt(1, 4) : 0 });
      }
    }
    for (const w of map.wrecks) {
      w.t -= dt;
      if (dist(w, p) < 45) {
        const k = w.n ? stow(s, w.good, w.n) : 0;
        s.gold += w.gold; w.t = 0; if (w.gold || k) Sfx.coin();
        map.msg(`${w.kind} hauled aboard: ${[w.gold && w.gold + ' gold', k && `${k} crates of ${goodName(w.good).toLowerCase()}`].filter(Boolean).join(' and ') || 'nothing worth keeping'}${w.n > k ? ' (hold full)' : ''}`, '#e3d29a');
      }
    }
    map.wrecks = map.wrecks.filter(w => w.t > 0);
    // smuggling: a patrol that gets close searches you
    map.searchWarn = false;
    if (s.hold.contraband) for (const n of map.npcs) {
      if (n.kind !== 'patrol' || n.alert > 0 || map.safe > 0) continue;
      const d = dist(n, p);
      if (d < SEARCH_RANGE * 2) map.searchWarn = true;
      if (d < SEARCH_RANGE && n.cool <= 0) {
        delete s.hold.contraband; n.alert = PATROL_ALERT;
        for (const q of s.quests.slice()) if (q.type === 'smuggle') { this.fail(q, 'a navy patrol searched you and seized the contraband', map); s.seize = s.seize.filter(z => z.good !== 'contraband'); }
        Sfx.horn(); break;
      }
    }
  },
  onRaid(map, mer) { // pirates took a merchant: what's left floats free
    const q = mer.q && Campaign.s.quests.find(x => x.id === mer.q);
    if (q) this.fail(q, `pirates took the ${q.fleet[0].name}`, map);
    const L = mer.fleet[0].loot;
    map.wrecks = map.wrecks || [];
    map.wrecks.push({ x: wrapX(mer.x), y: mer.y, t: 150, kind: 'Wreckage', gold: Math.round(L.gold * .25), good: L.good || pick(TRADE_GOODS), n: Math.round(L.cargo * .3) });
  },
  label(n) {
    const q = n.q && Campaign.s.quests.find(x => x.id === n.q);
    if (q && q.type === 'escort') return `Your charge: ${q.fleet[0].name}`;
    if (q && q.type === 'bounty') return `☠ ${q.captain} (bounty)`;
    if (q && q.type === 'recover') return `☠ ${q.captain} (stolen ${goodName(q.good).toLowerCase()})`;
    if (this.rival(n)) return `Navy of ${PORTS[n.home].name} (hunting you!)`;
    if (this.legal(n)) return `Merchant of ${PORTS[n.home].name} ⚔ fair game`;
    return null;
  },
  drawSea(ctx, map) { // world space
    const s = Campaign.s;
    for (const w of map.wrecks || []) {
      ctx.save(); ctx.translate(w.x, w.y); ctx.globalAlpha = Math.min(1, w.t / 10);
      ctx.fillStyle = '#6b4423';
      for (let k = 0; k < 4; k++) { ctx.save(); ctx.rotate(k * 1.7 + w.x); ctx.fillRect(-14 + k * 5, -2 - k * 4, 18, 4); ctx.restore(); }
      ctx.fillStyle = '#8a5a2e'; ctx.beginPath(); ctx.arc(8, 6, 5, 0, TAU); ctx.arc(-8, 8, 4, 0, TAU); ctx.fill();
      ctx.restore();
      hudText(ctx, w.kind, w.x, w.y - 16, 12, '#e3d29a', 'center');
    }
    for (const mp of s.maps) {
      ctx.strokeStyle = '#c0392b'; ctx.lineWidth = 6;
      ctx.beginPath(); ctx.moveTo(mp.x - 14, mp.y - 14); ctx.lineTo(mp.x + 14, mp.y + 14); ctx.moveTo(mp.x + 14, mp.y - 14); ctx.lineTo(mp.x - 14, mp.y + 14); ctx.stroke();
      hudText(ctx, mp.dig > 0 ? `Digging… ${Math.ceil(DIG_TIME - mp.dig)}` : 'Buried treasure', mp.x, mp.y - 22, 13, '#ffd24a', 'center', true);
    }
    for (const q of s.quests) if (q.to != null) { const pt = PORTS[q.to]; hudText(ctx, `${QUEST_INFO[q.type].icon} deliver here`, pt.x, pt.y - 30, 14, '#ffd24a', 'center'); }
  },
  drawChart(ctx, map, cx, my, k, pulse) { // cx(x): where world x falls on the chart (it scrolls with you)
    const s = Campaign.s;
    ctx.lineWidth = 1.5;
    for (const q of s.quests) if (q.to != null) { const pt = PORTS[q.to]; ctx.strokeStyle = '#ffd24a'; ctx.beginPath(); ctx.arc(cx(pt.x), my + pt.y * k, 6, 0, TAU); ctx.stroke(); }
    for (const n of map.npcs) if (n.q) {
      ctx.strokeStyle = n.charge ? `rgba(191,224,255,${.5 + .5 * pulse})` : `rgba(255,90,74,${.5 + .5 * pulse})`;
      ctx.beginPath(); ctx.arc(cx(n.x), my + n.y * k, 5 + pulse * 2, 0, TAU); ctx.stroke();
    }
    ctx.strokeStyle = '#ff4a3a'; ctx.lineWidth = 2;
    for (const mp of s.maps) { const x = cx(mp.x), y = my + mp.y * k; ctx.beginPath(); ctx.moveTo(x - 4, y - 4); ctx.lineTo(x + 4, y + 4); ctx.moveTo(x + 4, y - 4); ctx.lineTo(x - 4, y + 4); ctx.stroke(); }
    ctx.fillStyle = '#e3d29a';
    for (const w of map.wrecks || []) ctx.fillRect(cx(w.x) - 1.5, my + w.y * k - 1.5, 3, 3);
  },
  // tribute: a merchant may pay to be let go
  tributeChance(npc) { return clamp(.25 + fameOf(Campaign.s) / 120 - (npc.fleet.length > 1 ? .25 : 0), .1, .9); },
  tribute(npc) {
    let v = 0;
    for (const f of npc.fleet) { v += f.loot.gold * .3 + f.loot.cargo * GOODS[f.loot.good || 'grain'].base * .3; f.loot.gold = Math.round(f.loot.gold * .7); }
    return Math.round(v);
  },
};
