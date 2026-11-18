'use strict';
// ---------- the known world ----------
// LANDS (lands.js) are drawn on an equirectangular projection: GEO.kx px per degree of longitude east of
// GEO.lon0, GEO.ky px per degree of latitude south of GEO.lat0.
const GEO = { lon0: -180, lat0: 78, kx: 58, ky: 62 };
const geo = (lon, lat) => [(lon - GEO.lon0) * GEO.kx, (GEO.lat0 - lat) * GEO.ky];
const WORLD = { W: 360 * GEO.kx, H: 138 * GEO.ky }; // the whole way round, 180°W–180°E, and 78°N–60°S (round Cape Horn)
WRAP_W = WORLD.W; // east and west meet at 180° (core.js: wrapDx, wrapX, dist)
const MAP_VER = 7; // saves from another map get their ships moved back to port on load (unless MAP_SHIFT says how to move them)
// maps with the same coasts in another place: map 2 (105°W–95°E, 66°N–50°S) sat further up and left; maps 3 (to 95°E) and
// 4 (to 150°E) only stopped short in the east. Map 5 had the same projection, a straight Northwest Passage and no Great Lakes,
// and stopped at 50°S (a ship left on what is now land is pushed off it at sea). Map 6 had the Black Sea, the Persian Gulf and
// the Gulf of California filled in, one narrow channel for the Great Lakes, and Toronto, Detroit and Sitka where Chicago, Kuwait
// and Anchorage are now (ships lying in those ports are moved to the new ones)
const MAP_SHIFT = { 2: [75 * GEO.kx, 12 * GEO.ky], 3: [0, 0], 4: [0, 0], 5: [0, 0], 6: [0, 0] };
// Saves refer to ports by index. PORT_VER counts the times ports were taken off the map; PORT_MOVES[v] says, for a save
// from before version v, where each old index now lies (by name): a removed port's ships, holdings and jobs go to a
// port near it, a moved one follows it. Version 2 took off Sydney, Adelaide, Hobart and Wellington (Dublin and New Orleans
// have their places, and Odesa and Mariupol moved up into Hobart's and Wellington's); Jamestown became New York in place.
const PORT_VER = 2;
const PORT_MOVES = { 2: { 57: 'Brisbane', 60: 'Melbourne', 63: 'Melbourne', 65: 'Auckland', 79: 'Odesa', 80: 'Mariupol' } };
const seaFill = n => Math.round(n * NAV.water / 56e6); // NPC numbers were tuned for about 28M px² of open sea; halved since
// ---------- coastlines ----------
// Each outline is projected and roughened: every edge is split again and again with its midpoint nudged
// sideways (by a hash of its position, so every load draws the same coast). The coasts are then rasterised
// into LAND.sd, a signed distance field (px to the nearest coast, negative on land) on a LAND.R px grid.
// Grounding, NPC steering, port placement and drawing all use it, so ships run aground on the coast you see.
const LAND = { R: 8, polys: [] };
const CONTINENTS = ['North America', 'South America', 'Eurasia', 'Africa', 'Australia'];
const coastName = (P, x) => { // what a sailor would call that shore
  if (P.name !== 'Eurasia') return P.name;
  const lon = wrapX(x) / GEO.kx + GEO.lon0;
  return lon < -100 || lon > 135 ? 'Siberia' : lon < 40 ? 'Europe' : lon < 64 ? 'Arabia' : lon < 92 ? 'India' : lon < 106 ? 'Siam' : lon < 124 ? 'China' : 'Korea';
};
for (const L of LANDS) {
  let pts = [];
  if (L.isle) { // a small island: a wobbly ring
    const [cx, cy] = geo(L.isle[0], L.isle[1]), r = L.isle[2];
    for (let i = 0; i < 9; i++) { const a = i / 9 * TAU, m = .75 + .5 * hash2(cx + i, cy - i); pts.push([cx + Math.cos(a) * r * m, cy + Math.sin(a) * r * m]); }
  } else for (let i = 0; i < L.pts.length; i += 2) pts.push(geo(L.pts[i], L.pts[i + 1]));
  const rough = (a, b, out) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy);
    if (l < 12) { out.push(b); return; }
    const k = (hash2(a[0] + b[0] * .37, a[1] - b[1] * .51) - .5) * .42, m = [(a[0] + b[0]) / 2 - dy * k, (a[1] + b[1]) / 2 + dx * k];
    rough(a, m, out); rough(m, b, out);
  };
  const out = [];
  for (let i = 0; i < pts.length; i++) rough(pts[i], pts[(i + 1) % pts.length], out);
  let area = 0; for (let i = 0; i < out.length; i++) { const a = out[i], b = out[(i + 1) % out.length]; area += a[0] * b[1] - b[0] * a[1]; }
  if (area < 0) out.reverse(); // all one way round, so overlapping lands fill as one
  const xs = out.map(p => p[0]), ys = out.map(p => p[1]);
  LAND.polys.push({ name: L.name, small: !CONTINENTS.includes(L.name), pts: out, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
}
// ---------- waters cut through the land (WATERS, lands.js) ----------
// Each centre line is smoothed (Catmull-Rom) into points ~24 px apart, and the banks are set out either side at half
// the width, wobbled by a hash of the position. The outline is a closed ring (mouth cap, one bank, head cap, the other
// bank) rasterised into LAND.cut and taken out of the land; LAND.banks are the stretches of it that run along land.
LAND.cuts = [];
for (const C of WATERS) {
  const c = []; for (let i = 0; i < C.pts.length; i += 2) c.push(geo(C.pts[i], C.pts[i + 1]));
  const P = k => c[clamp(k, 0, c.length - 1)], line = [], wid = [];
  const ws = C.ws || null; // a width for each point of the centre line
  for (let i = 0; i < c.length - 1; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2), n = Math.max(1, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 24));
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t, f = (a, b, c2, d) => .5 * (2 * b + (c2 - a) * t + (2 * a - 5 * b + 4 * c2 - d) * t2 + (3 * b - a - 3 * c2 + d) * t3);
      line.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
      if (ws) wid.push(ws[i] + (ws[i + 1] - ws[i]) * t);
    }
  }
  line.push(c[c.length - 1]); if (ws) wid.push(ws[ws.length - 1]);
  let len = 0; const at = line.map((p, i) => (len += i ? Math.hypot(p[0] - line[i - 1][0], p[1] - line[i - 1][1]) : 0));
  const [w0, w1] = Array.isArray(C.w) ? C.w : [C.w, C.w], half = i => ws ? wid[i] / 2 : (w0 + (w1 - w0) * at[i] / len) / 2;
  const wob = (x, y, s) => 1 + .14 * Math.sin(s / 110 + hash2(x * .01, y * .01) * 2) + .07 * (hash2(x * .3, y * .3) - .5);
  const L = [], Rt = [], N = line.length;
  for (let i = 0; i < N; i++) {
    const a = line[Math.max(0, i - 1)], b = line[Math.min(N - 1, i + 1)], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, nx = -(b[1] - a[1]) / l, ny = (b[0] - a[0]) / l;
    const [x, y] = line[i], hw = half(i);
    L.push({ x: x + nx * hw * wob(x, y, at[i]), y: y + ny * hw * wob(y, x, at[i]), nx, ny });
    Rt.push({ x: x - nx * hw * wob(y + 7, x, at[i] + 50), y: y - ny * hw * wob(x + 7, y, at[i] + 50), nx: -nx, ny: -ny });
  }
  const unloop = B => { // on the inside of a tight bend a bank folds back over itself: cut the loop out at the crossing
    const out = [];
    for (let i = 0; i < B.length; i++) {
      out.push(B[i]);
      for (let j = Math.min(B.length - 2, i + 40); j > i + 1; j--) {
        const a = B[i], b = B[i + 1], c = B[j], d = B[j + 1]; if (!b) break;
        const den = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x); if (!den) continue;
        const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / den, u = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / den;
        if (t > 0 && t < 1 && u > 0 && u < 1) { out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, nx: a.nx, ny: a.ny }); i = j; break; }
      }
    }
    return out;
  };
  const cap = (p, dx, dy, r) => { // a half round from one bank to the other, bulging along (dx, dy)
    const out = [], a0 = Math.atan2(dy, dx);
    for (let k = 1; k < 6; k++) { const a = a0 + Math.PI / 2 - k * Math.PI / 6; out.push({ x: p[0] + Math.cos(a) * r, y: p[1] + Math.sin(a) * r, nx: Math.cos(a), ny: Math.sin(a) }); }
    return out;
  };
  const d0 = [line[0][0] - line[1][0], line[0][1] - line[1][1]], d1 = [line[N - 1][0] - line[N - 2][0], line[N - 1][1] - line[N - 2][1]];
  const ring = [...unloop(L), ...cap(line[N - 1], ...d1, half(N - 1)), ...unloop(Rt).reverse(), ...cap(line[0], ...d0, half(0))];
  // the head cap runs from the left bank round to the right; the mouth cap from the right back to the left
  const xs = ring.map(p => p.x), ys = ring.map(p => p.y);
  LAND.cuts.push({ name: C.name, pad: C.pad || 16, ring, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
}
LAND.w = Math.ceil(WORLD.W / LAND.R); LAND.h = Math.ceil(WORLD.H / LAND.R);
(function buildLand() { // in a function, so the engine optimises these loops
  const { w, h, R } = LAND, mask = new Uint8Array(w * h), cut = new Uint8Array(w * h);
  const fill = (pts, into, nonzero, val) => { // scanline fill (with val): even-odd, or by winding number
    const rows = [], n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n], x1 = a[0], y1 = a[1], x2 = b[0], y2 = b[1];
      if (y1 === y2) continue;
      const j0 = Math.max(0, Math.ceil(Math.min(y1, y2) / R - .5)), j1 = Math.min(h - 1, Math.ceil(Math.max(y1, y2) / R - .5) - 1), dir = y2 > y1 ? 1 : -1;
      for (let j = j0; j <= j1; j++) { const y = (j + .5) * R; (rows[j] || (rows[j] = [])).push([x1 + (x2 - x1) * (y - y1) / (y2 - y1), dir]); }
    }
    for (let j = 0; j < rows.length; j++) {
      const xs = rows[j]; if (!xs) continue;
      xs.sort((a, b) => a[0] - b[0]);
      let wind = 0;
      for (let k = 0; k + 1 < xs.length; k++) {
        wind += nonzero ? xs[k][1] : 1;
        if (nonzero ? !wind : !(wind & 1)) continue;
        for (let i = Math.max(0, Math.ceil(xs[k][0] / R - .5)); i <= Math.min(w - 1, Math.ceil(xs[k + 1][0] / R - .5) - 1); i++) into[j * w + i] = val;
      }
    }
  };
  const copies = (pts, box, into, nonzero, val = 1) => { // the outline, and again a world away if it runs over the 180° line
    fill(pts, into, nonzero, val);
    if (box[0] < 0) fill(pts.map(([x, y]) => [x + WORLD.W, y]), into, nonzero, val);
    if (box[2] > WORLD.W) fill(pts.map(([x, y]) => [x - WORLD.W, y]), into, nonzero, val);
  };
  for (const P of LAND.polys) copies(P.pts, P.box, mask, false); // even-odd per land
  LAND.cuts.forEach((C, n) => copies(C.ring.map(p => [p.x, p.y]), C.box, cut, true, n + 1)); // LAND.cut holds which cut (1, 2, …)
  for (let k = 0; k < w * h; k++) if (cut[k]) mask[k] = 0;
  // exact Euclidean distance transform (Felzenszwalb & Huttenlocher), once to land and once to water
  const edtOf = (mask, w, target) => {
    const BIG = 1e12, d = new Float64Array(w * h), n = Math.max(w, h), f = new Float64Array(n), o = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
    for (let k = 0; k < w * h; k++) d[k] = mask[k] === target ? 0 : BIG;
    const pass = len => { // 1-D squared distance transform of f[0..len) into o
      let k = 0; v[0] = 0; z[0] = -1e20; z[1] = 1e20;
      for (let q = 1; q < len; q++) {
        let p = v[k], s = (f[q] + q * q - f[p] - p * p) / (2 * (q - p));
        while (s <= z[k]) { k--; p = v[k]; s = (f[q] + q * q - f[p] - p * p) / (2 * (q - p)); }
        k++; v[k] = q; z[k] = s; z[k + 1] = 1e20;
      }
      k = 0; for (let q = 0; q < len; q++) { while (z[k + 1] < q) k++; o[q] = (q - v[k]) ** 2 + f[v[k]]; }
    };
    for (let i = 0; i < w; i++) { for (let j = 0; j < h; j++) f[j] = d[j * w + i]; pass(h); for (let j = 0; j < h; j++) d[j * w + i] = o[j]; }
    for (let j = 0; j < h; j++) { const b = j * w; for (let i = 0; i < w; i++) f[i] = d[b + i]; pass(w); for (let i = 0; i < w; i++) d[b + i] = o[i]; }
    return d;
  };
  // the world wraps east–west: measure on a grid with PAD columns from the far side added at each end, then keep the middle
  const PAD = 128, real = mask, pw = w + 2 * PAD, padded = new Uint8Array(pw * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < pw; i++) padded[j * pw + i] = real[j * w + (i - PAD + w) % w];
  const toLand = edtOf(padded, pw, 1), toSea = edtOf(padded, pw, 0);
  const sd = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const k = j * w + i, q = j * pw + i + PAD;
    sd[k] = mask[k] ? -(Math.sqrt(toSea[q]) - .5) * R : (Math.sqrt(toLand[q]) - .5) * R;
  }
  LAND.mask = mask; LAND.sd = sd; LAND.cut = cut;
})();
const inCut = (x, y) => LAND.cut[clamp(Math.floor(y / LAND.R), 0, LAND.h - 1) * LAND.w + Math.floor(wrapX(x) / LAND.R) % LAND.w];
function landSd(x, y) { // px from (x,y) to the nearest coast, negative on land (bilinear between grid points; wraps east–west)
  const { w, h, R, sd } = LAND, gx = x / R - .5, fx = gx - Math.floor(gx / w) * w, fy = clamp(y / R - .5, 0, h - 1.001);
  const i = Math.floor(fx) % w, i1 = (i + 1) % w, j = Math.floor(fy), u = fx - Math.floor(fx), t = fy - j, a = j * w, b = a + w;
  return (sd[a + i] * (1 - u) + sd[a + i1] * u) * (1 - t) + (sd[b + i] * (1 - u) + sd[b + i1] * u) * t;
}
const onLand = (x, y, pad = 0) => landSd(x, y) < pad;
function landNormal(x, y) { // unit vector pointing away from the nearest land
  const e = LAND.R, gx = landSd(x + e, y) - landSd(x - e, y), gy = landSd(x, y + e) - landSd(x, y - e), l = Math.hypot(gx, gy) || 1;
  return [gx / l, gy / l];
}
function landAt(x, y) { // the land whose outline is nearest to (x,y) (by bounding box, then distance to its vertices)
  let best = null, bd = 1e18;
  for (const P of LAND.polys) {
    const [x0, y0, x1, y1] = P.box; if (y < y0 - 400 || y > y1 + 400) continue;
    for (const xx of [x, x - WORLD.W, x + WORLD.W]) { // an outline may run over the 180° line
      if (xx < x0 - 400 || xx > x1 + 400) continue;
      for (let i = 0; i < P.pts.length; i += 4) { const d = (P.pts[i][0] - xx) ** 2 + (P.pts[i][1] - y) ** 2; if (d < bd) { bd = d; best = P; } }
    }
  }
  return best;
}
// chunks of coast with their bounding boxes, so drawing only strokes the shore that is on screen. A long stretch of an
// outline that lies in a cut (Arabia's and Africa's, hidden under each other's land until the Red Sea was cut) is open
// water now, so it is left out of the stroke; the short ones across a river mouth stay, as shallows
LAND.chunks = [];
for (const P of LAND.polys) {
  const cutOf = P.pts.map(([x, y]) => inCut(x, y)), hid = cutOf.map(c => !!c), n = hid.length;
  const keep = k => !WATERS[cutOf[k] - 1].hide; // a cut marked hide (a strait cut through a filled-in coast) hides even a short stretch
  for (let i = 0; i < n;) { let j = i; while (j < n && hid[j]) j++; if (j - i < 60) for (let k = i; k < j; k++) hid[k] = !keep(k); i = j + 1; }
  P.path = typeof Path2D === 'function' ? new Path2D() : null;
  if (P.path) { P.pts.forEach(([x, y], i) => i ? P.path.lineTo(x, y) : P.path.moveTo(x, y)); P.path.closePath(); }
  for (let i = 0; i < P.pts.length; i += 64) {
    const seg = P.pts.slice(i, i + 65); if (i + 65 > P.pts.length) seg.push(P.pts[0]);
    const xs = seg.map(p => p[0]), ys = seg.map(p => p[1]), c = { box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], pts: seg };
    if (P.path) { c.path = new Path2D(); seg.forEach(([x, y], k) => k && !(hid[(i + k) % n] && hid[(i + k - 1) % n]) ? c.path.lineTo(x, y) : c.path.moveTo(x, y)); }
    LAND.chunks.push(c);
  }
}
// the banks of the cut waters: the stretches of each outline with land just behind them (not where the cut opens
// onto the sea or into another cut), in chunks like the coast's
LAND.banks = [];
for (const C of LAND.cuts) {
  if (typeof Path2D === 'function') { C.path = new Path2D(); C.ring.forEach((p, i) => i ? C.path.lineTo(p.x, p.y) : C.path.moveTo(p.x, p.y)); C.path.closePath(); }
  const n = C.ring.length, land = C.ring.map(p => landSd(p.x + p.nx * 14, p.y + p.ny * 14) < 0);
  let s0 = land.indexOf(false); if (s0 < 0) s0 = 0;
  let run = [];
  const flush = () => {
    for (let i = 0; i + 1 < run.length; i += 64) {
      const seg = run.slice(i, i + 65), xs = seg.map(p => p.x), ys = seg.map(p => p.y), b = { box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
      if (C.path) { b.path = new Path2D(); seg.forEach((p, k) => k ? b.path.lineTo(p.x, p.y) : b.path.moveTo(p.x, p.y)); }
      LAND.banks.push(b);
    }
    run = [];
  };
  for (let k = 0; k <= n; k++) { const i = (s0 + k) % n; if (land[i] && k < n) run.push(C.ring[i]); else flush(); }
}
// trees, scattered inland and bucketed by TREE_TILE px squares
const TREE_TILE = 512;
LAND.trees = new Map();
for (let y = 23; y < WORLD.H; y += 46) for (let x = 23; x < WORLD.W; x += 46) {
  const tx = x + (hash2(x, y) - .5) * 40, ty = y + (hash2(y, x) - .5) * 40;
  if (hash2(tx * .1, ty * .1) > .55 || landSd(tx, ty) > -34) continue;
  for (const x2 of [tx, tx < 2000 ? tx + WORLD.W : null, tx > WORLD.W - 2000 ? tx - WORLD.W : null]) { // and a world away, for the coasts over the 180° line
    if (x2 == null) continue;
    const key = Math.floor(x2 / TREE_TILE) + ',' + Math.floor(ty / TREE_TILE);
    (LAND.trees.get(key) || LAND.trees.set(key, []).get(key)).push([x2, ty]);
  }
}
// ---------- ports ----------
// Each port is given at a point on its coast (lon, lat) with ang, the bearing (radians, 0 = east, π/2 = south)
// out to sea. It is placed where a walk from inland along that bearing reaches the water; ships leave from
// (sx, sy), 100 px further out (or from near px, for a port on a river or lake: the middle of the channel).
// price scales the plunder price; makes are cheap there, wants dear.
const PORTS = [
  { name: 'Lisbon',         lon: -9.25, lat: 38.7,  ang: Math.PI,  price: 1.2, makes: ['wine', 'fish'],     wants: ['spice', 'gold'] },
  { name: 'London',         lon: 1.2,   lat: 52.4,  ang: 0,        price: 1.6, makes: ['cloth', 'iron'],    wants: ['tea', 'tobacco', 'furs'] },
  { name: 'Amsterdam',      lon: 4.7,   lat: 52.4,  ang: Math.PI,  price: 1.5, makes: ['cloth', 'fish'],    wants: ['spice', 'coffee', 'silk'] },
  { name: 'Cadiz',          lon: -6.4,  lat: 36.9,  ang: 2.2,      price: 1.3, makes: ['wine', 'wool'],     wants: ['silver', 'sugar'] },
  { name: 'Bergen',         lon: 5,     lat: 60.4,  ang: Math.PI,  price: 0.9, makes: ['fish', 'timber'],   wants: ['grain', 'wine'] },
  { name: 'Genoa',          lon: 8.9,   lat: 44.4,  ang: 1.57,     price: 1.4, makes: ['silk', 'cloth'],    wants: ['grain', 'wool', 'fish'] },
  { name: 'Smyrna',         lon: 27.1,  lat: 38.4,  ang: Math.PI,  price: 1.5, makes: ['silk', 'coffee'],   wants: ['iron', 'silver', 'ivory'] },
  { name: 'Alexandria',     lon: 30,    lat: 31.2,  ang: -1.57,    price: 1.1, makes: ['grain', 'spice'],   wants: ['timber', 'iron'] },
  { name: 'Algiers',        lon: 3.1,   lat: 36.2,  ang: -1.57,    price: 1.9, makes: ['wool', 'grain'],    wants: ['iron', 'wine'] },
  { name: 'Elmina',         lon: -1.3,  lat: 5,     ang: 1.57,     price: 0.8, makes: ['gold', 'ivory'],    wants: ['cloth', 'iron'] },
  { name: 'Cape Town',      lon: 18.3,  lat: -33.9, ang: Math.PI,  price: 1.0, makes: ['grain', 'wine'],    wants: ['timber', 'cloth'] },
  { name: 'Zanzibar',       lon: 39.4,  lat: -6.2,  ang: 0,        price: 0.9, makes: ['ivory', 'spice'],   wants: ['cloth', 'iron'] },
  { name: 'Aden',           lon: 45,    lat: 12.8,  ang: 1.57,     price: 1.2, makes: ['coffee'],           wants: ['cloth', 'silver'] },
  { name: 'Bombay',         lon: 72.8,  lat: 19,    ang: Math.PI,  price: 1.3, makes: ['cloth', 'spice'],   wants: ['silver', 'iron'] },
  { name: 'Calicut',        lon: 75.8,  lat: 11.2,  ang: Math.PI,  price: 1.0, makes: ['spice', 'timber'],  wants: ['gold', 'silver'] },
  { name: 'Calcutta',       lon: 88.3,  lat: 21.7,  ang: 1.57,     price: 1.5, makes: ['tea', 'silk'],      wants: ['silver', 'gold'] },
  { name: 'Havana',         lon: -82.4, lat: 22.9,  ang: -1.57,    price: 1.4, makes: ['sugar', 'tobacco'], wants: ['cloth', 'iron'] },
  { name: 'Port Royal',     lon: -76.8, lat: 17.6,  ang: 1.57,     price: 1.9, makes: ['sugar'],            wants: ['wine', 'iron'] },
  { name: 'Cartagena',      lon: -75.5, lat: 10.4,  ang: -2.2,     price: 1.2, makes: ['gold', 'tobacco'],  wants: ['cloth', 'wine'] },
  { name: 'Veracruz',       lon: -96.1, lat: 19.2,  ang: 0,        price: 1.1, makes: ['silver', 'sugar'],  wants: ['iron', 'wine'] },
  { name: 'Boston',         lon: -71.1, lat: 42.3,  ang: 0,        price: 1.0, makes: ['timber', 'furs'],   wants: ['sugar', 'cloth'] },
  { name: 'New York',       lon: -74.0, lat: 40.6,  ang: 1.2,      price: 1.2, makes: ['furs', 'grain'],    wants: ['sugar', 'cloth', 'tea'] }, // Jamestown's old place
  { name: 'Rio de Janeiro', lon: -43.2, lat: -23.1, ang: 1.57,     price: 1.0, makes: ['gold', 'sugar'],    wants: ['cloth', 'wine'] },
  { name: 'Buenos Aires',   lon: -58.6, lat: -34.6, ang: 0,        price: 0.8, makes: ['silver', 'wool'],   wants: ['timber', 'wine'] },
  // the Pacific, reached through the Panama Canal, the Northwest Passage or round Cape Horn (added after the rest: saves refer to ports by index)
  { name: 'Panama',         lon: -81.2, lat: 8.15,  ang: 1.57,     price: 1.2, makes: ['gold', 'silver'],   wants: ['cloth', 'wine'] },
  { name: 'Acapulco',       lon: -99.9, lat: 16.85, ang: 1.57,     price: 1.3, makes: ['silk', 'silver'],   wants: ['wine', 'iron'] },
  { name: 'Callao',         lon: -77.1, lat: -12.05, ang: Math.PI, price: 1.1, makes: ['silver', 'wool'],   wants: ['timber', 'cloth'] },
  { name: 'Valparaíso',     lon: -71.6, lat: -33,   ang: Math.PI,  price: 0.9, makes: ['grain', 'wine'],    wants: ['cloth', 'iron'] },
  { name: 'Anchorage',      lon: -149.9, lat: 61.2, ang: 2.5,      price: 1.0, makes: ['furs', 'fish'],     wants: ['grain', 'iron'], near: 30 },
  // the East Indies, Cathay and Japan
  { name: 'Malacca',        lon: 102.25, lat: 2.2,  ang: 2.36,     price: 1.3, makes: ['spice', 'silk'],    wants: ['cloth', 'silver'] },
  { name: 'Batavia',        lon: 107, lat: -6.05,   ang: -1.57,    price: 1.2, makes: ['coffee', 'spice'],  wants: ['cloth', 'iron'] },
  { name: 'Ambon',          lon: 128.2, lat: -3.4,  ang: 1.57,     price: 0.8, makes: ['spice'],            wants: ['cloth', 'grain', 'iron'] },
  { name: 'Manila',         lon: 120.5, lat: 14.6,  ang: Math.PI,  price: 1.4, makes: ['silk', 'sugar'],    wants: ['silver'] },
  { name: 'Macau',          lon: 113.5, lat: 22.1,  ang: 1.57,     price: 1.5, makes: ['tea', 'silk'],      wants: ['silver', 'furs'] },
  { name: 'Nagasaki',       lon: 129.75, lat: 32.75, ang: Math.PI, price: 1.6, makes: ['silver'],           wants: ['silk', 'cloth'] },
  // up the St Lawrence and on the Great Lakes (near: they lie on a channel, so ships leave from the middle of it)
  { name: 'Montreal',       lon: -73.6, lat: 45.5,  ang: 1.05,     price: 1.0, makes: ['furs', 'timber'],   wants: ['cloth', 'wine', 'iron'], near: 30 },
  { name: 'Chicago',        lon: -88.2, lat: 40.6, ang: -1.57,     price: 1.0, makes: ['grain', 'furs'],    wants: ['cloth', 'iron', 'tobacco'], near: 30 },
  // (Detroit stood here; its place in the list went to Kuwait, in the Persian Gulf)
  { name: 'Kuwait',         lon: 47.95, lat: 29.35, ang: 0.6,      price: 1.3, makes: ['wool', 'coffee'],   wants: ['timber', 'grain', 'iron'] },
  { name: 'Thunder Bay',    lon: -89.25, lat: 52.3, ang: 1.57,     price: 1.1, makes: ['furs', 'fish'],     wants: ['grain', 'iron', 'cloth'], near: 30 },
  // Cathay, Korea and Japan (Beijing up the Bohai and the Hai River)
  { name: 'Beijing',        lon: 116.4, lat: 39.9,  ang: 0.62,     price: 1.7, makes: ['silk', 'tea'],      wants: ['silver', 'furs'], near: 30 },
  { name: 'Shanghai',       lon: 121.5, lat: 31.2,  ang: 0,        price: 1.4, makes: ['silk', 'cloth'],    wants: ['silver', 'spice'] },
  { name: 'Seoul',          lon: 126.9, lat: 37.5,  ang: Math.PI,  price: 1.2, makes: ['grain', 'iron'],    wants: ['silver', 'spice'] },
  { name: 'Tokyo',          lon: 139.7, lat: 35.6,  ang: 1.57,     price: 1.6, makes: ['silk', 'timber'],   wants: ['sugar', 'spice'] },
  // at the head of the great rivers
  { name: 'St. Louis',      lon: -90.2, lat: 38.6,  ang: 1.16,     price: 1.0, makes: ['furs', 'grain'],    wants: ['cloth', 'iron'], near: 30 },
  { name: 'The Dalles',     lon: -121.18, lat: 45.6, ang: -3.07,   price: 0.9, makes: ['furs', 'fish'],     wants: ['iron', 'cloth'], near: 30 },
  { name: 'San Fernando',   lon: -67.47, lat: 7.89, ang: 0.34,     price: 0.9, makes: ['tobacco', 'timber'], wants: ['cloth', 'wine'], near: 30 },
  { name: 'Iquitos',        lon: -73.2, lat: -3.7,  ang: 0.08,     price: 0.9, makes: ['timber', 'spice'],  wants: ['iron', 'cloth'], near: 30 },
  { name: 'Asunción',       lon: -57.6, lat: -25.3, ang: 1.64,     price: 0.9, makes: ['tobacco', 'sugar'], wants: ['iron', 'cloth'], near: 30 },
  { name: 'Orléans',        lon: 1.9,   lat: 47.9,  ang: 2.72,     price: 1.3, makes: ['wine', 'grain'],    wants: ['sugar', 'spice'], near: 30 },
  { name: 'Strasbourg',     lon: 7.8,   lat: 48.5,  ang: -0.73,    price: 1.3, makes: ['wine', 'cloth'],    wants: ['spice', 'sugar'], near: 30 },
  { name: 'Magdeburg',      lon: 11.7,  lat: 52.1,  ang: -2.15,    price: 1.2, makes: ['grain', 'iron'],    wants: ['wine', 'spice'], near: 30 },
  { name: 'Aswan',          lon: 32.75, lat: 24.1,  ang: -1.79,    price: 1.1, makes: ['ivory', 'gold'],    wants: ['cloth', 'grain'], near: 30 },
  { name: 'Bussa',          lon: 4.52,  lat: 10.15, ang: 1.33,     price: 0.9, makes: ['ivory', 'grain'],   wants: ['cloth', 'iron'], near: 30 },
  { name: 'Mbandaka',       lon: 18.26, lat: 0.05,  ang: 2.18,     price: 0.8, makes: ['ivory', 'timber'],  wants: ['cloth', 'iron'], near: 30 },
  { name: 'Tete',           lon: 33.6,  lat: -16.15, ang: 0.54,    price: 0.9, makes: ['gold', 'ivory'],    wants: ['cloth', 'iron'], near: 30 },
  { name: 'Multan',         lon: 71.4,  lat: 30.2,  ang: 2.19,     price: 1.2, makes: ['cloth', 'grain'],   wants: ['silver', 'iron'], near: 30 },
  { name: 'Benares',        lon: 83,    lat: 25.3,  ang: -0.14,    price: 1.3, makes: ['silk', 'sugar'],    wants: ['silver', 'gold'], near: 30 },
  // Australia and New Zealand, with Dublin, New Orleans, Odesa and Mariupol in the places of the ports taken off the map
  { name: 'Dublin',         lon: -6.25, lat: 53.35, ang: 0,        price: 1.2, makes: ['wool', 'cloth'],    wants: ['tea', 'sugar', 'wine'] }, // in Sydney's old place
  { name: 'Melbourne',      lon: 144.9, lat: -37.9, ang: 1.57,     price: 1.2, makes: ['gold', 'wool'],     wants: ['cloth', 'wine', 'iron'] },
  { name: 'Brisbane',       lon: 153,   lat: -27.5, ang: 0,        price: 1.0, makes: ['sugar', 'timber'],  wants: ['cloth', 'iron'] },
  { name: 'New Orleans',    lon: -90.1, lat: 29.95, ang: 2.22,     price: 1.3, makes: ['sugar', 'tobacco'], wants: ['cloth', 'iron', 'wine'], near: 30 }, // up the Mississippi, in Adelaide's old place
  { name: 'Perth',          lon: 115.8, lat: -32,   ang: Math.PI,  price: 1.0, makes: ['wool', 'timber'],   wants: ['cloth', 'iron'] },
  { name: 'Darwin',         lon: 130.85, lat: -12.45, ang: -1.57,  price: 0.9, makes: ['fish', 'gold'],     wants: ['grain', 'cloth'] },
  { name: 'Odesa',          lon: 30.73, lat: 46.48, ang: 0.8,      price: 1.0, makes: ['grain', 'wool'],    wants: ['wine', 'cloth', 'sugar'] }, // moved up from the Black Sea ports into Hobart's old place
  { name: 'Auckland',       lon: 174.75, lat: -36.85, ang: -0.8,   price: 1.0, makes: ['timber', 'wool'],   wants: ['iron', 'cloth'] },
  { name: 'Mariupol',       lon: 37.55, lat: 47.1,  ang: 1.57,     price: 0.9, makes: ['iron', 'grain'],    wants: ['cloth', 'wine'], near: 30 }, // and Wellington's
  { name: 'Christchurch',   lon: 172.7, lat: -43.6, ang: 0,        price: 0.9, makes: ['wool', 'grain'],    wants: ['iron', 'tea'] },
  // the Mediterranean, the Levant and the Nile
  { name: 'Athens',         lon: 23.65, lat: 38.0, ang: 1.75,      price: 1.3, makes: ['wine', 'wool'],     wants: ['grain', 'iron'] },
  { name: 'Rome',           lon: 12.45, lat: 41.8,  ang: 2.4,      price: 1.5, makes: ['wine', 'cloth'],    wants: ['grain', 'spice', 'silver'] },
  { name: 'Beirut',         lon: 35.5,  lat: 33.9,  ang: 2.8,      price: 1.3, makes: ['silk', 'timber'],   wants: ['iron', 'cloth'] },
  { name: 'Cairo',          lon: 31.25, lat: 30.05, ang: Math.PI,  price: 1.3, makes: ['grain', 'cloth'],   wants: ['timber', 'iron'], near: 30 },
  // the Pacific coast of the Americas, and Hawaii
  { name: 'Honolulu',       lon: -157.5, lat: 21.2, ang: 1.57,     price: 1.0, makes: ['sugar', 'timber'],  wants: ['iron', 'cloth'] },
  { name: 'Vancouver',      lon: -121.9, lat: 49.3, ang: Math.PI,  price: 1.0, makes: ['timber', 'furs'],   wants: ['cloth', 'iron'], near: 30 },
  { name: 'Los Angeles',    lon: -118.25, lat: 33.8, ang: 2.2,     price: 1.0, makes: ['wine', 'wool'],     wants: ['cloth', 'iron'] },
  { name: 'San Francisco',  lon: -122.4, lat: 37.8, ang: Math.PI,  price: 1.3, makes: ['gold', 'grain'],    wants: ['cloth', 'iron', 'wine'] },
  { name: 'Puerto Vallarta', lon: -105.3, lat: 20.65, ang: Math.PI, price: 1.0, makes: ['silver', 'tobacco'], wants: ['cloth', 'wine'] },
  // the Persian Gulf (Kuwait is up with the Great Lakes ports, in Detroit's old place)
  { name: 'Dubai',          lon: 55.3,  lat: 25.27, ang: -2.36,    price: 1.2, makes: ['cloth', 'spice'],   wants: ['timber', 'grain'] },
  // the Black Sea
  { name: 'Istanbul',       lon: 28.6,  lat: 41.65, ang: 1.9,      price: 1.7, makes: ['silk', 'coffee'],   wants: ['grain', 'furs', 'iron'], near: 30 },
  { name: 'Sevastopol',     lon: 33.52, lat: 44.6,  ang: Math.PI,  price: 1.0, makes: ['fish', 'wine'],     wants: ['iron', 'timber'] },
  // (Odesa and Mariupol are up with the Australian ports, in Hobart's and Wellington's old places)
];
for (const p of PORTS) { // find the shore along the bearing, then the first open water a little way out
  const [cx, cy] = geo(p.lon, p.lat), dx = Math.cos(p.ang), dy = Math.sin(p.ang), at = r => onLand(cx + dx * r, cy + dy * r, 4);
  let r = 0;
  if (at(0)) while (r < 300 && at(r)) r += 4;
  else { while (r > -300 && !at(r)) r -= 4; r += 4; }
  let o = 70, best = -1e9; // the most open water 70–170 px out, stopping early once it is clear of every coast
  for (let k = p.near || 70; k <= 170 && best < 95; k += 10) { const d = landSd(cx + dx * (r + k), cy + dy * (r + k)); if (d > best) { best = d; o = k; } }
  p.x = cx + dx * r; p.y = cy + dy * r; p.sx = cx + dx * (r + o); p.sy = cy + dy * (r + o);
}
// plunder price at a port: its base rate swings with the days, each port on its own cycle
function plunderPrice(port, day = Campaign.s.day) {
  const ph = PORTS.indexOf(port) * 2.1;
  const f = 1 + .4 * Math.sin(day * .45 + ph) + .2 * Math.sin(day * 1.3 + ph * 1.7);
  return Math.max(5, Math.round(22 * port.price * f));
}
// ---------- trade goods ----------
// 'plunder' is the mixed booty of old saves (pirates now carry real goods): it can't be bought, and sells at plunderPrice(). The rest are bought where a
// port makes them (cheap) and sold where a port wants them (dear), on prices that drift over the days.
// Each region makes what it historically traded: Caribbean sugar and tobacco, Spanish American silver and gold,
// Guinea gold and ivory, Indian spices, cloth and tea, Levant silk and coffee, northern fish and timber.
const GOODS = {
  grain:   { name: 'Grain',     base: 10 },
  fish:    { name: 'Salt fish', base: 12 },
  timber:  { name: 'Timber',    base: 16 },
  wool:    { name: 'Wool',      base: 20 },
  sugar:   { name: 'Sugar',     base: 24 },
  wine:    { name: 'Wine',      base: 28 },
  tobacco: { name: 'Tobacco',   base: 30 },
  iron:    { name: 'Iron',      base: 32 },
  furs:    { name: 'Furs',      base: 36 },
  cloth:   { name: 'Cloth',     base: 38 },
  coffee:  { name: 'Coffee',    base: 42 },
  tea:     { name: 'Tea',       base: 46 },
  spice:   { name: 'Spices',    base: 50 },
  ivory:   { name: 'Ivory',     base: 56 },
  silk:    { name: 'Silk',      base: 62 },
  silver:  { name: 'Silver',    base: 72 },
  gold:    { name: 'Gold',      base: 90 },
  plunder: { name: 'Plunder',   base: 22 },
  contraband: { name: 'Contraband', base: 0, hidden: true }, // smuggling jobs only: no market buys or sells it
};
const TRADE_GOODS = Object.keys(GOODS).filter(k => k !== 'plunder' && !GOODS[k].hidden);
const goodName = g => GOODS[g || 'plunder'].name;
function goodPrice(port, g, day = Campaign.s.day) { // what the port pays you for a crate
  if (g === 'plunder') return plunderPrice(port, day);
  const ph = PORTS.indexOf(port) * 1.7 + TRADE_GOODS.indexOf(g) * 2.3;
  const f = (port.makes.includes(g) ? .7 : port.wants.includes(g) ? 1.45 : 1) * (1 + .2 * Math.sin(day * .4 + ph) + .08 * Math.sin(day * 1.1 + ph * 1.3));
  return Math.max(2, Math.round(GOODS[g].base * f * (isMerchant() ? 1.05 : 1))); // guild members get a better price
}
const buyPrice = (port, g, day) => Math.ceil(goodPrice(port, g, day) * (isMerchant() ? 1.04 : 1.12)); // the merchants' cut, smaller for guild members
const holdUsed = s => Object.values(s.hold).reduce((a, n) => a + n, 0);
function stow(s, g, n) { // returns how many crates fit
  const k = Math.max(0, Math.min(n, holdCap(s) - holdUsed(s)));
  if (k) s.hold[g] = (s.hold[g] || 0) + k;
  return k;
}
function trimHold(s, cap) { // over the side with the cheapest goods first until the hold fits
  const worth = g => GOODS[g].hidden ? 1e9 : GOODS[g].base; // job cargo goes last
  for (const g of Object.keys(GOODS).sort((a, b) => worth(a) - worth(b))) {
    const over = holdUsed(s) - cap; if (over <= 0) break;
    const k = Math.min(over, s.hold[g] || 0); if (k) s.hold[g] -= k;
    if (!s.hold[g]) delete s.hold[g];
  }
}
function pushOffLand(o, pad) { // returns true if o was within pad of the coast (and moves it out)
  const d = landSd(o.x, o.y); if (d >= pad) return false;
  const [nx, ny] = landNormal(o.x, o.y); o.x += nx * (pad - d); o.y += ny * (pad - d);
  return true;
}
// ---------- navigation: A* over a grid of open water ----------
// The sea is cut into NAV.cell-sized squares; a square is blocked if it lies within NAV.pad of any coast (the cut's
// pad in a river, canal or strait from WATERS) or by the edge of the world. findPath() runs A* between two points and pulls the result tight into a few straight
// legs; clearLine() says whether a ship could sail straight from one point to another without touching blocked water.
const NAV = { cell: 48, pad: 40 }; // the cell divides WORLD.W, so the grid wraps east–west too
NAV.w = Math.ceil(WORLD.W / NAV.cell); NAV.h = Math.ceil(WORLD.H / NAV.cell);
NAV.block = new Uint8Array(NAV.w * NAV.h);
for (let j = 0; j < NAV.h; j++) for (let i = 0; i < NAV.w; i++) {
  const x = (i + .5) * NAV.cell, y = (j + .5) * NAV.cell;
  const cut = LAND.cuts[inCut(x, y) - 1]; // closer to the banks in a cut
  NAV.block[j * NAV.w + i] = y < 60 || y > WORLD.H - 60 || onLand(x, y, cut ? cut.pad : NAV.pad) ? 1 : 0;
}
{ // flood the sea from the first port; open water it never reaches (a lake, a river too narrow to sail) is closed off
  const seen = new Uint8Array(NAV.w * NAV.h), k0 = Math.floor(PORTS[0].sy / NAV.cell) * NAV.w + Math.floor(PORTS[0].sx / NAV.cell), q = [k0];
  seen[k0] = 1;
  while (q.length) {
    const k = q.pop(), i = k % NAV.w, j = Math.floor(k / NAV.w);
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = (i + di + NAV.w) % NAV.w, nj = j + dj, m = nj * NAV.w + ni;
      if (nj >= 0 && nj < NAV.h && !seen[m] && !NAV.block[m]) { seen[m] = 1; q.push(m); }
    }
  }
  NAV.water = 0;
  for (let k = 0; k < NAV.w * NAV.h; k++) if (!seen[k]) NAV.block[k] = 1; else NAV.water += NAV.cell * NAV.cell;
}
const seaOK = (x, y) => !NAV.block[navIdx(x, y)]; // open sea that ships can reach
NAV.g = new Float32Array(NAV.w * NAV.h); NAV.from = new Int32Array(NAV.w * NAV.h);
NAV.seen = new Uint32Array(NAV.w * NAV.h); NAV.shut = new Uint32Array(NAV.w * NAV.h); NAV.stamp = 0;
const navIdx = (x, y) => clamp(Math.floor(y / NAV.cell), 0, NAV.h - 1) * NAV.w + Math.floor(wrapX(x) / NAV.cell) % NAV.w;
const navPt = k => ({ x: (k % NAV.w + .5) * NAV.cell, y: (Math.floor(k / NAV.w) + .5) * NAV.cell });
function clearLine(ax, ay, bx, by) {
  bx = ax + wrapDx(bx - ax); // the short way round
  const n = Math.ceil(Math.hypot(bx - ax, by - ay) / (NAV.cell * .4));
  for (let i = 1; i <= n; i++) if (NAV.block[navIdx(ax + (bx - ax) * i / n, ay + (by - ay) * i / n)]) return false;
  return true;
}
function nearestFree(k) { // the closest open-water square, searching outward ring by ring
  if (!NAV.block[k]) return k;
  const ci = k % NAV.w, cj = Math.floor(k / NAV.w);
  for (let r = 1; r < 12; r++) {
    let best = -1, bd = 1e9;
    for (let j = cj - r; j <= cj + r; j++) for (let i = ci - r; i <= ci + r; i++) {
      if (j < 0 || j >= NAV.h || (Math.abs(i - ci) !== r && Math.abs(j - cj) !== r)) continue;
      const q = j * NAV.w + (i + NAV.w) % NAV.w, d = (i - ci) ** 2 + (j - cj) ** 2;
      if (!NAV.block[q] && d < bd) { bd = d; best = q; }
    }
    if (best >= 0) return best;
  }
  return k;
}
// Waypoints from (ax,ay) towards (bx,by), not including the start; null if there is no way through. The grid wraps
// east–west, and the waypoints run on from ax without a jump, whichever way round the world they go.
function findPath(ax, ay, bx, by) {
  bx = ax + wrapDx(bx - ax);
  const W = NAV.w, s = nearestFree(navIdx(ax, ay)), goal = nearestFree(navIdx(bx, by)), gi = goal % W, gj = Math.floor(goal / W);
  const st = ++NAV.stamp, g = NAV.g, from = NAV.from, seen = NAV.seen, shut = NAV.shut, heap = [];
  const h = k => { const dx = Math.min(Math.abs(k % W - gi), W - Math.abs(k % W - gi)), dy = Math.abs(Math.floor(k / W) - gj); return Math.max(dx, dy) + .414 * Math.min(dx, dy); };
  const push = (f, k) => { heap.push([f, k]); let i = heap.length - 1; while (i) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  g[s] = 0; from[s] = -1; seen[s] = st; push(h(s), s);
  let found = false, n = 0;
  while (heap.length && n++ < 100000) {
    const [, k] = pop();
    if (shut[k] === st) continue; shut[k] = st;
    if (k === goal) { found = true; break; }
    const i = k % W, j = Math.floor(k / W);
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const ni = (i + di + W) % W, nj = j + dj; if (nj < 0 || nj >= NAV.h) continue;
      const q = nj * W + ni; if (NAV.block[q] || shut[q] === st) continue;
      if (di && dj && (NAV.block[j * W + ni] || NAV.block[nj * W + i])) continue; // don't cut corners past land
      const ng = g[k] + (di && dj ? 1.414 : 1);
      if (seen[q] !== st || ng < g[q]) { seen[q] = st; g[q] = ng; from[q] = k; push(ng + h(q), q); }
    }
  }
  if (!found) return null;
  const cells = []; for (let k = goal; k !== -1; k = from[k]) cells.push(navPt(k));
  cells.reverse(); cells.push({ x: bx, y: by });
  for (let i = 0, px = ax; i < cells.length; i++) { cells[i].x = px + wrapDx(cells[i].x - px); px = cells[i].x; } // unbroken across 180°
  const out = []; let at = { x: ax, y: ay }, i = 0; // pull the path tight: from each corner, head for the furthest point in sight
  while (i < cells.length - 1) {
    let j = cells.length - 1;
    while (j > i + 1 && !clearLine(at.x, at.y, cells[j].x, cells[j].y)) j--;
    out.push(cells[j]); at = cells[j]; i = j;
  }
  return out;
}
// Steering for a ship that wants to reach (tx,ty): returns the point to head for right now. Keeps a route in
// nav = { path, goal, t } and re-plans only when the goal moves or the way ahead is blocked, within a per-frame budget.
function navSteer(nav, x, y, tx, ty, dt) {
  nav.t = (nav.t || 0) - dt; tx = x + wrapDx(tx - x); // all relative to the ship, the short way round
  if (clearLine(x, y, tx, ty)) { nav.path = null; return { x: tx, y: ty }; } // open water: straight there
  const moved = !nav.goal || dist(nav.goal, { x: tx, y: ty }) > 150;
  if ((!nav.path || moved) && nav.t <= 0 && NAV.budget > 0) {
    NAV.budget--; nav.t = 1 + Math.random(); nav.goal = { x: tx, y: ty };
    nav.path = findPath(x, y, tx, ty);
  }
  const P = nav.path;
  if (!P || !P.length) return { x: tx, y: ty };
  if (P.length > 1 && clearLine(x, y, P[1].x, P[1].y)) P.shift(); // a shortcut has opened up
  if (P.length > 1 && dist(P[0], { x, y }) < 70) P.shift();
  return { x: x + wrapDx(P[0].x - x), y: P[0].y };
}
NAV.budget = 0;
const FAME_GOAL = 100;
// ---------- sailing distance between ports (along the sea lanes, not as the crow flies), cached ----------
const PORT_DIST = new Map();
function portDist(a, b) {
  const key = Math.min(a, b) * 1000 + Math.max(a, b);
  if (!PORT_DIST.has(key)) {
    const A = PORTS[a], B = PORTS[b], path = a === b ? [] : findPath(A.sx, A.sy, B.sx, B.sy);
    let d = 0, at = { x: A.sx, y: A.sy };
    if (path) for (const p of path) { d += dist(at, p); at = p; } else d = dist(A, B) * 1.5;
    PORT_DIST.set(key, d);
  }
  return PORT_DIST.get(key);
}
// ---------- careers: a pirate preys on shipping; a merchant trades, and pirates prey on him ----------
const GUILD_GOAL = 100; // a merchant's standing needed for a seat on the Merchant Guild
const GUILD_GOLD = 60; // a merchant earns 1 standing per this much gold of honest goods sold
const isMerchant = () => !!Campaign.s && Campaign.s.career === 'merchant';
// Fame is what your deeds have earned (s.fame) plus what your wealth says about you: a point for every
// WEALTH_PER_FAME gold of gold aboard, in banks, in purses and consignments, and of ships you own.
const WEALTH_PER_FAME = 250;
function worth(s) {
  const P = Object.values(s.props || {}), own = (s.fleet || []).filter(f => !f.hired), shipVal = f => SHIP_CLASSES[f.cls] ? SHIP_CLASSES[f.cls].cost : 0;
  return s.gold + P.reduce((a, p) => a + (p.bank ? p.bank.gold : 0) + (p.dock || []).reduce((b, f) => b + shipVal(f) + (f.gold || 0), 0), 0)
    + Object.values(s.consign || {}).reduce((a, c) => a + c.gold, 0)
    + (s.fleet || []).reduce((a, f) => a + (f.gold || 0), 0) + shipVal(s.ship) + own.reduce((a, f) => a + shipVal(f), 0);
}
const wealthFame = s => Math.floor(worth(s) / WEALTH_PER_FAME);
const fameOf = s => (s.fame || 0) + wealthFame(s);
const renown = () => Math.max(fameOf(Campaign.s), Campaign.s.trade || 0); // how dangerous the sea gets around you
const pardonCost = s => 200 + s.fame * 8;
function addStanding(s, n) { // merchants only; fractions carry over
  if (s.career !== 'merchant') return 0;
  s.tradeX = (s.tradeX || 0) + n; const k = Math.floor(s.tradeX); s.tradeX -= k; s.trade += k; return k;
}

// ---------- your fleet: ships bought at a shipyard that sail and fight beside your flagship ----------
// s.fleet = [{ cls, name, hull, sailHp, crew, ammo: { chain, grape } }]. They are bought at full price, and only
// in a SHIPYARD_PORTS yard, but any port will mend, man and arm them (at a price).
const SHIPYARD_PORTS = ['Amsterdam', 'Havana', 'Bombay', 'Batavia'];
const FLEET_MAX = 3, FLEET_MIN_CREW = .25, HAND_COST = 6, SHOT_COST = 30, SHOT_MAX = 20;
const isShipyard = port => SHIPYARD_PORTS.includes(port.name);
const fleetMinCrew = f => Math.ceil(SHIP_CLASSES[f.cls].crew * FLEET_MIN_CREW);
const fleetReady = f => f.crew >= fleetMinCrew(f); // too few hands and she stays out of the fight
const fleetRepairCost = f => Math.ceil((SHIP_CLASSES[f.cls].hull - f.hull) * 2 + (100 - f.sailHp));
const fleetSalePrice = f => Math.round(SHIP_CLASSES[f.cls].cost * .4 * (.5 + .5 * f.hull / SHIP_CLASSES[f.cls].hull));
function newFleetShip(s, cls) { // straight off the slipway: sound, but no crew and no special shot aboard
  const used = [s.ship.name, ...s.fleet.map(f => f.name), ...Object.values(s.props || {}).flatMap(p => (p.dock || []).map(f => f.name))], free = SHIP_NAMES.ally.filter(n => !used.includes(n));
  return { cls, name: free.length ? pick(free) : `${SHIP_CLASSES[cls].name} ${s.fleet.length + 2}`, hull: SHIP_CLASSES[cls].hull, sailHp: 100, crew: 0, ammo: { chain: 0, grape: 0 } };
}
function ensureFleet(s) { // saves from before fleets had hired escorts: they come across fully manned
  if (!s.fleet) s.fleet = (s.escorts || []).map(e => ({ cls: e.cls, name: e.name, hull: e.hull, sailHp: 100, crew: SHIP_CLASSES[e.cls].crew, ammo: { chain: 0, grape: 0 } }));
  delete s.escorts;
}
// ---------- squadrons: fleet ships detached to sail on your orders ----------
// f.task is unset while she sails in your wing. Otherwise she is out on her own as an overworld NPC of kind
// 'own' (WorldMap.syncOwn), and her position is kept in f.x/f.y/f.heading so it is saved:
//   { type: 'station', port }                  sail to PORTS[port] and wait there for orders
//   { type: 'route', stops, leg, profit, trips } carry goods round the ports in stops; leg is the stop she's bound for
//   { type: 'recall' }                         sail back and fall in astern of you
// f.at is the port she lies in, else null; f.lie is how long (s) she still works cargo there.
// f.cargo = { good: crates } and f.cargoCost (what was paid for it) belong to route ships.
// f.gold is her purse: gold is never pooled, it is wherever it lies (aboard your flagship as s.gold, in a counting
// house, or in a ship's purse). A route ship trades out of her purse, and at a stop where you own a counting house
// she banks what she holds above her working purse T.float, or draws on it when she is short. A ship in your wing
// hands her purse over to you (takePurse).
const ROUTE_MAX = 4, ROUTE_LIE = 6;
const FACTOR_CUT = .3, WAGE_PER_STOP = 1, FACTOR_STANDING = .15; // share of a sale's margin, gold per hand per sale, guild standing vs. your own trade
const inWing = f => !f.task;
const wingFleet = s => s.fleet.filter(inWing);
const fleetHere = (f, pi) => inWing(f) || f.at === pi; // in this port with you, so the yard can work on her
const cargoOf = f => Object.values(f.cargo || {}).reduce((a, n) => a + n, 0);
const worthTaking = f => cargoOf(f) > 0 || (f.gold || 0) > 0; // a squadron ship pirates will go after
function routeGood(from, to) { // the most profitable good to carry from one port to another, or null if nothing pays
  let best = null;
  for (const g of TRADE_GOODS) { const m = goodPrice(to, g) - buyPrice(from, g); if (m > 0 && (!best || m > best.margin)) best = { g, margin: m }; }
  return best;
}
function sellCargo(f, port) { // returns a line of plain text news, or '' if her hold was empty
  const s = Campaign.s; let n = 0, revenue = 0, what = [];
  for (const g in f.cargo || {}) {
    const k = f.cargo[g], v = k * goodPrice(port, g); n += k; revenue += v; what.push(`${k} ${goodName(g).toLowerCase()}`);
    if (!GOODS[g].hidden) addStanding(s, v / GUILD_GOLD * FACTOR_STANDING);
  }
  if (!n) return '';
  const gross = revenue - (f.cargoCost || 0), cut = Math.max(0, Math.round(gross * FACTOR_CUT)) + f.crew * WAGE_PER_STOP; // her factor and crew are paid out of the takings
  const profit = gross - cut;
  f.gold = Math.max(0, (f.gold || 0) + revenue - cut); f.cargo = {}; f.cargoCost = 0;
  if (f.task && f.task.type === 'route') f.task.profit += profit;
  return `The ${f.name} sold ${what.join(', ')} at ${port.name} for ${revenue}g: ${profit >= 0 ? '+' : ''}${profit}g after her factor and crew take ${cut}g`;
}
function takePurse(s, f) { // she is with you: her purse comes aboard your flagship. Returns how much.
  const g = f.gold || 0; s.gold += g; f.gold = 0; return g;
}
function routeTrade(f, pi) { // a route ship in port: sell what is aboard, settle with your counting house, then load for the next stop
  const s = Campaign.s, T = f.task, port = PORTS[pi], cap = SHIP_CLASSES[f.cls].cargo, bank = propsOf(s, pi).bank;
  const lines = [sellCargo(f, port)].filter(Boolean);
  const next = PORTS[T.stops[(T.leg + 1) % T.stops.length]], best = routeGood(port, next);
  f.gold = f.gold || 0;
  if (bank) { // bank the takings above her working purse, or draw on the house to make it up
    bankSettle(s, pi); const fl = T.float || 0;
    if (f.gold > fl) { const k = f.gold - fl; bank.gold += k; f.gold = fl; lines.push(`The ${f.name} banks ${k}g in your counting house at ${port.name}`); }
    else if (f.gold < fl && bank.gold > 0) { const k = Math.min(fl - f.gold, bank.gold); bank.gold -= k; f.gold += k; lines.push(`The ${f.name} draws ${k}g from your counting house at ${port.name}`); }
  }
  if (best) {
    const pr = buyPrice(port, best.g), k = Math.min(cap, Math.floor(f.gold / pr));
    if (k) { f.cargo = { [best.g]: k }; f.cargoCost = k * pr; f.gold -= k * pr; lines.push(`The ${f.name} loads ${k} ${goodName(best.g).toLowerCase()} at ${port.name} for ${next.name} (${k * pr}g)`); }
    else lines.push(`The ${f.name} has too little gold in her purse to buy cargo at ${port.name}, and sails for ${next.name} in ballast`);
  } else lines.push(`Nothing at ${port.name} pays to carry to ${next.name} today: the ${f.name} sails in ballast`);
  return lines;
}
function taskText(f) {
  const T = f.task; if (!T) return f.hired ? `hired escort · ${Math.max(0, Math.ceil(f.hired.until - Campaign.s.day))} days left` : 'sailing with you';
  if (T.type === 'recall') return 'coming to join you';
  if (T.type === 'freight') return `chartered freighter bound for ${PORTS[T.to].name} with ${freightText(f)}`;
  if (T.type === 'station') return f.at != null ? `waiting at ${PORTS[f.at].name}` : `bound for ${PORTS[T.port].name}`;
  const k = cargoOf(f), g = k && Object.keys(f.cargo)[0];
  return `trade route ${T.stops.map(i => PORTS[i].name).join(' → ')} · ${f.at != null ? 'in ' + PORTS[f.at].name : 'bound for ' + PORTS[T.stops[T.leg]].name}${k ? ` with ${k} ${goodName(g).toLowerCase()}` : ''} · profit ${T.profit}g · purse ${f.gold || 0}g`;
}

// ---------- ships for hire ----------
// A hired ship is kept in s.fleet with f.hired = { kind, rate, until? } but isn't yours: she doesn't count against
// fleetMax, can't be sold, laid up, given orders or commanded in battle, and isn't counted in your worth.
//   escort:  a manned, gunned ship that sails in your wing and fights beside you until day `until`; her owners mend her in port
//   freight: a chartered hull that carries goods and gold from one port to another on her own (task { type: 'freight', to, from }).
//            On arrival the gold goes to your counting house there and the goods to your warehouse (as room allows);
//            whatever has no home ashore waits with the harbourmaster (s.consign[pi] = { gold, goods }) until you dock there.
const HIRE_MAX = 2, FREIGHT_MAX = 3, HIRE_DAYS = [5, 10], FREIGHT_INSURE = .03;
const HIRE_NAMES = ['Free Lance', 'Hired Blade', 'Fair Wage', 'True Coin', 'Gold Hawk', 'Condottiere', 'Ready Hand', 'Sellsword', 'Bonny Jenny', 'Honest Pike'];
const hireRate = cls => Math.round(SHIP_CLASSES[cls].cost * .02); // gold a day for an escort
const ownFleet = s => s.fleet.filter(f => !f.hired);
const ownWing = s => wingFleet(s).filter(f => !f.hired);
// Ships of your own sailing in your wing carry cargo: their holds add to the flagship's, and s.hold is the cargo of
// the whole wing. A ship can't leave the wing (station, route, sale, lay-up) while the rest couldn't carry it all;
// one lost in battle takes her share down with her (settleFleet). A ship rejoining brings her f.cargo aboard.
const holdCap = s => SHIP_CLASSES[s.ship.cls].cargo + ownWing(s).reduce((a, f) => a + SHIP_CLASSES[f.cls].cargo, 0);
function holdBlock(s, f) { // '' if the cargo still fits in the wing without her, else why she can't go
  const over = holdUsed(s) - holdCap(s) + (inWing(f) && !f.hired ? SHIP_CLASSES[f.cls].cargo : 0);
  return over > 0 ? `The ${esc(f.name)} is carrying ${over} crates of your cargo: sell or store them before she leaves you.` : '';
}
function boardCargo(s, f) { // she has rejoined your wing: her cargo goes into the wing's hold as room allows
  for (const g of Object.keys(f.cargo || {})) { f.cargo[g] -= stow(s, g, f.cargo[g]); if (!f.cargo[g]) delete f.cargo[g]; }
  if (!cargoOf(f)) f.cargoCost = 0;
}
const hiredOf = (s, kind) => s.fleet.filter(f => f.hired && f.hired.kind === kind);
function hireOffers(s, pi) { // what the harbour has for hire, changing every three days: { escorts: [{ cls, name }], freight: cls or null }
  const bucket = Math.floor(s.day / 3), o = s.hires[pi];
  if (o && o.day === bucket) return o;
  const tier = Math.min(3, renown() / 35), used = s.fleet.map(f => f.name), names = HIRE_NAMES.filter(n => !used.includes(n)), escorts = [];
  for (let i = randInt(1, 3); i > 0; i--) {
    const r = tier + rand(-1, 1.2), cls = r < .6 ? 'cog' : r < 1.7 ? 'caravel' : r < 2.8 ? 'carrack' : 'galleon';
    const name = names.length ? names.splice(randInt(0, names.length - 1), 1)[0] : pick(HIRE_NAMES);
    escorts.push({ cls, name });
  }
  const fr = Math.random(), freight = { cls: fr < .25 ? 'cog' : fr < .7 ? 'caravel' : 'carrack', name: pick(SHIP_NAMES.merchant) };
  return (s.hires[pi] = { day: bucket, escorts, freight });
}
function hiredShip(cls, name, hired) { // comes fully manned, with a little special shot
  const c = SHIP_CLASSES[cls];
  return { cls, name, hull: c.hull, sailHp: 100, crew: c.crew, ammo: { chain: 2, grape: 2 }, hired };
}
const freightFee = (cls, from, to, gold) => Math.round((40 + SHIP_CLASSES[cls].cargo * 1.5) * Quests.travel(from, to)) + Math.ceil(gold * FREIGHT_INSURE);
function freightText(f) {
  const bits = Object.keys(f.cargo || {}).map(g => `${f.cargo[g]} ${goodName(g).toLowerCase()}`);
  if (f.gold) bits.push(`${f.gold} gold`);
  return bits.join(', ') || 'an empty hold';
}
function deliverFreight(f, pi) { // a charter makes port: returns a line of plain-text news
  const s = Campaign.s, P = propsOf(s, pi), port = PORTS[pi], c = s.consign[pi] || { gold: 0, goods: {} }, bits = [];
  if (f.gold) {
    if (P.bank) { bankSettle(s, pi); P.bank.gold += f.gold; bits.push(`${f.gold} gold into your counting house`); }
    else { c.gold += f.gold; bits.push(`${f.gold} gold`); }
  }
  let stored = 0, left = 0;
  for (const g in f.cargo || {}) {
    let k = f.cargo[g];
    if (P.ware) { const put = Math.min(k, WARE_CAP - wareUsed(P.ware)); if (put > 0) { P.ware[g] = (P.ware[g] || 0) + put; k -= put; stored += put; } }
    if (k) { c.goods[g] = (c.goods[g] || 0) + k; left += k; }
  }
  if (stored) bits.push(`${stored} crates into your warehouse`);
  if (left) bits.push(`${left} crates`);
  f.gold = 0; f.cargo = {};
  if (c.gold || Object.keys(c.goods).length) s.consign[pi] = c;
  const waits = (!P.bank && bits.some(b => b.endsWith(' gold'))) || left;
  return `The chartered ${f.name} has made ${port.name} and landed ${bits.join(', ') || 'nothing'}${waits ? '. What has no home ashore waits with the harbourmaster until you dock there' : ''}.`;
}
function collectConsign(s, pi) { // docking where a charter left goods or gold: take what fits. Returns an HTML news line or ''.
  const c = s.consign[pi]; if (!c) return '';
  const got = [], gold = c.gold; if (gold) { s.gold += gold; c.gold = 0; got.push(`<b>${gold}</b> gold`); }
  let crates = 0;
  for (const g of Object.keys(c.goods)) { const k = stow(s, g, c.goods[g]); crates += k; c.goods[g] -= k; if (!c.goods[g]) delete c.goods[g]; }
  if (crates) got.push(`<b>${crates}</b> crates`);
  const left = Object.values(c.goods).reduce((a, n) => a + n, 0);
  if (!left) delete s.consign[pi];
  if (!got.length) return left ? `The harbourmaster still holds <b>${left}</b> crates of yours, but your hold is full.` : '';
  return `The harbourmaster hands over your consignment: ${got.join(' and ')}${left ? ` (${left} crates still wait: your hold is full)` : ''}.`;
}

// ---------- holdings: property bought in ports, and your headquarters ----------
// s.props[pi] = { bank?: { gold, day }, ware?: { good: crates }, dock?: [laid-up fleet ships] }; s.hq = port index or null.
// Gold in a counting house, goods in a warehouse and ships in a private dock are safe when your flagship goes down,
// but you can only reach them in that port. Laid-up ships don't count against your fleet. Your HQ must be a port where
// you own property: it lets you command the whole fleet from there, raises your fleet size, and is where you wash up if lost.
const WARE_CAP = 80, DOCK_CAP = 3, BANK_RATE = .004, HQ_COST = 600, HQ_FLEET = 2; // BANK_RATE: interest per game day
const PROP_INFO = {
  bank: { name: 'Counting house', icon: '🏦', cost: 400, what: 'keeps your gold safe ashore, and pays interest of ' + BANK_RATE * 100 + '% a day' },
  ware: { name: 'Warehouse', icon: '📦', cost: 500, what: `stores up to ${WARE_CAP} crates of goods ashore` },
  dock: { name: 'Private dock', icon: '⛵', cost: 900, what: `lays up to ${DOCK_CAP} ships, which don't count against your fleet` },
};
const propsOf = (s, pi) => s.props[pi] || {};
const ownsAt = (s, pi) => Object.keys(PROP_INFO).some(k => propsOf(s, pi)[k]);
const fleetMax = s => FLEET_MAX + (s.hq != null ? HQ_FLEET : 0);
const wareUsed = w => Object.values(w || {}).reduce((a, n) => a + n, 0);
const bankTotal = s => Object.values(s.props).reduce((a, p) => a + (p.bank ? p.bank.gold : 0), 0);
function bankSettle(s, pi) { // interest for every whole day since you last looked; returns what was earned
  const b = propsOf(s, pi).bank; if (!b) return 0;
  const days = Math.floor(s.day - b.day); if (days < 1) return 0;
  const before = b.gold; b.gold = Math.floor(b.gold * (1 + BANK_RATE) ** days); b.day += days;
  return b.gold - before;
}
function propLabel(s, pi) { // icons for the map label of a port
  const p = propsOf(s, pi);
  return (s.hq === pi ? ' 🏰' : '') + Object.keys(PROP_INFO).filter(k => p[k]).map(k => PROP_INFO[k].icon).join('');
}

// ---------- persistent campaign state (named save slots in localStorage) ----------
const Campaign = {
  s: null, slot: 0, name: '', SLOTS: 5,
  OLD_KEY: 'corsairs-shattered-sea-v1', PREFIX: 'corsairs-shattered-sea-slot-',
  newGame(slot = 0, name = 'Voyage ' + (slot + 1), career = 'pirate') {
    const p = PORTS[0];
    this.slot = slot; this.name = name;
    this.s = {
      gold: 300, fame: 0, day: 1, hold: {}, boss: 0, // hold: crates by GOODS key; boss: 0 not yet, 1 hunting, 2 defeated
      ship: { cls: 'cog', name: 'Sea Wren', hull: 90, sailHp: 100, crew: 24 },
      up: { hull: 0, sails: 0, guns: 0 }, ammo: { chain: 3, grape: 3 }, fleet: [], props: {}, hq: null, hires: {}, consign: {}, // props/hq: see holdings; hires/consign: ships for hire
      x: p.sx, y: p.sy, heading: p.ang, mapVer: MAP_VER, portVer: PORT_VER,
      career, trade: 0, tradeX: 0, guild: 0, // trade: a merchant's guild standing; guild: 1 once he has his seat
    };
    if (career === 'merchant') { // more coin and a first cargo, less powder
      const s = this.s; s.gold = 420; s.ammo = { chain: 1, grape: 1 }; s.hold = { [pick(p.makes)]: 8 }; s.ship.name = 'Good Hope'; s.ship.crew = 18;
    }
    Quests.ensure(this.s);
  },
  maxHull() { return Math.round(SHIP_CLASSES[this.s.ship.cls].hull * (1 + .15 * this.s.up.hull)); },
  migrate() { // the single save from before slots existed becomes slot 1
    if (this.migrated) return; this.migrated = true;
    try {
      const old = localStorage.getItem(this.OLD_KEY);
      if (old && !localStorage.getItem(this.PREFIX + 0)) localStorage.setItem(this.PREFIX + 0, JSON.stringify({ name: 'My voyage', time: Date.now(), s: JSON.parse(old) }));
      if (old) localStorage.removeItem(this.OLD_KEY);
    } catch (e) { }
  },
  // each slot holds a manual save (key PREFIX + i) and a separate autosave (PREFIX + i + AUTO);
  // autosaves never touch the manual save, so a save made on purpose is always there to go back to
  AUTO: '-auto',
  key(i, auto) { return this.PREFIX + i + (auto ? this.AUTO : ''); },
  readSlot(i, auto = false) {
    this.migrate();
    try { const d = JSON.parse(localStorage.getItem(this.key(i, auto))); return d && d.s && d.s.ship ? d : null; } catch (e) { return null; }
  },
  readAuto(i) { return this.readSlot(i, true); },
  slots() { return Array.from({ length: this.SLOTS }, (_, i) => this.readSlot(i) || this.readAuto(i)); }, // occupied if either exists
  latest() { // { i, auto } of the most recent save of any kind, or null
    let best = null, bt = -1;
    for (let i = 0; i < this.SLOTS; i++) for (const auto of [false, true]) {
      const d = this.readSlot(i, auto); if (d && (d.time || 0) > bt) { bt = d.time || 0; best = { i, auto }; }
    }
    return best;
  },
  hasSave() { return !!this.latest(); },
  write(auto) {
    if (!this.s) return false;
    try { localStorage.setItem(this.key(this.slot, auto), JSON.stringify({ name: this.name, time: Date.now(), s: this.s })); return true; } catch (e) { return false; }
  },
  save() { return this.write(true); }, // autosave: docking, battles, treasure...
  saveManual() { return this.write(false); }, // the captain chose to save
  load(i, auto = false) {
    const d = this.readSlot(i, auto); if (!d) return false;
    if (!d.s.hold) { d.s.hold = d.s.cargo ? { plunder: d.s.cargo } : {}; delete d.s.cargo; } // saves from before trade goods
    ensureFleet(d.s); Quests.ensure(d.s);
    d.s.props = d.s.props || {}; if (d.s.hq === undefined) d.s.hq = null; // saves from before holdings
    d.s.hires = d.s.hires || {}; d.s.consign = d.s.consign || {}; // saves from before ships for hire
    d.s.career = d.s.career || 'pirate'; d.s.trade = d.s.trade || 0; d.s.tradeX = d.s.tradeX || 0; d.s.guild = d.s.guild || 0; // saves from before careers
    this.s = d.s; this.slot = i; this.name = d.name || 'Voyage ' + (i + 1);
    for (let v = (d.s.portVer || 1) + 1; v <= PORT_VER; v++) this.movePorts(d.s, PORT_MOVES[v]);
    d.s.portVer = PORT_VER;
    if (MAP_SHIFT[d.s.mapVer]) this.shiftMap(d.s, ...MAP_SHIFT[d.s.mapVer]);
    if (d.s.mapVer !== MAP_VER) this.newMap(d.s);
    return true;
  },
  shiftMap(s, dx, dy) { // a save from a map with the same coasts in another place: move everything that has a position
    const mv = o => { if (o && o.x != null) { o.x += dx; o.y += dy; } };
    mv(s); s.fleet.forEach(mv); s.quests.forEach(mv); s.maps.forEach(mv);
    for (const f of s.fleet) if (f.task && f.at != null && PORTS[f.at]) Object.assign(f, { x: PORTS[f.at].sx, y: PORTS[f.at].sy }); // a port may have moved
    s.mapVer = MAP_VER;
  },
  newMap(s) { // a save from before the world map: everything at sea goes back to a port, buried treasure is re-charted
    const home = PORTS[0], at = pi => PORTS[pi] || home;
    Object.assign(s, { x: home.sx, y: home.sy, heading: home.ang, mapVer: MAP_VER }); delete s.mapScale;
    for (const f of s.fleet) if (f.task) {
      const T = f.task, p = at(f.at != null ? f.at : T.type === 'station' ? T.port : T.type === 'route' ? T.stops[T.leg] : T.type === 'freight' ? T.from : 0);
      Object.assign(f, { x: p.sx, y: p.sy, heading: p.ang });
    }
    for (const q of s.quests) if (q.x != null) { const pt = q.type === 'escort' ? { x: at(q.from).sx, y: at(q.from).sy } : Quests.seaNear(at(q.from), 1800); q.x = pt.x; q.y = pt.y; }
    s.maps = s.maps.map(m => Object.assign(Quests.newMap(), { gold: m.gold }));
  },
  movePorts(s, moves) { // renumber every port index in a save (see PORT_MOVES), merging what lands in the same port
    const to = {}; for (const [i, name] of Object.entries(moves)) to[i] = PORTS.findIndex(p => p.name === name);
    const m = i => i != null && to[i] != null ? to[i] : i;
    const addGoods = (a = {}, b = {}) => { for (const g in b) a[g] = (a[g] || 0) + b[g]; return a; };
    const rekey = (o, merge) => {
      const out = {};
      for (const [k, v] of Object.entries(o || {})) { const j = m(+k); out[j] = out[j] != null ? merge(out[j], v) : v; }
      return out;
    };
    s.hq = m(s.hq);
    s.props = rekey(s.props, (a, b) => {
      if (b.bank) a.bank = a.bank ? { gold: a.bank.gold + b.bank.gold, day: Math.max(a.bank.day, b.bank.day) } : b.bank;
      if (b.ware) a.ware = addGoods(a.ware, b.ware);
      if (b.dock) a.dock = (a.dock || []).concat(b.dock);
      return a;
    });
    s.consign = rekey(s.consign, (a, b) => ({ gold: a.gold + b.gold, goods: addGoods(a.goods, b.goods) }));
    s.banned = rekey(s.banned, Math.max);
    s.offers = {}; s.hires = {}; // notice boards and ships for hire are drawn up afresh
    for (const z of s.seize || []) z.from = m(z.from);
    for (const q of s.quests) for (const k of ['from', 'to', 'against']) if (q[k] != null) q[k] = m(q[k]);
    const ships = s.fleet.concat(...Object.values(s.props).map(P => P.dock || []));
    for (const f of ships) {
      f.at = m(f.at); const T = f.task; if (!T) continue;
      for (const k of ['port', 'to', 'from']) if (T[k] != null) T[k] = m(T[k]);
      if (T.stops) {
        const st = []; for (const p of T.stops.map(m)) if (p !== st[st.length - 1]) st.push(p); // two stops that became one port
        if (st.length > 1 && st[0] === st[st.length - 1]) st.pop();
        T.stops = st;
        if (st.length < 2) f.task = { type: 'station', port: st[0] };
        else T.leg = Math.min(T.leg, T.stops.length - 1);
      }
      if (f.at != null && PORTS[f.at]) Object.assign(f, { x: PORTS[f.at].sx, y: PORTS[f.at].sy, heading: PORTS[f.at].ang }); // lying in a port that moved
    }
  },
  remove(i) { try { localStorage.removeItem(this.key(i, false)); localStorage.removeItem(this.key(i, true)); } catch (e) { } },
  removeAuto(i) { try { localStorage.removeItem(this.key(i, true)); } catch (e) { } },
};

// ---------- who you meet out there ----------
const lootRoll = (c, g0, g1, c0, c1, good = pick(TRADE_GOODS)) => ({ gold: Math.round(randInt(g0, g1) * SHIP_CLASSES[c].loot), cargo: Math.round(randInt(c0, c1) * SHIP_CLASSES[c].loot), good });
// a merchantman's hold: laden with goods bought in port, or in ballast with only a purse to buy them
const merchantLoot = (c, laden, good = pick(TRADE_GOODS)) => Object.assign(laden ? lootRoll(c, 150, 300, 8, 16) : lootRoll(c, 50, 110, 0, 2), { good });
// pirates either carry their plunder (laden: crates of whatever they took) or sail light and hungry
const pirateLoot = (c, laden, good) => laden ? lootRoll(c, 140, 240, 6, 11, good) : lootRoll(c, 60, 120, 0, 2, good);
// what a pirate has in her hold: what the ports of her waters make, since that is what their merchants carry
function localGood(x, y) {
  const near = PORTS.slice().sort((a, b) => dist(a, { x, y }) - dist(b, { x, y })).slice(0, 3);
  return pick(pick(near).makes);
}
// a haul of n crates of good goes into a pirate fleet's holds: one already carrying it, else the emptiest (what little
// she had of something else goes over the side to make room, unless she has more of it than the haul)
function stowHaul(fleet, good, n) {
  if (n <= 0 || !good || good === 'plunder') return;
  const ps = fleet.filter(f => f.style === 'pirate' && f.loot); if (!ps.length) return;
  let f = ps.find(f => f.loot.good === good && f.loot.cargo);
  if (!f) { f = ps.reduce((a, b) => b.loot.cargo < a.loot.cargo ? b : a); if (f.loot.cargo > n) return; f.loot.good = good; f.loot.cargo = 0; }
  f.loot.cargo += n;
}
const LADEN_WEIGHT = { speedMul: .85, turnMul: .75, accelMul: .65 }; // laden pirates, at sea and in battle
// NPC armament grows with the player's renown: the navy favours long guns, pirates fire and rams.
function armNpc(f, kind, tier) {
  const odds = Math.min(.7, .1 + tier * .2), roll = () => Math.random() < odds;
  if (kind === 'merchant') return; // merchantmen carry what guns they can get
  if (kind === 'pirate') {
    if (roll()) f.gun = pick(['flame', 'bombard', 'flame', 'rifled']);
    if (roll() && Math.random() < .5) f.ram = true;
    if (roll() && Math.random() < .4) f.bow = true;
  } else { // patrols and hunters
    if (roll()) f.gun = pick(['rifled', 'rifled', 'bombard']);
    if (roll() && Math.random() < (kind === 'hunter' ? .7 : .4)) f.bow = true;
    if (kind === 'hunter' && roll() && Math.random() < .25) f.ram = true;
  }
}
function genFleet(kind, fame) {
  const tier = Math.min(3, fame / 35);
  const cls = bias => { const r = tier + rand(-1, 1) + bias; return r < .6 ? 'cog' : r < 1.7 ? 'caravel' : r < 2.8 ? 'carrack' : 'galleon'; };
  const mk = (c, style, o) => Object.assign({ cls: c, style, name: pick(SHIP_NAMES[style]) }, o);
  const loot = lootRoll;
  const fleet = [];
  if (kind === 'merchant') {
    let c = cls(.3); if (c === 'galleon') c = 'carrack';
    fleet.push(mk(c, 'merchant', { aiMode: 'flee', crewMul: .5, gunsMul: .5, speedMul: .6, loot: merchantLoot(c, true) }));
    if (tier > 1 && Math.random() < .5) { const e = cls(-.5); fleet.push(mk(e, 'navy', { loot: loot(e, 40, 90, 0, 0) })); }
  } else if (kind === 'pirate') {
    const n = 1 + (Math.random() < tier * .35 ? 1 : 0) + (Math.random() < tier * .2 ? 1 : 0);
    for (let i = 0; i < n; i++) { const c = cls(i ? -.5 : 0); fleet.push(mk(c, 'pirate', { noFlee: true, crewMul: tier < 1 ? .7 : .85, loot: pirateLoot(c, true) })); } // WorldMap.lade() decides whether they put to sea laden
  } else if (kind === 'patrol') { // the navy keeps the sea lanes: peaceable until it sees you take a merchant
    const n = 1 + (Math.random() < .3 + tier * .2 ? 1 : 0);
    for (let i = 0; i < n; i++) { const c = cls(i ? -.4 : .2); fleet.push(mk(c, 'navy', { loot: loot(c, 60, 130, 0, 1) })); }
  } else if (kind === 'hunter') {
    const n = 2 + (tier > 2.2 ? 1 : 0);
    for (let i = 0; i < n; i++) { const c = cls(i ? -.3 : .3); fleet.push(mk(c, 'navy', { noFlee: true, loot: loot(c, 80, 160, 0, 2) })); }
  } else { // the Admiral
    fleet.push(mk('galleon', 'boss', { name: 'Iron Leviathan', boss: true, hullMul: 1.25, meleeMul: 1.25, gun: 'bombard', bow: true, ram: true, loot: { gold: 5000, cargo: 20, good: 'gold' } }));
    fleet.push(mk('carrack', 'boss', { gun: 'rifled', bow: true, loot: { gold: 400, cargo: 5, good: 'silver' } }));
    fleet.push(mk('caravel', 'boss', { gun: 'flame', ram: true, loot: { gold: 250, cargo: 3, good: 'spice' } }));
  }
  if (kind !== 'boss') for (const f of fleet) armNpc(f, kind, tier);
  return fleet;
}
const NPC_INFO = {
  merchant: { label: 'Merchant', col: '#bfe0ff', aggro: 0 },
  pirate:   { label: 'Pirates', col: '#ff9a8a', aggro: 380 },
  hunter:   { label: 'Pirate hunters', col: '#c9c9ff', aggro: 520 },
  patrol:   { label: 'Navy patrol', col: '#9be7c4', aggro: 0 }, // aggro PATROL_AGGRO while alerted
  boss:     { label: 'Admiral Mordrake', col: '#ff5a4a', aggro: 1e9 },
  own:      { label: 'Your squadron', col: '#ffd24a', aggro: 0 }, // your fleet ships sailing on their own orders
};
// Pirates keep to their own waters: each fleet has a lair where it put to sea, cruises within PIRATE_RANGE px of it, and
// chases you for PIRATE_CHASE s at most (or until you have led it PIRATE_LEASH px from home) before it gives up and turns
// for home for PIRATE_REST s. They gather where the pickings are rich and the navies thin (PIRATE_GROUNDS, boxes of
// [west lon, south lat, east lon, north lat] with a weight) and keep out of the well-patrolled seas (PATROLLED).
const PIRATE_RANGE = 1600, PIRATE_LEASH = 2400, PIRATE_CHASE = 30, PIRATE_REST = 45;
const PIRATE_GROUNDS = [
  { name: 'the Caribbean', box: [-98, 9, -59, 28], w: 4 },
  { name: 'the Arabian Sea', box: [42, 5, 75, 26], w: 3 },
  { name: 'the East Indies', box: [80, -9, 122, 22], w: 3 },
  { name: 'the Mozambique Channel', box: [38, -27, 62, 0], w: 2 },
  { name: 'the Barbary Coast', box: [-10, 33, 12, 39], w: 1.5 },
  { name: 'the Gulf of Guinea', box: [-18, -2, 10, 12], w: 1 },
  { name: 'the open sea', box: null, w: 1.5 }, // anywhere else, outside the patrolled seas
];
const PATROLLED = [[-15, 39, 32, 72], [-80, 36, -50, 50], [128, 30, 146, 46]]; // Europe and its seas, New England, Japan
const inBox = (b, x, y) => { const lon = wrapX(x) / GEO.kx + GEO.lon0, lat = GEO.lat0 - y / GEO.ky; return lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3]; };
const patrolled = (x, y) => PATROLLED.some(b => inBox(b, x, y));
const PATROL_SIGHT = 800, PATROL_AGGRO = 750, PATROL_ALERT = 120; // how far a patrol sees, chases, and how long (s) it hunts you
// The navy hunts pirates too: a patrol not after you runs down any pirate fleet within PATROL_SIGHT for up to PATROL_HUNT s
// (then rests PATROL_REST s), and pirates who see a patrol bearing down within PIRATE_WARY px run for it. Quest pirates
// (bounties, stolen cargo) are left for the player.
const PATROL_HUNT = 60, PATROL_REST = 40, PIRATE_WARY = 420;
// Pirate hunters chasing you turn on any other pirate fleet you lead them within HUNTER_DIVERT px of, and once they
// have dealt with it (or lost it) they leave you be for HUNTER_REST s, long enough to slip away.
const HUNTER_DIVERT = 350, HUNTER_REST = 20;
const fleetPower = fl => fl.reduce((a, f) => a + SHIP_CLASSES[f.cls].hull + SHIP_CLASSES[f.cls].guns * 12, 0);
const OVERWORLD_SPEED = 1.25; // every ship sails a little faster on the map than in battle
// An overworld NPC sails as its lead ship, with the same Ship physics as the player.
function npcShip(n) {
  const f = n.fleet[0];
  const sh = new Ship({ cls: f.cls, style: f.style, team: 1, x: n.x, y: n.y, heading: n.heading, speedMul: f.speedMul, turnMul: f.turnMul, accelMul: f.accelMul, sail: 1, ...fitOf(f) });
  sh.speedMul *= OVERWORLD_SPEED * (n.kind === 'merchant' && n.laden ? .85 : 1); sh.speed = sh.c.speed * .5; // a full hold sits low and slow
  return sh;
}

// ---------- fleets at sea: the ships behind the lead hold a V formation (drawn only; the lead does the sailing) ----------
const WING_GAP = 78;
function wingSlot(i) { const r = Math.floor(i / 2) + 1; return [-r * WING_GAP, (i % 2 ? 1 : -1) * r * WING_GAP * .75]; }
// one follower Ship per entry, matched by identity so they survive the fleet losing ships or a new lead
function syncWing(wing = [], lead, entries, style) {
  if (wing.length === entries.length && wing.every((w, i) => w.src === entries[i])) return wing;
  return entries.map((f, i) => {
    const old = wing.find(w => w.src === f); if (old) return old;
    const [ox, oy] = wingSlot(i), c = Math.cos(lead.heading), sn = Math.sin(lead.heading);
    const w = new Ship({ cls: f.cls, style: style || f.style, team: lead.team, name: f.name, x: lead.x + ox * c - oy * sn, y: lead.y + ox * sn + oy * c, heading: lead.heading, sail: lead.sail });
    w.src = f; return w;
  });
}
// the lead's wake: points every 20 px back along where she has sailed, newest first
function wakeTrail(lead, n) {
  const T = lead.trail || (lead.trail = [{ x: lead.x, y: lead.y }]);
  if (Math.hypot(T[0].x - lead.x, T[0].y - lead.y) > 600) T.length = 0; // she jumped (left port, after a battle)
  if (!T.length || Math.hypot(T[0].x - lead.x, T[0].y - lead.y) > 20) T.unshift({ x: lead.x, y: lead.y });
  T.length = Math.min(T.length, n);
  return T;
}
function trailPoint(lead, T, back) { // the point `back` px astern of the lead, measured along her wake
  let px = lead.x, py = lead.y;
  for (const q of T) { const d = Math.hypot(q.x - px, q.y - py); if (d >= back) { const k = back / d; return { x: px + (q.x - px) * k, y: py + (q.y - py) * k }; } back -= d; px = q.x; py = q.y; }
  return { x: px, y: py };
}
function followWing(wing, lead, dt, parts) {
  const c = Math.cos(lead.heading), sn = Math.sin(lead.heading);
  const T = wakeTrail(lead, 12 + wing.length * 6);
  wing.forEach((w, i) => {
    const [ox, oy] = wingSlot(i);
    let tx = lead.x + ox * c - oy * sn, ty = lead.y + ox * sn + oy * c;
    if (!clearLine(lead.x, lead.y, tx, ty) || !clearLine(w.x, w.y, tx, ty)) { // land in the way of her station: fall into line astern, in the lead's wake
      const q = trailPoint(lead, T, (i + 1) * WING_GAP * .8); tx = q.x; ty = q.y;
    }
    const dx = tx - w.x, dy = ty - w.y;
    if (Math.hypot(dx, dy) > 600) { w.x = tx; w.y = ty; w.heading = lead.heading; w.speed = lead.speed; return; } // the lead jumped (left port, after a battle)
    const vx = lead.vx + dx * 1.4, vy = lead.vy + dy * 1.4, v = Math.hypot(vx, vy); // keep pace, closing on the slot
    w.x += vx * dt; w.y += vy * dt; w.speed = v; w.sail = lead.sail;
    w.heading += angDiff(v > 8 ? Math.atan2(vy, vx) : lead.heading, w.heading) * Math.min(1, dt * 3);
    pushOffLand(w, 14);
    if (parts) parts.wake(w, dt);
  });
}
function drawFleetLines(ctx, lead, wing, col) {
  if (!wing.length) return;
  ctx.save(); ctx.strokeStyle = col; ctx.globalAlpha = .75; ctx.lineWidth = 3; ctx.setLineDash([9, 9]); ctx.lineCap = 'round';
  ctx.beginPath(); for (const w of wing) { ctx.moveTo(lead.x, lead.y); ctx.lineTo(w.x, w.y); } ctx.stroke();
  ctx.restore();
}

// ---------- overworld ----------
// ---------- drawing the land ----------
// Shallows and beach are strokes along the coast; inside, the land is clipped and banded from the shore inwards.
// Only the coast chunks and tree tiles inside the view (x0,y0)-(x1,y1) are drawn.
function drawLand(ctx, x0, y0, x1, y1) {
  const m = 60, inView = b => b[2] > x0 - m && b[0] < x1 + m && b[3] > y0 - m && b[1] < y1 + m;
  const polys = LAND.polys.filter(P => inView(P.box)), chunks = LAND.chunks.filter(c => inView(c.box));
  if (!polys.length) return;
  const cuts = LAND.cuts.filter(c => inView(c.box)), banks = LAND.banks.filter(c => inView(c.box));
  const coast = new Path2D(); for (const c of chunks) coast.addPath(c.path);
  const bank = new Path2D(); for (const c of banks) bank.addPath(c.path);
  const land = new Path2D(); for (const P of polys) land.addPath(P.path);
  const offs = cuts.map(c => { const p = new Path2D(); p.rect(x0 - m, y0 - m, x1 - x0 + 2 * m, y1 - y0 + 2 * m); p.addPath(c.path); return p; });
  const notCuts = () => { for (const p of offs) ctx.clip(p, 'evenodd'); }; // everything in view but the cut waters (one clip each, so they may overlap)
  ctx.save(); ctx.lineJoin = ctx.lineCap = 'round';
  const band = (col, w, path = coast) => { ctx.strokeStyle = col; ctx.lineWidth = w; ctx.stroke(path); };
  const both = (col, w) => { band(col, w); band(col, w, bank); };
  band('rgba(110,200,210,.16)', 96); band('rgba(110,200,210,.24)', 60);
  ctx.save(); notCuts(); band('#e3d29a', 16); ctx.restore(); // no beach across a river mouth
  band('rgba(110,200,210,.16)', 96, bank); band('rgba(110,200,210,.24)', 60, bank); band('#e3d29a', 16, bank);
  ctx.clip(land); notCuts();
  ctx.fillStyle = '#4f7d40'; ctx.fill(land);
  both('#5f8f4c', 96); both('#cdbb84', 24); both('#e3d29a', 12);
  ctx.fillStyle = '#3d6a33'; ctx.beginPath(); // trees
  for (let ty = Math.floor(y0 / TREE_TILE); ty <= Math.floor(y1 / TREE_TILE); ty++) for (let tx = Math.floor(x0 / TREE_TILE); tx <= Math.floor(x1 / TREE_TILE); tx++)
    for (const [x, y] of LAND.trees.get(tx + ',' + ty) || []) { ctx.moveTo(x + 6, y); ctx.arc(x, y, 6, 0, TAU); }
  ctx.fill();
  ctx.restore();
}
function chartImage() { // the corner chart's land, drawn once from the land grid
  if (LAND.chart) return LAND.chart;
  const w = 680, h = Math.round(w * WORLD.H / WORLD.W), cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const c = cv.getContext('2d'), img = c.createImageData(w, h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const d = landSd((i + .5) * WORLD.W / w, (j + .5) * WORLD.H / h), o = (j * w + i) * 4;
    if (d < 0) { img.data[o] = 143; img.data[o + 1] = 174; img.data[o + 2] = 106; img.data[o + 3] = 255; }
    else if (d < 40) { img.data[o] = 110; img.data[o + 1] = 200; img.data[o + 2] = 210; img.data[o + 3] = 50; }
  }
  c.putImageData(img, 0, 0);
  return (LAND.chart = cv);
}
// ---------- the chart room (C at sea): the whole world, its coasts and ports, and no ships ----------
// The world stands still while it is open. Drag, WASD or the arrow keys pan; the wheel or +/- zoom; Space centres on you.
// Zoomed out it draws a picture of the land made once from the land grid; zoomed in, the same coasts as at sea (drawLand).
const ChartView = {
  open: false, x: 0, y: 0, z: 0, wheel: 0, drag: null, mouse: null, hooked: false,
  DETAIL: .14, ZMAX: .7, // zoom at which the real coasts take over from the picture, and the closest you can look
  show(map) {
    this.hook();
    this.open = true; this.x = map.ship.x; this.y = map.ship.y; this.z = 0; this.wheel = 0; this.drag = null;
  },
  hide() { this.open = false; this.drag = null; },
  hook() { // mouse handling, attached the first time the chart is opened
    if (this.hooked) return; this.hooked = true;
    addEventListener('wheel', e => { if (this.open && !UI.open) { this.wheel += e.deltaY; this.mouse = { x: e.clientX, y: e.clientY }; e.preventDefault(); } }, { passive: false });
    addEventListener('pointerdown', e => { if (this.open && !UI.open) this.drag = { x: e.clientX, y: e.clientY }; });
    addEventListener('pointermove', e => {
      this.mouse = { x: e.clientX, y: e.clientY };
      if (this.open && this.drag) { this.x -= (e.clientX - this.drag.x) / this.z; this.y -= (e.clientY - this.drag.y) / this.z; this.drag = { x: e.clientX, y: e.clientY }; }
    });
    addEventListener('pointerup', () => { this.drag = null; });
  },
  fit(W, H) { return Math.min(W / WORLD.W, (H - 60) / WORLD.H); }, // the whole world on screen
  zoomBy(f, W, H, at) { // zoom, keeping the world point under `at` (screen) where it is
    const z0 = this.z, z1 = clamp(z0 * f, this.fit(W, H), this.ZMAX);
    if (at) { this.x += (at.x - W / 2) * (1 / z0 - 1 / z1); this.y += (at.y - H / 2) * (1 / z0 - 1 / z1); }
    this.z = z1;
  },
  update(dt, W, H, map) {
    if (!this.z) this.z = clamp(this.fit(W, H) * 2.5, this.fit(W, H), this.ZMAX);
    if (Input.was('Escape', 'c')) return this.hide();
    if (Input.was(' ')) { this.x = map.ship.x; this.y = map.ship.y; }
    const v = 700 * dt / this.z;
    this.x += ((Input.is('d', 'ArrowRight') ? 1 : 0) - (Input.is('a', 'ArrowLeft') ? 1 : 0)) * v;
    this.y += ((Input.is('s', 'ArrowDown') ? 1 : 0) - (Input.is('w', 'ArrowUp') ? 1 : 0)) * v;
    if (Input.is('+', '=')) this.zoomBy(1 + dt * 1.5, W, H);
    if (Input.is('-', '_')) this.zoomBy(1 / (1 + dt * 1.5), W, H);
    if (this.wheel) { this.zoomBy(Math.exp(-this.wheel * .0015), W, H, this.mouse); this.wheel = 0; }
    const hh = H / 2 / this.z; // north and south stop at the edges of the world; east and west it wraps
    this.y = WORLD.H < 2 * hh ? WORLD.H / 2 : clamp(this.y, hh - 30 / this.z, WORLD.H - hh + 30 / this.z);
    this.x = wrapX(this.x);
  },
  image() { // the land, drawn once at about 1 px per 9 px of world
    if (LAND.bigChart) return LAND.bigChart;
    const w = 2320, h = Math.round(w * WORLD.H / WORLD.W), cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const c = cv.getContext('2d'), img = c.createImageData(w, h), sx = WORLD.W / w, sy = WORLD.H / h;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const d = landSd((i + .5) * sx, (j + .5) * sy), o = (j * w + i) * 4;
      const col = d < -60 ? [79, 125, 64] : d < -14 ? [95, 143, 76] : d < 0 ? [227, 210, 154] : d < 40 ? [110, 200, 210] : null;
      if (col) { img.data[o] = col[0]; img.data[o + 1] = col[1]; img.data[o + 2] = col[2]; img.data[o + 3] = d < 0 ? 255 : 70; }
    }
    c.putImageData(img, 0, 0);
    return (LAND.bigChart = cv);
  },
  draw(ctx, W, H, map) {
    if (!this.z) this.update(0, W, H, map);
    const s = Campaign.s, z = this.z, X = wx => (wx - this.x) * z + W / 2, Y = wy => (wy - this.y) * z + H / 2;
    ctx.fillStyle = '#1b5a82'; ctx.fillRect(0, 0, W, H);
    const vx0 = this.x - W / 2 / z, vx1 = this.x + W / 2 / z, vy0 = this.y - H / 2 / z, vy1 = this.y + H / 2 / z;
    const copies = []; for (let c = Math.floor(vx0 / WORLD.W); c <= Math.floor(vx1 / WORLD.W); c++) copies.push(c * WORLD.W);
    ctx.fillStyle = 'rgba(10,30,50,.5)'; // beyond the edges of the known world
    ctx.fillRect(0, 0, W, Y(0)); ctx.fillRect(0, Y(WORLD.H), W, H - Y(WORLD.H));
    if (z < this.DETAIL) {
      ctx.imageSmoothingEnabled = true;
      for (const o of copies) ctx.drawImage(this.image(), X(o), Y(0), WORLD.W * z, WORLD.H * z);
    } else for (const o of copies) {
      ctx.save(); ctx.translate(W / 2, H / 2); ctx.scale(z, z); ctx.translate(-this.x + o, -this.y);
      drawLand(ctx, vx0 - o, vy0, vx1 - o, vy1); ctx.restore();
    }
    // lines of longitude and latitude every 30°
    ctx.strokeStyle = 'rgba(255,255,255,.14)'; ctx.lineWidth = 1; ctx.beginPath();
    for (const o of copies) for (let lon = -180; lon < 180; lon += 30) { const x = X(geo(lon, 0)[0] + o); ctx.moveTo(x, Y(0)); ctx.lineTo(x, Y(WORLD.H)); }
    for (let lat = 60; lat >= -60; lat -= 30) { const y = Y(geo(0, lat)[1]); ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
    for (let lat = 60; lat >= -60; lat -= 30) hudText(ctx, lat ? `${Math.abs(lat)}°${lat > 0 ? 'N' : 'S'}` : 'Equator', 8, Y(geo(0, lat)[1]) - 8, 11, 'rgba(255,255,255,.55)');
    // ports: a dot each, and a name wherever it fits
    const taken = [], fs = clamp(11 + (z - .03) * 40, 11, 16);
    const ports = PORTS.map((pt, i) => ({ pt, i })).sort((a, b) => (b.i === s.hq) - (a.i === s.hq) || (ownsAt(s, b.i) - ownsAt(s, a.i)));
    ctx.font = `bold ${fs}px Georgia`;
    const shown = []; for (const o of copies) for (const e of ports) {
      const x = X(e.pt.x + o), y = Y(e.pt.y); if (x < -60 || x > W + 60 || y < -20 || y > H + 20) continue;
      const hq = s.hq === e.i; ctx.fillStyle = hq ? '#ffd24a' : '#fff3c4'; ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, hq ? 5 : 3.5, 0, TAU); ctx.fill(); ctx.stroke();
      taken.push([x - 4, y - 4, x + 4, y + 4]); shown.push({ ...e, x, y }); // labels keep clear of every port's dot
    }
    for (const { pt, i, x, y } of shown) {
      const hq = s.hq === i, label = pt.name + (isShipyard(pt) ? ' ⚒' : '') + propLabel(s, i), w = ctx.measureText(label).width + 6;
      const box = [x - w / 2, y - 8 - fs * 1.2, x + w / 2, y - 6];
      if (taken.some(b => b[0] < box[2] && b[2] > box[0] && b[1] < box[3] && b[3] > box[1])) continue;
      taken.push(box); hudText(ctx, label, x, y - 7 - fs * .6, fs, hq ? '#ffd24a' : '#fff3c4', 'center', true);
    }
    { // where you are: a gold ring (no ship drawn)
      const pulse = .5 + .5 * Math.sin(Game.t * 3), y = Y(s.y);
      for (const o of copies) {
        const x = X(wrapX(s.x) + o); if (x < -30 || x > W + 30) continue;
        ctx.strokeStyle = `rgba(255,210,74,${.5 + .5 * pulse})`; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(x, y, 8 + pulse * 4, 0, TAU); ctx.stroke();
        ctx.fillStyle = '#ffd24a'; ctx.beginPath(); ctx.arc(x, y, 3, 0, TAU); ctx.fill();
        hudText(ctx, 'You are here', x, y + 22, 12, '#ffd24a', 'center', true);
      }
    }
    hudPanel(ctx, W / 2 - 260, 8, 520, 50);
    hudText(ctx, 'Chart of the Known World', W / 2, 24, 17, '#fff3c4', 'center', true);
    hudText(ctx, 'Drag or WASD to pan · wheel or +/− to zoom · Space: find your ship · C or Esc: back to sea', W / 2, 45, 12, 'rgba(245,233,200,.85)', 'center');
  },
};
class WorldMap {
  constructor() {
    this.npcs = []; this.parts = new Particles(); this.t = 0; this.msgs = []; this.safe = 3; this.spawnT = 0;
    this.wind = { dir: rand(TAU), str: 1, drift: rand(-.01, .01) };
    this.refreshShip();
    for (let i = 0; i < seaFill(15); i++) this.spawn('merchant');
    for (let i = 0; i < seaFill(6); i++) this.spawn('pirate');
    for (let i = 0; i < seaFill(3); i++) this.spawn('patrol');
    if (Campaign.s.boss === 1) this.spawn('boss');
    this.wrecks = [];
    for (const q of Campaign.s.quests) if (q.fleet && !q.done && !q.arrived) this.spawnQuest(q);
    this.syncOwn();
  }
  // one 'own' NPC per detached fleet ship; gone again once she rejoins your wing or leaves the fleet
  syncOwn() {
    const s = Campaign.s;
    this.npcs = this.npcs.filter(n => n.kind !== 'own' || (!n.dead && s.fleet.includes(n.src) && n.src.task));
    for (const f of s.fleet) if (f.task && !this.npcs.some(n => n.src === f)) {
      if (f.x == null) { const w = (this.wing || []).find(w => w.src === f) || this.ship; f.x = w.x; f.y = w.y; f.heading = w.heading; } // she peels off from the wing
      const n = { kind: 'own', src: f, x: f.x, y: f.y, heading: f.heading || 0, fleet: [f], cool: 0, info: NPC_INFO.own };
      n.ship = new Ship({ cls: f.cls, style: 'ally', team: 0, name: f.name, x: f.x, y: f.y, heading: n.heading, sail: f.at != null ? 0 : 1 });
      n.ship.speedMul *= OVERWORLD_SPEED;
      this.npcs.push(n);
    }
  }
  // a squadron's orders: returns true while she lies at anchor in port, otherwise sets n.goal to sail for
  ownStep(n, dt) {
    const f = n.src, T = f.task, p = this.ship, col = NPC_INFO.own.col, seen = t => this.msg(t, col);
    if (T.type === 'recall') {
      n.goal = { x: p.x, y: p.y };
      if (dist(n, p) < 140) {
        delete f.task; f.at = f.x = f.y = null; f.lie = 0; n.dead = true; boardCargo(Campaign.s, f);
        const g = takePurse(Campaign.s, f); seen(`The ${f.name} falls in astern of you${g ? ` and sends her purse of ${g} gold across` : ''}.`); return true;
      }
      return false;
    }
    if (T.type === 'freight') { // a charter sails straight for her port, lands everything, and is done
      const port = PORTS[T.to]; n.goal = port;
      if (dist(port, n) < 90) {
        const s = Campaign.s; seen(deliverFreight(f, T.to));
        s.fleet.splice(s.fleet.indexOf(f), 1); n.dead = true; Campaign.save();
        if (dist(n, p) < 1400) Sfx.coin();
        return true;
      }
      return false;
    }
    if (f.at != null) { // in port: a station ship waits for orders; a route ship works cargo, then sails for her next stop
      if (T.type === 'route' && (f.lie = (f.lie || 0) - dt) <= 0) { f.at = null; T.leg = (T.leg + 1) % T.stops.length; if (!T.leg) T.trips++; }
      const sh = n.ship; sh.rudder = 0; sh.sail = 0; sh.update(dt, this.wind); sh.speed *= Math.max(0, 1 - dt * 2);
      if (pushOffLand(sh, 14)) sh.speed *= Math.max(0, 1 - dt * 3);
      n.x = f.x = sh.x; n.y = f.y = sh.y; n.heading = f.heading = sh.heading;
      return true;
    }
    const pi = T.type === 'station' ? T.port : T.stops[T.leg], port = PORTS[pi];
    n.goal = port;
    if (dist(port, n) < 90) { // made port
      f.at = pi;
      if (T.type === 'station') { const sold = sellCargo(f, port); seen(`The ${f.name} has made ${port.name} and waits there for orders.`); if (sold) seen(sold); }
      else { f.lie = ROUTE_LIE; routeTrade(f, pi).forEach(seen); }
      if (dist(n, p) < 1400) Sfx.coin();
      return true;
    }
    return false;
  }
  raidOwn(pir, n) { // pirates fall on one of your laden trade ships at sea
    pir.raidCool = 60;
    const s = Campaign.s, f = n.src, c = SHIP_CLASSES[f.cls], col = '#ff9a8a';
    if (Math.random() < clamp(.15 + c.guns * .035 + .25 * f.crew / c.crew, .15, .8)) { // her guns drive them off
      f.hull = Math.max(1, f.hull - c.hull * rand(.06, .18)); f.crew = Math.max(0, f.crew - randInt(0, 3));
      this.msg(`The ${f.name} beat off a pirate attack, though she took some damage.`, NPC_INFO.own.col); return;
    }
    const k = cargoOf(f), g = k ? Object.keys(f.cargo)[0] : null, L = pir.fleet[0].loot, purse = f.gold || 0;
    L.gold += purse; f.gold = 0; for (const [cg, n] of Object.entries(f.cargo || {})) stowHaul(pir.fleet, cg, Math.round(n * .5)); // they take her goods, crates and all
    this.weigh(pir, true); pir.raids = (pir.raids || 0) + 1;
    f.cargo = {}; f.cargoCost = 0; f.hull -= c.hull * rand(.15, .35); f.crew = Math.round(f.crew * rand(.7, .9));
    if (f.hull < c.hull * .12) { s.fleet.splice(s.fleet.indexOf(f), 1); n.dead = true; this.msg(f.hired ? `Pirates have taken the chartered ${f.name}, and all she carried for you!` : `Pirates have taken the ${f.name}! She is lost to your fleet.`, col); }
    else { f.hull = Math.max(1, f.hull); this.msg(`Pirates plundered the ${f.name} of ${[k && `${k} crates of ${goodName(g).toLowerCase()}`, purse && `${purse} gold`].filter(Boolean).join(' and ')}!`, col); }
    Campaign.save();
  }
  spawnQuest(q) { // the ship a job is about: a bounty's pirates or the merchant you escort
    const kind = q.type === 'escort' ? 'merchant' : 'pirate';
    const n = { kind, x: q.x, y: q.y, heading: rand(TAU), fleet: JSON.parse(JSON.stringify(q.fleet)), cool: 0, wp: null, info: NPC_INFO[kind], laden: q.type !== 'bounty', q: q.id, home: q.from };
    if (kind === 'merchant') { n.charge = true; n.wp = PORTS[q.to]; }
    else { n.raids = 2; n.lair = { x: q.x, y: q.y }; } // a marked captain lies low instead of raiding, near where he was last seen
    n.ship = npcShip(n);
    this.npcs.push(n);
    return n;
  }
  nearYou(n) { // keep a fleet on the side of the world nearest you, so it is drawn (and its wing follows) without a jump
    const d = this.ship.x + wrapDx(n.ship.x - this.ship.x) - n.ship.x; if (!d) return;
    n.ship.x += d; n.x = n.ship.x; for (const w of n.wing || []) w.x += d;
    if (n.kind === 'own') n.src.x = n.x;
    n.ship.trail = null;
  }
  refreshShip() {
    const s = Campaign.s;
    this.ship = new Ship({ cls: s.ship.cls, team: 0, isPlayer: true, style: 'player', name: s.ship.name, x: s.x, y: s.y, heading: s.heading, up: s.up, hull: s.ship.hull, sailHp: s.ship.sailHp, crew: s.ship.crew, sail: .5, ...fitOf(s.ship) });
    this.ship.speedMul *= OVERWORLD_SPEED;
  }
  msg(text, col) { this.msgs.push({ text, t: 4, col }); if (this.msgs.length > 3) this.msgs.shift(); }
  pirateGround(minFromPlayer) { // somewhere in pirate waters: mostly their favourite grounds, never the patrolled seas
    const tot = PIRATE_GROUNDS.reduce((a, g) => a + g.w, 0);
    for (let i = 0; i < 120; i++) {
      let r = rand(tot), g = PIRATE_GROUNDS[0]; for (const h of PIRATE_GROUNDS) if ((r -= h.w) <= 0) { g = h; break; }
      let pt;
      if (g.box) { const [x0, y1] = geo(g.box[0], g.box[1]), [x1, y0] = geo(g.box[2], g.box[3]); pt = { x: wrapX(rand(x0, x1)), y: rand(y0, y1) }; }
      else pt = { x: rand(WORLD.W), y: rand(150, WORLD.H - 150) };
      if (pt.y < 150 || pt.y > WORLD.H - 150 || patrolled(pt.x, pt.y) || onLand(pt.x, pt.y, 70) || !seaOK(pt.x, pt.y)) continue;
      if (dist(pt, this.ship) < minFromPlayer) continue;
      return pt;
    }
    return this.seaPoint(minFromPlayer);
  }
  nearLair(n) { // a point to cruise to within PIRATE_RANGE of a pirate's lair
    for (let i = 0; i < 30; i++) {
      const a = rand(TAU), d = rand(PIRATE_RANGE), pt = { x: wrapX(n.lair.x + Math.cos(a) * d), y: n.lair.y + Math.sin(a) * d };
      if (pt.y > 150 && pt.y < WORLD.H - 150 && !onLand(pt.x, pt.y, 70) && seaOK(pt.x, pt.y)) return pt;
    }
    return { x: n.lair.x, y: n.lair.y };
  }
  seaPoint(minFromPlayer) {
    for (let i = 0; i < 60; i++) {
      const pt = { x: rand(WORLD.W), y: rand(150, WORLD.H - 150) };
      if (onLand(pt.x, pt.y, 70) || !seaOK(pt.x, pt.y)) continue;
      if (dist(pt, this.ship) < minFromPlayer) continue;
      return pt;
    }
    return { x: PORTS[0].sx, y: PORTS[0].sy };
  }
  spawn(kind) {
    const pt = kind === 'pirate' ? this.pirateGround(800) : this.seaPoint(kind === 'boss' ? 1500 : 800), fleet = genFleet(kind, renown());
    const n = { kind, x: pt.x, y: pt.y, heading: rand(TAU), fleet, cool: 0, wp: null, info: NPC_INFO[kind], laden: kind === 'pirate' };
    n.home = randInt(0, PORTS.length - 1); // the port whose colours a merchant or patrol flies
    if (kind === 'merchant') this.lade(n, Math.random() < .4); // most merchants at sea are bound for a port to buy
    if (kind === 'pirate') { n.lair = { x: pt.x, y: pt.y }; this.lade(n, Math.random() < .5); } // half have plunder aboard, half are still hunting for it
    n.ship = npcShip(n);
    this.npcs.push(n);
    return n;
  }
  nearest(from, kind, range, ok) {
    let best = null, bd = range;
    for (const o of this.npcs) {
      if (o === from || o.dead || o.kind !== kind || (ok && !ok(o))) continue;
      const d = dist(from, o); if (d < bd) { bd = d; best = o; }
    }
    return best;
  }
  lade(n, laden, good) { // fill or empty a fleet's holds; a merchant's escorts keep their own purses
    const pg = n.kind === 'pirate' ? good || localGood(n.x, n.y) : null; // pirates: what they took off the merchants of their waters
    for (const f of n.fleet) {
      if (f.style === 'merchant') f.loot = merchantLoot(f.cls, laden, good);
      if (f.style === 'pirate') f.loot = pirateLoot(f.cls, laden, pg);
    }
    this.weigh(n, laden);
  }
  weigh(n, laden) { // laden pirate ships sail slower, turn and gather way more sluggishly (merchants: see npcShip)
    n.laden = laden;
    if (n.kind === 'pirate') for (const f of n.fleet) Object.assign(f, laden ? LADEN_WEIGHT : { speedMul: 1, turnMul: 1, accelMul: 1 });
    if (n.ship) { const old = n.ship; n.ship = npcShip(n); n.ship.speed = old.speed; }
  }
  trade(mer) { // in port: sell whatever is aboard, buy what the port makes, and sail for a port that wants it
    const port = mer.wp, seen = dist(mer, this.ship) < 900;
    const good = pick(port.makes);
    mer.trading = 0; mer.home = PORTS.indexOf(port); this.lade(mer, true, good);
    const dest = PORTS.filter(p => p !== port && p.wants.includes(good)); // carry it where it fetches a price
    mer.wp = pick(dest.length ? dest : PORTS.filter(p => p !== port));
    if (seen) this.msg(`A merchant puts out from ${port.name} with ${goodName(good).toLowerCase()} for ${mer.wp.name}`, NPC_INFO.merchant.col);
  }
  witness(victim) { // you just attacked victim: every patrol in sight of it turns on you
    let seen = 0;
    for (const n of this.npcs) if (n.kind === 'patrol' && n !== victim && !n.dead && dist(n, victim) < PATROL_SIGHT) { n.alert = PATROL_ALERT; seen++; }
    if (seen) this.msg(`A navy patrol saw you attack the ${victim.kind === 'patrol' ? 'patrol' : 'merchant'}! They are hunting you.`, NPC_INFO.patrol.col);
  }
  hostileTo(n) { return n.kind !== 'merchant' && (n.kind !== 'hunter' || !isMerchant()) && (n.kind !== 'patrol' || n.alert > 0 || Quests.rival(n)); }
  aggroOf(n) { // how far off a ship comes after you
    if (n.kind === 'patrol') return n.alert > 0 || Quests.rival(n) ? PATROL_AGGRO : 0;
    if (n.kind === 'hunter' && isMerchant()) return 0; // they hunt pirates, not honest traders
    if (n.kind === 'pirate' && isMerchant() && holdUsed(Campaign.s)) return n.info.aggro * 1.3; // a laden merchantman draws them
    return n.info.aggro;
  }
  navyFight(nav, pir) { // a patrol or pirate hunters have run a pirate fleet down: settle it without the player
    const seen = dist(nav, this.ship) < 1400, a = fleetPower(nav.fleet), b = fleetPower(pir.fleet), who = nav.kind === 'hunter' ? 'pirate hunters' : 'a navy patrol';
    nav.hunt = 0; nav.huntCool = PATROL_REST; nav.quarry = null;
    if (nav.kind === 'hunter') nav.cool = Math.max(nav.cool, HUNTER_REST);
    if (Math.random() < a / (a + b)) {
      pir.dead = true;
      const gold = pir.fleet.reduce((t, f) => t + f.loot.gold, 0), L = pir.fleet.find(f => f.loot.good && f.loot.cargo) || pir.fleet[0];
      this.wrecks = this.wrecks || []; // what the navy didn't haul aboard floats free
      this.wrecks.push({ x: wrapX(pir.x), y: pir.y, t: 150, kind: 'Wreckage', gold: Math.round(gold * .2), good: L.loot.good || pick(TRADE_GOODS), n: Math.round((L.loot.cargo || 4) * .3) });
      if (seen) this.msg(`${who[0].toUpperCase() + who.slice(1)} ${nav.kind === 'hunter' ? 'have' : 'has'} caught and sunk a pirate fleet!`, nav.info.col);
    } else {
      pir.cool = Math.max(pir.cool, 5);
      if (seen) this.msg(`The pirates beat off ${who} and slip away.`, NPC_INFO.pirate.col);
    }
  }
  canRaid(pir) { return pir.fleet[0].cls !== 'cog' && pir.raidCool <= 0 && (pir.raids || 0) < 2; } // cog crews only go after the player
  raid(pir, mer) { // pirates take a merchant without a battle; each pirate fleet raids at most twice
    pir.raidCool = 60;
    const seen = dist(pir, this.ship) < 1400;
    if (mer.fleet.length > 1 && Math.random() < .5) {
      mer.raidCool = 0;
      if (seen) this.msg("A merchant's escort drove off a pirate attack", NPC_INFO.merchant.col);
      return;
    }
    mer.dead = true; Quests.onRaid(this, mer);
    pir.fleet[0].loot.gold += Math.round(mer.fleet.reduce((a, f) => a + f.loot.gold, 0) * .5);
    for (const f of mer.fleet) stowHaul(pir.fleet, f.loot.good, Math.round(f.loot.cargo * .5)); // her goods, crates and all
    this.weigh(pir, true); pir.raids = (pir.raids || 0) + 1;
    if (seen) this.msg('Pirates have plundered a merchant. Their holds are full!', NPC_INFO.pirate.col);
  }
  update(dt) {
    const s = Campaign.s, p = this.ship;
    this.t += dt; s.day += dt / 25; this.safe -= dt; NAV.budget = 4; // routes planned per frame
    this.wind.dir += (this.wind.drift + Math.sin(this.t * .07) * .02) * dt;
    p.rudder = (Input.is('d', 'ArrowRight') ? 1 : 0) - (Input.is('a', 'ArrowLeft') ? 1 : 0);
    if (Input.was('w', 'ArrowUp')) p.sail = Math.min(1, p.sail + .5);
    if (Input.was('s', 'ArrowDown')) p.sail = Math.max(0, p.sail - .5);
    p.update(dt, this.wind);
    if (pushOffLand(p, 14)) p.speed *= Math.max(0, 1 - dt * 3);
    p.y = clamp(p.y, 40, WORLD.H - 40); // east and west she sails on round the world (x is never wrapped: the view follows her)
    s.x = p.x; s.y = p.y; s.heading = p.heading;
    this.parts.wake(p, dt);
    for (const f of s.fleet.slice()) if (f.hired && f.hired.until != null && f.hired.until <= s.day) { // an escort's contract has run out
      s.fleet.splice(s.fleet.indexOf(f), 1); this.msg(`Your contract with the ${f.name} has run out: she dips her colours and parts company.`, '#ffd24a');
    }
    this.wing = syncWing(this.wing, p, wingFleet(s), 'ally'); followWing(this.wing, p, dt, this.parts);
    this.syncOwn();

    this.nearPort = PORTS.find(pt => dist(pt, p) < 125) || null;
    if (this.nearPort && Input.was('Enter')) { Game.dock(this.nearPort); return; }
    Quests.update(this, dt);

    this.npcs = this.npcs.filter(n => !n.dead);
    for (const n of this.npcs) {
      this.nearYou(n);
      n.cool -= dt; n.raidCool = (n.raidCool || 0) - dt;
      if (n.alert > 0 && (n.alert -= dt) <= 0 && dist(n, p) < 1400) this.msg('A navy patrol gives up the hunt.', NPC_INFO.patrol.col);
      const aggro = this.aggroOf(n);
      const d = dist(n, p); let hostile = aggro > 0 && n.cool <= 0 && !this.nearPort && d < aggro;
      if (n.kind === 'pirate' && n.lair) { // pirates hold their own waters, and tire of a long chase
        n.chase = hostile ? (n.chase || 0) + dt : Math.max(0, (n.chase || 0) - dt * .5);
        if (hostile && (n.chase > PIRATE_CHASE || dist(n, n.lair) > PIRATE_LEASH)) {
          hostile = false; n.chase = 0; n.cool = PIRATE_REST; n.wp = this.nearLair(n); n.nav = {};
          if (d < 1400) this.msg('The pirates give up the chase and turn back for their own waters.', NPC_INFO.pirate.col);
        }
      }
      if (n.kind === 'own' && this.ownStep(n, dt)) continue;
      let quarry = null;
      if (n.kind === 'patrol') { // the navy hunts pirates when it isn't hunting you
        n.huntCool = (n.huntCool || 0) - dt;
        if (n.quarry && (n.quarry.dead || dist(n, n.quarry) > PATROL_SIGHT * 1.3)) n.quarry = null;
        if (!hostile && n.huntCool <= 0) quarry = n.quarry || this.nearest(n, 'pirate', PATROL_SIGHT, o => !o.q);
        if (quarry) {
          if (!n.quarry && dist(n, p) < 1400) this.msg('A navy patrol gives chase to a pirate fleet.', NPC_INFO.patrol.col);
          n.quarry = quarry; n.trading = 0;
          if ((n.hunt = (n.hunt || 0) + dt) > PATROL_HUNT) {
            quarry = n.quarry = null; n.hunt = 0; n.huntCool = PATROL_REST; n.wp = null; n.nav = {};
            if (dist(n, p) < 1400) this.msg('The pirates have outrun a navy patrol.', NPC_INFO.pirate.col);
          }
        } else { n.quarry = null; n.hunt = 0; }
      } else if (n.kind === 'hunter') { // run them past another pirate and they go for the nearer prey
        if (n.quarry && (n.quarry.dead || dist(n, n.quarry) > PATROL_SIGHT * 1.3)) { n.quarry = null; n.hunt = 0; n.cool = Math.max(n.cool, HUNTER_REST); n.wp = null; n.nav = {}; }
        quarry = n.quarry || (hostile ? this.nearest(n, 'pirate', HUNTER_DIVERT, o => !o.q) : null);
        if (quarry) {
          if (!n.quarry && d < 1400) this.msg('The pirate hunters turn from you to chase another pirate fleet!', NPC_INFO.hunter.col);
          n.quarry = quarry; hostile = false;
          if ((n.hunt = (n.hunt || 0) + dt) > PATROL_HUNT) {
            quarry = n.quarry = null; n.hunt = 0; n.cool = Math.max(n.cool, HUNTER_REST); n.wp = null; n.nav = {};
            if (d < 1400) this.msg('The pirates have outrun the pirate hunters.', NPC_INFO.pirate.col);
          }
        }
      }
      if (n.trading > 0) { // tied up under the harbour guns, working cargo
        const sh = n.ship; sh.rudder = 0; sh.sail = 0; sh.update(dt, this.wind); sh.speed *= Math.max(0, 1 - dt * 2);
        if (pushOffLand(sh, 14)) sh.speed *= Math.max(0, 1 - dt * 3);
        n.x = sh.x; n.y = sh.y; n.heading = sh.heading;
        n.wing = syncWing(n.wing, sh, n.fleet.slice(1)); followWing(n.wing, sh, dt);
        if ((n.trading -= dt) <= 0) this.trade(n);
        continue;
      }
      const hunted = !hostile && n.kind === 'pirate' ? this.nearest(n, 'patrol', PIRATE_WARY, o => o.quarry === n) || this.nearest(n, 'hunter', PIRATE_WARY, o => o.quarry === n) : null;
      const prey = !hostile && !hunted && n.kind === 'pirate' && this.canRaid(n) ? this.nearest(n, 'merchant', 450, o => o.laden && !o.trading) || this.nearest(n, 'own', 450, o => worthTaking(o.src) && o.src.at == null) : null;
      const threat = hunted || (n.kind === 'merchant' || (n.kind === 'own' && worthTaking(n.src)) ? this.nearest(n, 'pirate', 320, o => this.canRaid(o)) : null);
      let tx, ty;
      if (hostile) { tx = p.x; ty = p.y; }
      else if (quarry) { tx = quarry.x; ty = quarry.y; }
      else if (prey) { tx = prey.x; ty = prey.y; }
      else if (threat) { tx = n.x + wrapDx(n.x - threat.x); ty = n.y + (n.y - threat.y); n.wp = null; } // run for it
      else if (n.kind === 'own') { tx = n.goal.x; ty = n.goal.y; }
      else {
        if (n.kind === 'merchant' && n.wp && PORTS.includes(n.wp) && dist(n.wp, n) < 90) { // made port
          const q = n.charge && s.quests.find(x => x.id === n.q);
          if (q) { q.arrived = true; n.dead = true; this.msg(`The ${q.fleet[0].name} has made ${n.wp.name} safely. Dock there to be paid.`, NPC_INFO.merchant.col); continue; }
          n.trading = rand(6, 10); continue;
        }
        if (!n.wp || dist(n.wp, n) < 70) {
          if (n.kind === 'merchant') n.wp = pick(PORTS);
          else if (n.kind === 'patrol') { const pt = pick(PORTS); n.wp = { x: pt.sx, y: pt.sy }; } // patrol the sea lanes between ports
          else if (n.lair) n.wp = this.nearLair(n); // pirates cruise their own waters
          else n.wp = this.seaPoint(0);
        }
        tx = n.wp.x; ty = n.wp.y;
      }
      n.nav = n.nav || {};
      const way = navSteer(n.nav, n.x, n.y, tx, ty, dt); // around the islands, not into them
      let dx = wrapDx(way.x - n.x), dy = way.y - n.y; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
      { // a gentle shove off any coast we're brushing
        const gap = landSd(n.x, n.y);
        if (gap < 45) { const [ex, ey] = landNormal(n.x, n.y), k = (45 - gap) / 45 * 1.2; dx += ex * k; dy += ey * k; }
      }
      let want = Math.atan2(dy, dx);
      const upwind = this.wind.dir + Math.PI, du = angDiff(want, upwind); // can't sail into the wind: tack
      if (Math.abs(du) < .7) {
        if (Math.abs(du) > .15 && !n.tackHold) n.tack = du > 0 ? 1 : -1;
        const ahead = t => { const a = upwind + t * .8; return clearLine(n.x, n.y, n.x + Math.cos(a) * 160, n.y + Math.sin(a) * 160); };
        if (!ahead(n.tack || 1) && ahead(-(n.tack || 1))) { n.tack = -(n.tack || 1); n.tackHold = 4; } // going about before the shore
        want = upwind + (n.tack || 1) * .8;
      }
      n.tackHold = Math.max(0, (n.tackHold || 0) - dt);
      n.stuckT = (n.stuckT || 0) + dt; // no headway for a while: re-plan, go about, and pick a new heading if wandering
      if (n.stuckT > 4) {
        if (n.stuckAt && dist(n, n.stuckAt) < 50) { n.nav = {}; n.tack = -(n.tack || 1); n.tackHold = 4; if (!hostile && !prey && !quarry && n.kind !== 'merchant' && n.kind !== 'patrol') n.wp = null; }
        n.stuckT = 0; n.stuckAt = { x: n.x, y: n.y };
      }
      const sh = n.ship; // same rudder/sail/wind physics as the player's ship
      sh.rudder = clamp(angDiff(want, sh.heading) * 2.5, -1, 1); sh.sail = 1;
      sh.update(dt, this.wind);
      if (pushOffLand(sh, 14)) sh.speed *= Math.max(0, 1 - dt * 3);
      sh.y = clamp(sh.y, 60, WORLD.H - 60);
      n.x = sh.x; n.y = sh.y; n.heading = sh.heading;
      if (n.kind === 'own') { n.src.x = n.x; n.src.y = n.y; n.src.heading = n.heading; }
      if (prey && !prey.dead && dist(n, prey) < 45) prey.kind === 'own' ? this.raidOwn(n, prey) : this.raid(n, prey);
      if (quarry && !quarry.dead && dist(n, quarry) < 50) this.navyFight(n, quarry);
      this.parts.wake(sh, dt);
      n.wing = syncWing(n.wing, sh, n.fleet.slice(1)); followWing(n.wing, sh, dt, this.parts);
      const near = Math.min(d, ...n.wing.map(w => dist(w, p) + 8)); // brushing any ship of the fleet brings it to battle
      if (near < 52 && n.cool <= 0 && this.safe <= 0 && !n.charge && n.kind !== 'own') { Game.encounter(n); return; }
    }
    this.parts.update(dt);
    for (const m of this.msgs) m.t -= dt;
    this.msgs = this.msgs.filter(m => m.t > 0);

    this.spawnT -= dt;
    if (this.spawnT <= 0) {
      this.spawnT = 2;
      const count = k => this.npcs.filter(n => n.kind === k).length;
      if (count('merchant') < seaFill(16)) this.spawn('merchant');
      if (count('pirate') < seaFill(6 + Math.min(3, Math.floor(renown() / 40)))) this.spawn('pirate');
      const fame = fameOf(s);
      if (count('hunter') < seaFill(Math.min(3, Math.floor(fame / 45)))) this.spawn('hunter');
      if (count('patrol') < seaFill(3 + Math.min(2, Math.floor(fame / 50)))) this.spawn('patrol');
      if (isMerchant() && !s.guild && s.trade >= GUILD_GOAL) {
        s.guild = 1; Sfx.horn(); Campaign.save();
        UI.show(`<h1>A seat on the Guild</h1><p>Your name is good in every counting-house of the Shattered Sea. The <b>Merchant Guild</b> sends its seal and a chain of office: you are named a <b>Master of the Guild</b>.</p><p>You have won. But there are always more cargoes to carry and more pirates to outrun, and the voyage goes on for as long as you wish.</p><div class="row"><button class="primary" data-a="ok">Sail on</button></div>`, () => UI.hide());
      } else if (s.boss === 0 && fame >= FAME_GOAL && !isMerchant()) {
        s.boss = 1; this.spawn('boss'); Sfx.horn();
        UI.show(`<h1>The Admiral puts to sea</h1><p>Your name is cursed in every harbour of the Shattered Sea. <b>Admiral Mordrake</b> has sworn to hang you from the yardarm of his war galleon, the <b>Iron Leviathan</b>, and he does not sail alone.</p><p>Make ready, Captain — repair, recruit, and choose your ground. Sink or seize the Leviathan to rule these waters.</p><div class="row"><button class="primary" data-a="ok">Let him come</button></div>`, () => UI.hide());
      } else if (s.boss === 1 && !count('boss')) this.spawn('boss');
    }
  }

  drawWorld(ctx, x0, y0, x1, y1) { // one copy of the world: the land, ports and what lies at sea, in world space
    const s = Campaign.s, m = 400;
    ctx.strokeStyle = 'rgba(255,255,255,.3)'; ctx.lineWidth = 4; ctx.setLineDash([20, 16]); // the edges of the known world, north and south
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(WORLD.W, 0); ctx.moveTo(0, WORLD.H); ctx.lineTo(WORLD.W, WORLD.H); ctx.stroke(); ctx.setLineDash([]);
    drawLand(ctx, x0, y0, x1, y1);
    for (const pt of PORTS) {
      if (pt.x < x0 - m || pt.x > x1 + m || pt.y < y0 - m || pt.y > y1 + m) continue;
      ctx.save(); ctx.translate(pt.x, pt.y); ctx.rotate(pt.ang);
      ctx.fillStyle = '#6b4423'; ctx.fillRect(-6, -4, 44, 8); // pier
      ctx.fillStyle = '#d9cbb0'; ctx.fillRect(-34, -30, 20, 18); ctx.fillRect(-36, 10, 22, 18); ctx.fillRect(-60, -10, 22, 20);
      ctx.fillStyle = '#9b3b2b'; ctx.fillRect(-34, -30, 20, 7); ctx.fillRect(-36, 10, 22, 7); ctx.fillRect(-60, -10, 22, 8);
      ctx.restore();
      hudText(ctx, '⚓ ' + pt.name + (isShipyard(pt) ? ' ⚒' : '') + propLabel(s, PORTS.indexOf(pt)), pt.x, pt.y - 52, 20, s.hq === PORTS.indexOf(pt) ? '#ffd24a' : '#fff3c4', 'center', true);
    }
    Quests.drawSea(ctx, this);
  }
  draw(ctx, W, H) {
    const z = Game.zoom * .8, p = this.ship, s = Campaign.s;
    drawWater(ctx, p.x, p.y, z, W, H, this.t);
    ctx.save(); ctx.translate(W / 2, H / 2); ctx.scale(z, z); ctx.translate(-p.x, -p.y);
    const vx0 = p.x - W / 2 / z, vx1 = p.x + W / 2 / z, vy0 = p.y - H / 2 / z, vy1 = p.y + H / 2 / z;
    // the world wraps: draw each copy of it that is in view (two, near the 180° line); ships are drawn once, beside you
    for (let c = Math.floor((vx0 - 1500) / WORLD.W); c <= Math.floor((vx1 + 1500) / WORLD.W); c++) {
      const o = c * WORLD.W;
      ctx.save(); ctx.translate(o, 0); this.drawWorld(ctx, vx0 - o, vy0, vx1 - o, vy1); ctx.restore();
    }
    this.parts.draw(ctx, 0);
    for (const n of this.npcs) drawFleetLines(ctx, n.ship, n.wing || [], n.info.col);
    this.wing = syncWing(this.wing, p, wingFleet(s), 'ally'); // ships bought in port show up before the first tick
    this.syncOwn();
    drawFleetLines(ctx, p, this.wing, '#ffd24a');
    for (const w of this.wing) { w.draw(ctx, this.wind); hudText(ctx, w.name + (w.src.hired ? ` (hired · ${Math.max(0, Math.ceil(w.src.hired.until - s.day))}d)` : fleetReady(w.src) ? '' : ' (undermanned)'), w.x, w.y - w.c.len / 2 - 12, 12, fleetReady(w.src) ? '#bfe0a0' : '#ffb0a0', 'center'); }
    for (const n of this.npcs) {
      this.nearYou(n);
      for (const w of n.wing || []) w.draw(ctx, this.wind);
      n.ship.draw(ctx, this.wind);
      if (n.kind === 'own') { const f = n.src; hudText(ctx, `⚑ ${f.name} — ${taskText(f).replace(/ · profit.*/, '')}`, n.x, n.y - n.ship.c.len / 2 - 16, 13, n.info.col, 'center', true); continue; }
      const ql = Quests.label(n);
      if (ql) { hudText(ctx, ql, n.x, n.y - n.ship.c.len / 2 - 16, 14, n.charge ? '#bfe0ff' : '#ffb0a0', 'center', true); continue; }
      hudText(ctx, n.info.label + (n.alert > 0 ? ' (hunting you!)' : n.trading > 0 ? ' (trading)' : n.kind === 'merchant' ? (n.laden ? ` (${goodName(n.fleet[0].loot.good).toLowerCase()})` : ' (in ballast)') : n.laden ? ` (laden with ${goodName(n.fleet[0].loot.good).toLowerCase()})` : '') + (n.fleet.length > 1 ? ` ×${n.fleet.length}` : ''), n.x, n.y - n.ship.c.len / 2 - 16, 14, n.info.col, 'center');
    }
    // a gold label so your own ship stands out from the fleets around it
    const pulse = .5 + .5 * Math.sin(this.t * 3); // also drives the chart marker below
    p.draw(ctx, this.wind);
    hudText(ctx, '★ ' + s.ship.name, p.x, p.y - p.c.len / 2 - 16, 16, '#ffd24a', 'center', true);
    ctx.restore();

    // HUD
    const cap = holdCap(s);
    hudPanel(ctx, 12, 12, 350, 146);
    hudText(ctx, `${s.ship.name} — ${p.c.name}`, 24, 30, 15, '#f5e9c8', 'left', true);
    hudText(ctx, `${isMerchant() ? '⚖ Merchant' : '☠ Pirate'}   Gold aboard ${s.gold}   ${isMerchant() ? `Standing ${s.trade}` : `Fame ${fameOf(s)}`}   Day ${Math.floor(s.day)}`, 24, 52, 14, '#ffd24a');
    hudText(ctx, `Hull ${Math.ceil(s.ship.hull)}/${Campaign.maxHull()}   Sails ${Math.round(s.ship.sailHp)}%   Crew ${s.ship.crew}/${p.maxCrew}`, 24, 74, 13);
    hudText(ctx, `Hold ${holdUsed(s)}/${cap}   Chain ${s.ammo.chain}   Grape ${s.ammo.grape}   Fleet ${this.wing.length}${s.fleet.length > this.wing.length ? ` (+${s.fleet.length - this.wing.length} away)` : ''}`, 24, 94, 13);
    hudText(ctx, `Canvas: ${['Furled', 'Half sail', 'Full sail'][Math.round(p.sail * 2)]}   ${(p.speed / 10).toFixed(1)} kn${this.fishT > 0 ? '   🎣 fishing' : ''}`, 24, 116, 13);
    const P = s.prisoners;
    hudText(ctx, `Jobs ${s.quests.length}${s.maps.length ? `   Maps ${s.maps.length}` : ''}${P.men + P.officers ? `   Prisoners ${P.men + P.officers}` : ''}   (L: log)`, 24, 138, 13);
    const quest = isMerchant() ? (s.guild ? 'You are a Master of the Merchant Guild. Fair winds, Captain.' : `Quest: trade your way to a seat on the Merchant Guild — Standing ${s.trade}/${GUILD_GOAL}`)
      : s.boss === 0 ? `Quest: grow your legend to draw out the Admiral — Fame ${fameOf(s)}/${FAME_GOAL}`
      : s.boss === 1 ? 'Quest: Admiral Mordrake hunts you aboard the Iron Leviathan — sink or seize her!'
        : 'You rule the Shattered Sea. Sail on, Captain.';
    hudText(ctx, quest, W / 2, 24, 15, '#fff3c4', 'center', true);
    hudText(ctx, 'A/D steer · W/S sails · Enter dock · C chart · F fleet orders · L log / save · H help · M mute', 16, H - 16, 12, 'rgba(245,233,200,.75)');
    drawWindRose(ctx, W - 60, 60, this.wind, p.heading);
    drawMessages(ctx, this.msgs, W);
    if (this.nearPort) hudText(ctx, `Press ENTER to dock at ${this.nearPort.name}`, W / 2, H - 70, 22, '#ffd24a', 'center', true);
    if (this.searchWarn) hudText(ctx, 'A navy patrol is close: they will search you and find the contraband!', W / 2, H - 100, 18, '#ff9a8a', 'center', true);
    // chart: it scrolls east–west to keep you in the middle, as the world wraps
    const mw = clamp(W * .26, 240, 340), mh = mw * WORLD.H / WORLD.W, mx = W - mw - 14, my = H - mh - 14, k = mw / WORLD.W;
    const ox = mw / 2 - wrapX(p.x) * k, chartX = x => { const u = (x * k + ox) % mw; return mx + (u < 0 ? u + mw : u); };
    hudPanel(ctx, mx - 4, my - 4, mw + 8, mh + 8);
    ctx.save(); ctx.beginPath(); ctx.rect(mx, my, mw, mh); ctx.clip();
    const ix = ((ox % mw) + mw) % mw;
    ctx.drawImage(chartImage(), mx + ix - mw, my, mw, mh); ctx.drawImage(chartImage(), mx + ix, my, mw, mh);
    for (const pt of PORTS) { ctx.fillStyle = '#ffd24a'; ctx.fillRect(chartX(pt.x) - 2, my + pt.y * k - 2, 4, 4); }
    if (s.hq != null) { // your headquarters: a gold-ringed square
      const h = PORTS[s.hq]; ctx.strokeStyle = '#ffd24a'; ctx.lineWidth = 1.5; ctx.strokeRect(chartX(h.x) - 5.5, my + h.y * k - 5.5, 11, 11);
    }
    for (const n of this.npcs) { ctx.fillStyle = n.info.col; ctx.beginPath(); ctx.arc(chartX(n.x), my + n.y * k, n.kind === 'boss' ? 4 : n.kind === 'own' ? 3 : 2.2, 0, TAU); ctx.fill(); if (n.kind === 'own') { ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.stroke(); } }
    Quests.drawChart(ctx, this, chartX, my, k, pulse);
    ctx.restore();
    { // your ship: a pulsing ring plus a gold arrow pointing along your heading
      const px = chartX(p.x), py = my + p.y * k;
      ctx.strokeStyle = `rgba(255,210,74,${.4 + .5 * pulse})`; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(px, py, 7 + pulse * 3, 0, TAU); ctx.stroke();
      ctx.save(); ctx.translate(px, py); ctx.rotate(p.heading);
      ctx.beginPath(); ctx.moveTo(7, 0); ctx.lineTo(-5, -4.5); ctx.lineTo(-2.5, 0); ctx.lineTo(-5, 4.5); ctx.closePath();
      ctx.fillStyle = '#ffd24a'; ctx.fill(); ctx.strokeStyle = '#000'; ctx.lineWidth = 1.2; ctx.stroke();
      ctx.restore();
    }
  }
}
