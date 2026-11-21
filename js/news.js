'use strict';
// Regional news: wars, famines, earthquakes, gold strikes, crazes... Each event sits on a port, reaches every port
// within its radius (weaker towards the edge), and for a while multiplies the prices of some goods there, so for a
// time it opens a trade route that pays far better than the usual ones. Events are kept in the save (s.events),
// a few begin on each game day, and the taverns carry the news.
// Campaign only: nothing here runs on the server.

// fx: price multipliers at the heart of the event. r: radius in px, len: days. w: how often it happens.
// {g} in a title is a good, for the events that pick one (goods: which ones it may pick, from: 'makes' or 'wants' of the port)
const NEWS_TYPES = {
  war: { icon: '⚔', w: 3, r: [1600, 3000], len: [30, 80], fx: { iron: 1.9, timber: 1.5, grain: 1.45, fish: 1.3, silk: .75, wine: .8 },
    title: 'War around {p}', lines: ['Press gangs sweep the waterfront for hands.', 'The armouries pay any price for iron and timber.', 'Bread is dear and the garrison is hungry.', 'A fleet of men-of-war lies at anchor, waiting for spars.', 'Nobody is buying silk while the guns talk.'] },
  famine: { icon: '🌾', w: 3, r: [900, 1800], len: [15, 40], fx: { grain: 2.3, fish: 1.8, sugar: 1.3, silk: .75, ivory: .8 },
    title: 'Famine near {p}', lines: ['The harvest failed and the granaries are empty.', 'Crowds gather at the bakers\' doors before dawn.', 'Salt fish is worth its weight in silver.', 'Bread riots broke out in the market square.', 'Fine goods go begging: folk want only food.'] },
  quake: { icon: '🏚', w: 2, r: [350, 700], len: [6, 14], fx: { timber: 2.2, iron: 1.6, cloth: 1.4, wine: .8 },
    title: 'Earthquake at {p}', lines: ['Half the quays are cracked and the warehouses down.', 'Builders call for timber and nails from every ship.', 'Tents of sailcloth stand where houses were.', 'Aftershocks still rattle the harbour.'] },
  fire: { icon: '🔥', w: 2, r: [250, 450], len: [4, 10], fx: { timber: 2.2, cloth: 1.7, grain: 1.3 },
    title: 'Great fire at {p}', lines: ['The cloth market burned to the ground.', 'Whole streets must be rebuilt in timber.', 'Smoke still hangs over the harbour.'] },
  goldstrike: { icon: '⛏', w: 2, r: [800, 1600], len: [20, 60], fx: { gold: .5, wine: 1.7, cloth: 1.5, iron: 1.5, grain: 1.4, tobacco: 1.4 },
    title: 'Gold found in the hills behind {p}', lines: ['Prospectors pour off every ship.', 'Gold dust buys anything, so the miners pay double for wine and tools.', 'Gold is cheap here: everyone has a pouch of it.', 'Shovels and pickaxes are worth more than the dust.'] },
  silverstrike: { icon: '⛏', w: 1, r: [800, 1500], len: [20, 50], fx: { silver: .5, wine: 1.6, cloth: 1.5, iron: 1.5, grain: 1.3 },
    title: 'A rich silver lode found near {p}', lines: ['Silver is coined by the cartload.', 'The mine owners want iron, cloth and wine.', 'Silver plate is cheap in every shop.'] },
  harvest: { icon: '🌻', w: 3, r: [900, 1800], len: [10, 25], fx: { grain: .5, wine: .7, wool: .8 },
    title: 'Bumper harvest around {p}', lines: ['The barns are bursting and grain is cheap.', 'The vintners can\'t find casks for all the wine.', 'Farmers sell at any price to clear their barns.'] },
  plague: { icon: '☠', w: 1, r: [800, 1500], len: [12, 30], fx: { spice: 2, wine: 1.4, cloth: .6, silk: .6, furs: .7 },
    title: 'Plague in {p}', lines: ['The physicians burn spices against the miasma.', 'The cloth markets are shut for fear of contagion.', 'Ships fly the yellow flag in the roads.', 'Wine is the only medicine anyone trusts.'] },
  feast: { icon: '👑', w: 2, r: [300, 600], len: [4, 9], fx: { wine: 2, silk: 1.9, sugar: 1.6, spice: 1.5 },
    title: 'A royal wedding at {p}', lines: ['The court orders silk for a thousand guests.', 'Wine flows in the fountains, so the vintners are cleaned out.', 'The confectioners want every loaf of sugar.'] },
  blockade: { icon: '⚓', w: 2, r: [600, 1200], len: [10, 30], fx: { cloth: 1.6, iron: 1.5, sugar: 1.5, grain: 1.4 },
    title: 'Blockade of {p}', lines: ['Enemy cruisers stop every ship in the offing.', 'Shelves stand empty: blockade runners name their price.', 'The merchants pay double for anything that gets through.'] },
  hurricane: { icon: '🌀', w: 2, r: [700, 1400], len: [5, 14], fx: { timber: 1.9, grain: 1.4, sugar: .8, fish: .7 },
    title: 'Hurricane strikes {p}', lines: ['Hulls lie on the beach and roofs in the street.', 'Shipwrights want every plank afloat.', 'The cane fields are flattened.'] },
  blight: { icon: '🥀', w: 3, r: [1000, 2200], len: [15, 40], goods: ['sugar', 'tobacco', 'coffee', 'tea', 'spice', 'wine', 'grain', 'wool'], from: 'makes', mul: 2.1,
    title: '{g} crop fails around {p}', lines: ['Blight has rotted the fields.', 'What little there is sells dear.', 'Planters stand idle in the taverns.', 'The brokers are buying it wherever ships can find it.'] },
  glut: { icon: '📦', w: 3, r: [600, 1200], len: [6, 15], from: 'wants', mul: .5,
    title: 'Glut of {g} at {p}', lines: ['A great convoy unloaded it all at once.', 'The warehouses are full to the rafters.', 'Merchants sell it off at a loss.'] },
  craze: { icon: '🎩', w: 2, r: [2500, 4500], len: [25, 60], goods: ['furs', 'silk', 'coffee', 'tea', 'tobacco', 'ivory', 'sugar', 'spice'], mul: 1.9,
    title: 'A craze for {g} sweeps the lands round {p}', lines: ['Every fine lady must have it.', 'Coffee-house wits talk of nothing else.', 'Prices climb each week.', 'The fashion has spread to the provinces.'] },
};
const NEWS_RATE = .45, NEWS_KEEP = 4; // new events per game day; days a finished event stays in the news

const News = {
  ensure(s) {
    if (s.events) return;
    s.events = []; s.newsId = 1; s.newsDay = Math.floor(s.day);
    for (let k = 0; k < 9; k++) { const e = this.make(s); e.start -= rand(.1, .6) * e.len; s.events.push(e); } // a world already busy
  },
  make(s) { // a new event at a port: about half of them in the waters round the player, so there's news nearby
    const near = PORTS.filter(p => dist(p, s) < 6000);
    const p = Math.random() < .5 && near.length ? pick(near) : pick(PORTS), pi = PORTS.indexOf(p);
    const types = Object.keys(NEWS_TYPES), tot = types.reduce((a, k) => a + NEWS_TYPES[k].w, 0);
    let x = Math.random() * tot, type = types[0];
    for (const k of types) { x -= NEWS_TYPES[k].w; if (x < 0) { type = k; break; } }
    const T = NEWS_TYPES[type], e = { id: s.newsId++, type, port: pi, start: s.day, len: Math.round(rand(...T.len)), r: Math.round(rand(...T.r)) };
    if (T.mul) {
      let goods = T.goods || TRADE_GOODS;
      if (T.from) { const own = goods.filter(g => p[T.from].includes(g)); goods = own.length ? own : (T.goods || p[T.from]); }
      e.good = pick(goods); e.fx = { [e.good]: T.mul };
    } else e.fx = T.fx;
    e.w = {}; // ports reached: full strength out to 40% of the radius, fading to 30% at its edge
    PORTS.forEach((q, i) => { const d = dist(q, p); if (d <= e.r) e.w[i] = +(d < e.r * .4 ? 1 : 1 - .7 * (d - e.r * .4) / (e.r * .6)).toFixed(2); });
    return e;
  },
  tick(s = Campaign.s) { // once per game day: start new events, drop old ones
    if (!s) return;
    this.ensure(s);
    while (s.newsDay < Math.floor(s.day)) {
      s.newsDay++;
      const n = (Math.random() < NEWS_RATE - .1 ? 1 : 0) + (Math.random() < .1 ? 1 : 0); // 0–2 a day, NEWS_RATE on average
      for (let k = 0; k < n; k++) s.events.push(this.make(s));
      s.events = s.events.filter(e => e.start + e.len + NEWS_KEEP > s.day);
    }
  },
  // how strongly an event is felt on a day: it builds over the first 15%, holds, and dies away over the last 30%,
  // swelling and easing a little from one day to the next
  strength(e, day) {
    const t = (day - e.start) / e.len;
    if (t < 0 || t >= 1) return 0;
    const k = t < .15 ? t / .15 : t > .7 ? (1 - t) / .3 : 1;
    return clamp(k * (1 + .15 * Math.sin(day * .9 + e.id * 2.7)), 0, 1.1);
  },
  mul(pi, g, day) { // the price multiplier the news puts on a good at a port
    const s = Campaign.s; if (!s || !s.events) return 1;
    let m = 1;
    for (const e of s.events) {
      const w = e.w[pi], f = e.fx[g]; if (!w || !f) continue;
      const k = this.strength(e, day); if (k) m *= 1 + (f - 1) * k * w;
    }
    return clamp(m, .3, 3);
  },
  why(pi, g, day = Campaign.s.day) { // icons of the events moving a good's price at a port
    const s = Campaign.s; if (!s || !s.events) return [];
    return s.events.filter(e => e.w[pi] && e.fx[g] && this.strength(e, day) > .05).map(e => ({ icon: NEWS_TYPES[e.type].icon, up: e.fx[g] > 1, name: this.title(e) }));
  },
  title(e) {
    const T = NEWS_TYPES[e.type], g = e.good ? goodName(e.good) : '';
    return T.title.replace('{p}', PORTS[e.port].name).replace('{g}', g).replace(/^./, c => c.toUpperCase());
  },
  phase(e, day) { // how the news reads today
    const t = (day - e.start) / e.len;
    return t >= 1 ? 'over' : t < .15 ? 'rumour' : t > .7 ? 'waning' : 'raging';
  },
  // the tavern's news: events nearest this port first. Close ones are told in detail; far-off ones are only talk
  tavernHtml(pi) {
    const s = Campaign.s; this.tick(s);
    const here = PORTS[pi], day = s.day, today = Math.floor(day);
    const list = s.events.filter(e => e.start <= day).map(e => ({ e, d: dist(PORTS[e.port], here) })).sort((a, b) => a.d - b.d).slice(0, 10);
    if (!list.length) return '<p class="hint">The taproom is quiet tonight: no news worth the telling.</p>';
    const tag = { rumour: 'rumour', raging: '', waning: 'easing', over: 'over' };
    const arrows = f => f >= 1.7 ? '▲▲' : f > 1 ? '▲' : f <= .6 ? '▼▼' : '▼';
    return list.map(({ e, d }) => {
      const T = NEWS_TYPES[e.type], ph = this.phase(e, day), far = d > 7000;
      const line = T.lines[(today + e.id) % T.lines.length];
      const fx = Object.keys(e.fx).sort((a, b) => Math.abs(e.fx[b] - 1) - Math.abs(e.fx[a] - 1))
        .map(g => `<span style="color:${e.fx[g] > 1 ? '#2e6b1e' : '#8b1a1a'}">${goodName(g)} ${arrows(e.fx[g])}</span>`).join(', ');
      const ports = Object.keys(e.w).map(Number).sort((a, b) => e.w[b] - e.w[a]).map(i => PORTS[i].name);
      const left = e.start + e.len - day;
      const when = ph === 'over' ? 'It is over now, and prices are settling back.' : ph === 'rumour' ? 'Only just begun, they say.' : left < 4 ? 'It can\'t last more than a few days.' : left < 15 ? 'It should be over within a fortnight.' : 'Nobody expects it to end soon.';
      const how = far ? `Sailors' talk from far away (${Math.round(d / 2200)} days' sail).` : `Felt in ${ports.slice(0, 6).join(', ')}${ports.length > 6 ? ` and ${ports.length - 6} more ports` : ''}.`;
      return `<div class="item news${ph === 'over' ? ' old' : ''}"><span>${T.icon} <b>${esc(this.title(e))}</b>${tag[ph] ? ` <i>(${tag[ph]})</i>` : ''}<br>
        <small>${far ? '' : line + ' '}${when} ${how}<br>${fx}</small></span></div>`;
    }).join('') + '<p class="hint">Prices swing hardest at the heart of an event, less towards its edges. ▲ dearer, ▼ cheaper.</p>';
  },
};
