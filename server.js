// Going, Going, Goal! web server. No dependencies: serves the game and relays live lobby messages.
// The game itself runs in the host's browser; this server only passes state between managers.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const INDEX = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 16 * 1024;
const MAX_PRESENCE = 8 * 1024;
const MAX_PEERS_PER_ROOM = 40;
const MAX_CONNECTIONS = 1000;
const MAX_MSGS_PER_SEC = 80;

const rooms = new Map(); // room name -> Map(peer label -> client)
const clients = new Set();

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(INDEX);
    return;
  }
  res.writeHead(302, { Location: '/' });
  res.end();
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  const isWs = String(req.headers.upgrade || '').toLowerCase() === 'websocket';
  if (!isWs || !key || req.url.split('?')[0] !== '/ws' || clients.size >= MAX_CONNECTIONS) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  const c = { socket, buf: Buffer.alloc(0), frag: [], fragOp: 0, alive: true, room: null, peer: crypto.randomBytes(6).toString('hex'), presence: {}, windowAt: Date.now(), windowN: 0, closed: false };
  clients.add(c);
  socket.on('data', d => onData(c, d));
  socket.on('close', () => drop(c));
  socket.on('error', () => drop(c));
});

function frame(opcode, payload) {
  const n = payload.length;
  let head;
  if (n < 126) head = Buffer.from([0x80 | opcode, n]);
  else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(n, 2); } else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([head, payload]);
}
function sendRaw(c, opcode, payload) {
  if (c.closed || c.socket.destroyed) return;
  if (c.socket.writableLength > 2 * 1024 * 1024) { drop(c); return; } // too far behind to catch up
  c.socket.write(frame(opcode, payload));
}
const sendJson = (c, obj) => sendRaw(c, 1, Buffer.from(JSON.stringify(obj)));

function onData(c, chunk) {
  c.buf = c.buf.length ? Buffer.concat([c.buf, chunk]) : chunk;
  while (!c.closed) {
    const b = c.buf;
    if (b.length < 2) return;
    const fin = !!(b[0] & 0x80), op = b[0] & 0x0f, masked = !!(b[1] & 0x80);
    let len = b[1] & 0x7f, at = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); at = 4; } else if (len === 127) { if (b.length < 10) return; const big = b.readBigUInt64BE(2); if (big > BigInt(MAX_FRAME)) { drop(c); return; } len = Number(big); at = 10; }
    if (len > MAX_FRAME || !masked) { drop(c); return; } // browsers always mask their frames
    if (b.length < at + 4 + len) return;
    const mask = b.subarray(at, at + 4);
    const data = Buffer.from(b.subarray(at + 4, at + 4 + len));
    for (let i = 0; i < len; i++) data[i] ^= mask[i & 3];
    c.buf = b.subarray(at + 4 + len);
    c.alive = true;
    if (op === 8) { sendRaw(c, 8, Buffer.alloc(0)); drop(c); return; }
    if (op === 9) { sendRaw(c, 10, data); continue; }
    if (op === 10) continue;
    if (op === 1 || op === 2) { c.fragOp = op; c.frag = [data]; } else if (op === 0 && c.frag.length) { c.frag.push(data); } else continue;
    const total = c.frag.reduce((t, x) => t + x.length, 0);
    if (total > MAX_FRAME) { drop(c); return; }
    if (fin) { const whole = Buffer.concat(c.frag); c.frag = []; if (c.fragOp === 1) onMessage(c, whole.toString('utf8')); }
  }
}

function broadcast(roomName, obj, except) {
  const room = rooms.get(roomName);
  if (!room) return;
  const payload = Buffer.from(JSON.stringify(obj));
  room.forEach(p => { if (p !== except) sendRaw(p, 1, payload); });
}
const isPlain = v => v && typeof v === 'object' && !Array.isArray(v);
function merged(c, patch) {
  const next = { ...c.presence };
  Object.keys(patch).forEach(k => {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') return;
    if (patch[k] === null) delete next[k]; else next[k] = patch[k];
  });
  return Buffer.byteLength(JSON.stringify(next)) <= MAX_PRESENCE ? next : null;
}
function onMessage(c, text) {
  const now = Date.now();
  if (now - c.windowAt >= 1000) { c.windowAt = now; c.windowN = 0; }
  if (++c.windowN > MAX_MSGS_PER_SEC) return;
  let m;
  try { m = JSON.parse(text); } catch (e) { return; }
  if (!isPlain(m)) return;
  if (m.t === 'join') {
    if (c.room || typeof m.room !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,47}$/.test(m.room)) return;
    let room = rooms.get(m.room);
    if (!room) { room = new Map(); rooms.set(m.room, room); }
    if (room.size >= MAX_PEERS_PER_ROOM) { sendJson(c, { t: 'full' }); return; }
    if (isPlain(m.presence)) c.presence = merged(c, m.presence) || {};
    c.room = m.room;
    const peers = [...room.values()].map(p => ({ peer: p.peer, presence: p.presence }));
    room.set(c.peer, c);
    sendJson(c, { t: 'welcome', peer: c.peer, peers });
    broadcast(c.room, { t: 'peer', peer: c.peer, presence: c.presence }, c);
    return;
  }
  if (m.t === 'p' && c.room && isPlain(m.patch)) {
    const next = merged(c, m.patch);
    if (!next) { sendJson(c, { t: 'toobig' }); return; }
    c.presence = next;
    broadcast(c.room, { t: 'peer', peer: c.peer, presence: c.presence }, c);
    return;
  }
  if (m.t === 'ping') sendJson(c, { t: 'pong' }); // browser traffic that also keeps a free host awake during a game
}
function drop(c) {
  if (c.closed) return;
  c.closed = true;
  clients.delete(c);
  if (c.room) {
    const room = rooms.get(c.room);
    if (room) {
      room.delete(c.peer);
      if (room.size === 0) rooms.delete(c.room);
      else broadcast(c.room, { t: 'left', peer: c.peer });
    }
  }
  try { c.socket.destroy(); } catch (e) { /* already gone */ }
}

// Clear out connections that have silently died.
setInterval(() => {
  clients.forEach(c => {
    if (!c.alive) { drop(c); return; }
    c.alive = false;
    sendRaw(c, 9, Buffer.alloc(0));
  });
}, 30000).unref();

server.listen(PORT, () => console.log(`Going, Going, Goal! running on port ${PORT}`));
