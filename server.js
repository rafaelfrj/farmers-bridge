const express = require('express'), http = require('http'), { Server } = require('socket.io');
const bcrypt = require('bcryptjs'), fs = require('fs'), crypto = require('crypto');
const app = express(); app.use(express.json()); app.use(express.static('public'));
const server = http.createServer(app), io = new Server(server);

/* ---------- Configuração das regras ---------- */
const TURN_MS = 60000, TRICK_PAUSE = 2500, ROUND_PAUSE = 6000, AWAY_MS = 1500;
const SUITS = ['O', 'P', 'C', 'E'];                       // O = Ouros (trunfo)
const RANKS = ['2','3','4','5','6','8','9','10','J','Q','K','7','A']; // do mais fraco ao mais forte
const TRUMP = 'O';
function schedule(n) {
  const a = [];
  if (n === 6) { for (let i = 8; i >= 1; i--) a.push(i); for (let i = 2; i <= 8; i++) a.push(i); return a; }
  const m = n === 4 ? 13 : 10;
  for (let i = 1; i <= m; i++) a.push(i);
  a.push(m, m);                                           // o máximo aparece 3 vezes no total
  return a;
}

/* ---------- Contas ---------- */
const DB = 'users.json'; let users = {};
try { users = JSON.parse(fs.readFileSync(DB)); } catch {}
const saveUsers = () => fs.writeFileSync(DB, JSON.stringify(users));
const sessions = {};
function auth(req, res, register) {
  const { username = '', password = '' } = req.body, u = username.trim();
  if (register) {
    if (!/^[A-Za-z0-9_]{3,16}$/.test(u)) return res.status(400).json({ error: 'Nome: 3 a 16 letras, números ou _' });
    if (password.length < 4) return res.status(400).json({ error: 'Senha com pelo menos 4 caracteres' });
    if (users[u.toLowerCase()]) return res.status(400).json({ error: 'Esse nome já está em uso' });
    users[u.toLowerCase()] = { name: u, hash: bcrypt.hashSync(password, 8) }; saveUsers();
  }
  const rec = users[u.toLowerCase()];
  if (!rec || !bcrypt.compareSync(password, rec.hash)) return res.status(401).json({ error: 'Nome ou senha incorretos' });
  const token = crypto.randomBytes(24).toString('hex'); sessions[token] = rec.name;
  res.json({ token, username: rec.name });
}
app.post('/api/register', (q, s) => auth(q, s, true));
app.post('/api/login', (q, s) => auth(q, s, false));

/* ---------- Salas e jogo ---------- */
const rooms = {}, userRoom = {};
const cs = c => c.slice(-1), cr = c => c.slice(0, -1);
const rk = c => RANKS.indexOf(cr(c));
const newCode = () => { let c; do { c = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.random() * 24 | 0]).join(''); } while (rooms[c]); return c; };

function arm(room, ms) {
  clearTimeout(room.timer); const g = room.g;
  g.dl = Date.now() + ms; room.timer = setTimeout(() => timeout(room), ms);
}
function armTurn(room) {
  const p = room.players[room.g.turn];
  arm(room, p.sid && !p.left ? TURN_MS : AWAY_MS);
}
function legal(g, i) {
  const h = g.hands[i]; if (!g.trick.length) return h.slice();
  const ls = cs(g.trick[0].card), f = h.filter(c => cs(c) === ls);
  return f.length ? f : h.slice();
}
function timeout(room) {
  const g = room.g; if (!g) return;
  if (g.phase === 'bidding') bid(room, g.turn, 0);
  else if (g.phase === 'playing') {
    const l = legal(g, g.turn).sort((a, b) => (cs(a) === TRUMP) - (cs(b) === TRUMP) || rk(a) - rk(b));
    play(room, g.turn, l[0]);
  } else if (g.phase === 'trickEnd') afterTrick(room);
  else if (g.phase === 'roundEnd') startRound(room);
}
function startGame(room) {
  const n = room.size;
  room.rematch = new Set();
  room.g = { rounds: schedule(n), r: -1, dealer: Math.random() * n | 0, scores: Array(n).fill(0), history: [] };
  room.phase = 'game'; startRound(room, true);
}
function startRound(room, first) {
  const g = room.g, n = room.size; g.r++;
  if (g.r >= g.rounds.length) { g.phase = 'over'; clearTimeout(room.timer); g.dl = 0; return push(room); }
  if (!first) g.dealer = (g.dealer + 1) % n;
  const deck = []; for (const s of SUITS) for (const r of RANKS) deck.push(r + s);
  for (let i = deck.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [deck[i], deck[j]] = [deck[j], deck[i]]; }
  const k = g.rounds[g.r];
  g.hands = Array.from({ length: n }, (_, i) => deck.slice(i * k, (i + 1) * k));
  g.bids = Array(n).fill(null); g.won = Array(n).fill(0); g.trick = []; g.winner = null;
  g.phase = 'bidding'; g.turn = (g.dealer + 1) % n; armTurn(room); push(room);
}
function bid(room, i, v) {
  const g = room.g, n = room.size;
  if (g.phase !== 'bidding' || g.turn !== i || !Number.isInteger(v) || v < 0 || v > g.rounds[g.r]) return;
  g.bids[i] = v;
  if (g.bids.every(b => b !== null)) { g.phase = 'playing'; g.turn = (g.dealer + 1) % n; }
  else g.turn = (i + 1) % n;
  armTurn(room); push(room);
}
function play(room, i, card) {
  const g = room.g, n = room.size;
  if (g.phase !== 'playing' || g.turn !== i || !legal(g, i).includes(card)) return;
  g.hands[i].splice(g.hands[i].indexOf(card), 1); g.trick.push({ p: i, card });
  if (g.trick.length < n) { g.turn = (i + 1) % n; armTurn(room); return push(room); }
  const lead = cs(g.trick[0].card);
  const score = c => (cs(c) === TRUMP ? 100 : cs(c) === lead ? 50 : 0) + (cs(c) === TRUMP || cs(c) === lead ? rk(c) : -1);
  g.winner = g.trick.reduce((b, t) => score(t.card) > score(b.card) ? t : b).p;
  g.won[g.winner]++; g.phase = 'trickEnd'; arm(room, TRICK_PAUSE); push(room);
}
function afterTrick(room) {
  const g = room.g;
  if (g.hands[0].length) { g.trick = []; g.turn = g.winner; g.phase = 'playing'; g.winner = null; armTurn(room); return push(room); }
  const pts = g.bids.map((b, i) => g.won[i] === b ? 10 + b : g.won[i]);
  pts.forEach((p, i) => g.scores[i] += p);
  g.history.push({ cards: g.rounds[g.r], bids: g.bids.slice(), won: g.won.slice(), pts, total: g.scores.slice() });
  g.phase = 'roundEnd'; arm(room, ROUND_PAUSE); push(room);
}

/* ---------- Estado enviado a cada jogador (mãos dos outros ficam ocultas) ---------- */
function view(room, i) {
  const g = room.g, v = {
    code: room.code, size: room.size, host: room.players[0].name, you: i,
    players: room.players.map(p => ({ name: p.name, on: !!p.sid && !p.left })),
    phase: room.phase === 'lobby' ? 'lobby' : g.phase,
  };
  if (!g) return v;
  Object.assign(v, {
    dealer: g.dealer, turn: g.turn, left: Math.max(0, g.dl - Date.now()), cards: g.rounds[g.r],
    roundNo: g.r + 1, totalRounds: g.rounds.length, bids: g.bids, won: g.won, scores: g.scores,
    trick: g.trick, winner: g.winner, history: g.history, rematch: [...room.rematch],
    hand: g.hands ? g.hands[i] : [], legal: g.phase === 'playing' && g.turn === i ? legal(g, i) : [],
  });
  return v;
}
function push(room) { room.players.forEach((p, i) => p.sid && io.to(p.sid).emit('state', view(room, i))); }
function drop(room, name) {
  const idx = room.players.findIndex(p => p.name === name); if (idx < 0) return;
  delete userRoom[name];
  if (room.phase === 'lobby') {
    room.players.splice(idx, 1);
    if (!room.players.length) return delete rooms[room.code];
  } else {
    room.players[idx].left = true; room.players[idx].sid = null;
    if (room.players.every(p => p.left)) { clearTimeout(room.timer); return delete rooms[room.code]; }
    room.rematch && room.rematch.delete(name);
  }
  push(room);
}

io.use((s, next) => { const u = sessions[s.handshake.auth.token]; if (!u) return next(new Error('auth')); s.user = u; next(); });
io.on('connection', s => {
  const me = s.user, err = m => s.emit('err', m);
  const room = () => rooms[userRoom[me]];
  const old = room();
  if (old) { const p = old.players.find(p => p.name === me); p.sid = s.id; p.left = false; old.g && old.g.phase === 'playing' && old.g.turn === old.players.indexOf(p) && armTurn(old); push(old); }
  s.on('create', size => {
    if (room()) return err('Você já está em uma sala');
    if (![4, 5, 6].includes(size)) return;
    const code = newCode(); rooms[code] = { code, size, phase: 'lobby', players: [{ name: me, sid: s.id }], rematch: new Set() };
    userRoom[me] = code; push(rooms[code]);
  });
  s.on('join', code => {
    if (room()) return err('Você já está em uma sala');
    const r = rooms[String(code).toUpperCase().trim()];
    if (!r) return err('Sala não encontrada');
    if (r.phase !== 'lobby') return err('A partida já começou');
    if (r.players.length >= r.size) return err('Sala cheia');
    r.players.push({ name: me, sid: s.id }); userRoom[me] = r.code; push(r);
  });
  s.on('start', () => { const r = room(); if (r && r.phase === 'lobby' && r.players[0].name === me && r.players.length === r.size) startGame(r); });
  s.on('bid', v => { const r = room(); r && r.g && bid(r, r.players.findIndex(p => p.name === me), v); });
  s.on('play', c => { const r = room(); r && r.g && play(r, r.players.findIndex(p => p.name === me), c); });
  s.on('rematch', () => {
    const r = room(); if (!r || !r.g || r.g.phase !== 'over') return;
    r.rematch.add(me);
    if (r.rematch.size === r.size) startGame(r); else push(r);
  });
  s.on('leave', () => { const r = room(); if (r) { drop(r, me); s.emit('left'); } });
  s.on('disconnect', () => {
    const r = room(); if (!r) return; const p = r.players.find(p => p.name === me);
    if (p.sid !== s.id) return; p.sid = null;
    if (r.phase === 'lobby') drop(r, me); else push(r);
  });
});
server.listen(process.env.PORT || 3000, () => console.log('Farmer\'s Bridge rodando'));
