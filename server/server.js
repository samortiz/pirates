#!/usr/bin/env node
'use strict';
// Corsairs of the Shattered Sea — multiplayer server.
// Serves the game and runs every multiplayer battle (the clients only send orders
// and draw snapshots). No npm dependencies: WebSockets are implemented below.
//
//   node server/server.js            play on this machine (http://localhost:8080)
//   node server/server.js --tunnel   also open a Cloudflare quick tunnel and print a public invite link
//   node server/server.js --lan      also accept players on your local network
//   PORT=9000 node server/server.js  pick another port
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), vm = require('vm');
const { spawn, execFileSync } = require('child_process');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const PORT = +process.env.PORT || 8080;
const TUNNEL = args.includes('--tunnel'), LAN = args.includes('--lan');
const MAX_PLAYERS = 8, MAX_AI = 10, TICK = 1 / 30;

// ---------- load the game's own simulation code ----------
const sandbox = vm.createContext({ console });
for (const f of ['core.js', 'ship.js', 'battle.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), sandbox, { filename: f });
const G = vm.runInContext('({ Battle, Ship, SHIP_CLASSES, SHIP_NAMES, AMMO, GUNS, STANCES, pick, clamp })', sandbox);
const STATE_CODES = ['active', 'sinking', 'sunk', 'surrendered', 'captured', 'escaped'];
const AMMO_KEYS = Object.keys(G.AMMO);

// ---------- static files (only the game's own files are ever served) ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const FILES = new Map([['/', 'index.html'], ['/index.html', 'index.html'], ['/style.css', 'style.css']]);
for (const f of fs.readdirSync(path.join(ROOT, 'js'))) if (f.endsWith('.js')) FILES.set('/js/' + f, 'js/' + f);

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  const file = FILES.get(url);
  if (req.method !== 'GET' || !file) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
  fs.readFile(path.join(ROOT, file), (err, data) => {
    if (err) { res.writeHead(500); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
  });
});

// ---------- minimal WebSocket (RFC 6455) ----------
const MAX_FRAME = 16 * 1024;
class Socket {
  constructor(sock) {
    this.sock = sock; this.buf = Buffer.alloc(0); this.frags = null; this.open = true;
    this.onmessage = () => { }; this.onclose = () => { };
    sock.setNoDelay(true);
    sock.on('data', d => { this.buf = Buffer.concat([this.buf, d]); try { this.parse(); } catch (e) { this.close(); } });
    sock.on('close', () => this.closed());
    sock.on('error', () => this.closed());
    sock.on('end', () => this.closed());
  }
  parse() {
    while (this.open && this.buf.length >= 2) {
      const b0 = this.buf[0], b1 = this.buf[1], fin = b0 & 0x80, op = b0 & 0x0f;
      let len = b1 & 0x7f, off = 2;
      if (!(b1 & 0x80)) return this.close(); // browsers always mask
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; const big = this.buf.readBigUInt64BE(2); if (big > BigInt(MAX_FRAME)) return this.close(); len = Number(big); off = 10; }
      if (len > MAX_FRAME) return this.close();
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4), data = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);
      if (op === 0x8) return this.close();
      if (op === 0x9) { this.frame(0xA, data); continue; }
      if (op === 0xA) continue;
      if (op === 0x1) this.frags = [data];
      else if (op === 0x0 && this.frags) this.frags.push(data);
      else continue; // binary frames are not used
      if (this.frags.reduce((n, f) => n + f.length, 0) > MAX_FRAME) return this.close();
      if (fin) { const msg = Buffer.concat(this.frags).toString('utf8'); this.frags = null; this.onmessage(msg); }
    }
  }
  frame(op, payload) {
    if (!this.open) return;
    const n = payload.length;
    const hdr = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
    if (n >= 126 && n < 65536) { hdr[0] = 0x80 | op; hdr[1] = 126; hdr.writeUInt16BE(n, 2); }
    else if (n >= 65536) { hdr[0] = 0x80 | op; hdr[1] = 127; hdr.writeBigUInt64BE(BigInt(n), 2); }
    this.sock.write(Buffer.concat([hdr, payload]));
  }
  send(str) { this.frame(0x1, Buffer.from(str, 'utf8')); }
  get backlogged() { return this.sock.writableLength > 512 * 1024; }
  close() { if (!this.open) return; try { this.frame(0x8, Buffer.alloc(0)); } catch (e) { } this.sock.end(); this.closed(); }
  closed() { if (!this.open) return; this.open = false; this.sock.destroy(); this.onclose(); }
}
server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if ((req.url || '').split('?')[0] !== '/ws' || !key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { sock.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  join(new Socket(sock), req);
});

// ---------- the room ----------
const players = new Map(); // id -> { id, name, cls, team, host, ws, ship, rate }
let ai = [], phase = 'lobby', battle = null, nextId = 1, invite = null, tickN = 0;

const lobbyState = () => ({
  t: 'lobby', phase, invite, maxAI: MAX_AI,
  players: [...players.values()].filter(p => p.name).map(p => ({ id: p.id, name: p.name, cls: p.cls, team: p.team, host: p.host, gun: p.gun, bow: p.bow, ram: p.ram })),
  ai,
});
function broadcast(obj) { const s = JSON.stringify(obj); for (const p of players.values()) if (p.name) p.ws.send(s); }
const sendLobby = () => broadcast(lobbyState());
function note(p, text) { p.ws.send(JSON.stringify({ t: 'note', text })); }
function fixHost() {
  const named = [...players.values()].filter(p => p.name);
  if (named.length && !named.some(p => p.host)) named[0].host = true;
}
function cleanName(raw, id) {
  let n = String(raw || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 16) || `Captain ${id}`;
  const taken = new Set([...players.values()].map(p => p.name));
  for (let i = 2, base = n.slice(0, 13); taken.has(n); i++) n = `${base} ${i}`;
  return n;
}

function join(ws, req) {
  if (players.size >= MAX_PLAYERS) { ws.send(JSON.stringify({ t: 'note', text: 'The lobby is full.' })); ws.close(); return; }
  const p = { id: nextId++, name: null, cls: 'caravel', team: 0, gun: 'culverin', bow: false, ram: false, host: false, ws, ship: null, rate: { t: Date.now(), n: 0 } };
  players.set(p.id, p);
  log(`connection #${p.id} from ${req.headers['cf-connecting-ip'] || req.socket.remoteAddress}`);
  ws.onmessage = raw => {
    const now = Date.now();
    if (now - p.rate.t > 1000) { p.rate.t = now; p.rate.n = 0; }
    if (++p.rate.n > 120) return; // ignore floods
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m && typeof m === 'object') try { handle(p, m); } catch (e) { log('bad message from #' + p.id + ': ' + e.message); }
  };
  ws.onclose = () => {
    players.delete(p.id);
    if (p.name) log(`${p.name} left`);
    if (p.ship) { p.ship.human = false; p.ship.ai.mode = 'aggr'; p.ship.name += ' (AI)'; } // an AI captain takes the helm
    if (p.host) { p.host = false; fixHost(); }
    if (battle && ![...players.values()].some(q => q.name)) { battle = null; phase = 'lobby'; log('everyone left; battle abandoned'); }
    sendLobby();
  };
}

function handle(p, m) {
  if (m.t === 'hello' && !p.name) {
    p.name = cleanName(m.name, p.id);
    const named = [...players.values()].filter(q => q.name);
    p.team = 0;
    fixHost();
    log(`${p.name} joined${p.host ? ' (host)' : ''}`);
    p.ws.send(JSON.stringify({ t: 'welcome', id: p.id }));
    sendLobby();
    if (battle) p.ws.send(JSON.stringify(startMsg(null)));
    return;
  }
  if (!p.name) return;
  const lobby = phase === 'lobby';
  switch (m.t) {
    case 'set':
      if (!lobby) return;
      if (G.SHIP_CLASSES[m.cls]) p.cls = m.cls;
      if (m.team === 0 || m.team === 1) p.team = m.team;
      if (typeof m.gun === 'string' && Object.prototype.hasOwnProperty.call(G.GUNS, m.gun)) p.gun = m.gun;
      if (typeof m.bow === 'boolean') p.bow = m.bow;
      if (typeof m.ram === 'boolean') p.ram = m.ram;
      sendLobby(); break;
    case 'addAI':
      if (!lobby || !p.host || ai.length >= MAX_AI || !G.SHIP_CLASSES[m.cls] || (m.team !== 0 && m.team !== 1)) return;
      ai.push({ cls: m.cls, team: m.team }); sendLobby(); break;
    case 'delAI':
      if (!lobby || !p.host || !Number.isInteger(m.i) || !ai[m.i]) return;
      ai.splice(m.i, 1); sendLobby(); break;
    case 'start':
      if (lobby && p.host) startBattle(p); break;
    case 'in': {
      const s = p.ship; if (!s || !battle) return;
      const c = s.ctrl;
      if (typeof m.r === 'number' && isFinite(m.r)) c.rudder = G.clamp(m.r, -1, 1);
      if ([0, .5, 1].includes(m.s)) c.sail = m.s;
      if (AMMO_KEYS.includes(m.a) && m.a !== p.lastAmmo) { c.ammo = p.lastAmmo = m.a; } // act on changes only
      if (G.STANCES.includes(m.st)) c.stance = m.st;
      break;
    }
    case 'act': {
      const s = p.ship; if (!s || !battle || !Array.isArray(m.a)) return;
      for (const a of m.a.slice(0, 8)) if (['L', 'R', 'F', 'near', 'board'].includes(a) && s.ctrl.acts.length < 8) s.ctrl.acts.push(a);
      break;
    }
  }
}

// ---------- battles ----------
function startBattle(host) {
  const humans = [...players.values()].filter(p => p.name);
  const teams = [[], []];
  for (const p of humans) teams[p.team].push({ cls: p.cls, style: p.team ? 'rival' : 'player', name: p.name, human: true, pid: p.id, up: { hull: 0, sails: 0, guns: 0 }, stock: { chain: 4, grape: 4 }, gun: p.gun, bow: p.bow, ram: p.ram });
  const used = new Set(humans.map(p => p.name));
  for (const a of ai) {
    const pool = G.SHIP_NAMES[a.team ? 'pirate' : 'ally'].concat(G.SHIP_NAMES.navy).filter(n => !used.has(n));
    const name = pool.length ? G.pick(pool) : `Ship ${used.size + 1}`; used.add(name);
    const guns = Object.keys(G.GUNS); // AI captains come armed every which way
    teams[a.team].push({ cls: a.cls, style: a.team ? 'pirate' : 'ally', name, gun: Math.random() < .5 ? 'culverin' : G.pick(guns), bow: Math.random() < .35, ram: Math.random() < .25 });
  }
  if (!teams[0].length || !teams[1].length) { note(host, 'Each side needs at least one ship.'); return; }
  battle = new G.Battle({ teams, intro: 'Beat to quarters!' });
  for (const s of battle.ships) if (s.src.pid) { const p = players.get(s.src.pid); if (p) p.ship = s; }
  phase = 'battle'; tickN = 0;
  log(`battle started: ${TEAM(0)} ${teams[0].length} ships vs ${TEAM(1)} ${teams[1].length} ships`);
  for (const p of humans) p.ws.send(JSON.stringify(startMsg(p.ship)));
  sendLobby();
}
const TEAM = t => ['Red Banner', 'Black Banner'][t];
function startMsg(you) {
  return {
    t: 'start', R: battle.R, you: you ? you.id : null,
    ships: battle.ships.map(s => ({ id: s.id, cls: s.cls, style: s.styleKey, name: s.name, team: s.team, guns: s.guns, maxHull: s.maxHull, maxCrew: s.maxCrew, reloadBase: s.reloadBase, human: s.human, boss: s.boss, gun: s.gun, bow: s.bow, ram: s.ram })),
  };
}
const r1 = v => Math.round(v * 10) / 10, r3 = v => Math.round(v * 1000) / 1000;
function sendSnapshot() {
  const b = battle, ev = b.events.splice(0);
  const base = {
    t: 'snap', time: r3(b.t), w: [r3(b.wind.dir), r3(b.wind.str)], over: b.over, winner: b.winner,
    s: b.ships.map(s => [r1(s.x), r1(s.y), r3(s.heading), r1(s.speed), s.sail, r1(s.sailHp), r1(s.hull), s.crew,
      STATE_CODES.indexOf(s.state), r3(s.sinkT), r3(s.reload.L), r3(s.reload.R), AMMO_KEYS.indexOf(s.ammo), s.stock ? [s.stock.chain, s.stock.grape] : 0, r3(s.reload.F), r1(s.burn)]),
    g: b.grapples.map(g => [g.a.id, g.b.id, g.log]),
  };
  const common = ev.filter(e => e.to == null), shared = JSON.stringify(Object.assign({ ev: common }, base));
  for (const p of players.values()) {
    if (!p.name || p.ws.backlogged) continue; // a slow link skips a snapshot rather than falling behind
    const mine = p.ship ? ev.filter(e => e.to === p.ship.id) : [];
    p.ws.send(mine.length ? JSON.stringify(Object.assign({}, base, { ev: ev.filter(e => e.to == null || e.to === p.ship.id) })) : shared);
  }
}
function endBattle() {
  const b = battle;
  log(`battle over: ${b.winner == null ? 'no victor' : TEAM(b.winner) + ' wins'}`);
  broadcast({ t: 'end', winner: b.winner, ships: b.ships.map(s => ({ name: s.name, cls: s.cls, team: s.team, state: s.state, human: !!s.src.human })) });
  battle = null; phase = 'lobby';
  for (const p of players.values()) { p.ship = null; p.lastAmmo = null; }
  sendLobby();
}
setInterval(() => {
  if (!battle) return;
  battle.update(TICK);
  if (++tickN % 2 === 0) sendSnapshot(); // 15 snapshots a second
  if (battle.finished) { sendSnapshot(); endBattle(); }
}, TICK * 1000);
// keep idle connections (and the tunnel) alive while sitting in the lobby
setInterval(() => { for (const p of players.values()) p.ws.frame(0x9, Buffer.alloc(0)); }, 25000);

// ---------- Cloudflare quick tunnel ----------
function findCloudflared() {
  const cands = [process.env.CLOUDFLARED, path.join(os.homedir(), '.local/bin/cloudflared'), path.join(ROOT, 'bin/cloudflared')].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  try { execFileSync('cloudflared', ['--version'], { stdio: 'ignore' }); return 'cloudflared'; } catch (e) { return null; }
}
function startTunnel() {
  const bin = findCloudflared();
  if (!bin) { log('cloudflared not found. Install it (see README.md) or set CLOUDFLARED=/path/to/cloudflared.'); return; }
  log('opening Cloudflare quick tunnel…');
  const cf = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  const scan = d => {
    const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && !invite) {
      invite = m[0];
      console.log(`\n  ┌${'─'.repeat(invite.length + 4)}┐\n  │  ${invite}  │   ← send this link to your friend\n  └${'─'.repeat(invite.length + 4)}┘\n  (it can take ~20 seconds before the link starts working)\n`);
      sendLobby();
    }
  };
  cf.stdout.on('data', scan); cf.stderr.on('data', scan);
  cf.on('exit', code => { log(`cloudflared exited (${code}); the invite link no longer works.`); invite = null; sendLobby(); });
  const stop = () => { try { cf.kill(); } catch (e) { } process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

function log(s) { console.log(`[${new Date().toLocaleTimeString()}] ${s}`); }
server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Try PORT=8081 node server/server.js` : e); process.exit(1); });
server.listen(PORT, LAN ? '0.0.0.0' : '127.0.0.1', () => {
  log(`Corsairs server running — open http://localhost:${PORT} and choose "Multiplayer battle"`);
  if (LAN) {
    const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
    log(`players on your network can join at: ${ips.map(ip => `http://${ip}:${PORT}`).join('  ')}`);
  }
  if (TUNNEL) startTunnel();
});
