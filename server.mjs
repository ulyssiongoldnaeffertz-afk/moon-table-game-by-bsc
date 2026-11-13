import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID, scryptSync, scrypt, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { createAddressResolver } from './client-address.mjs';
import { GAMES } from './game-data.mjs';
import { openSnapshotStorage } from './snapshot-storage.mjs';
import {
  GameError, active, advance, autoStart, boardInfo, buildArchive, check, clearReady, freshRoom,
  play, roomStatus, startGame, transferOwner, updateConfig, viewGame, wolfChatAllowed
} from './rules.mjs';

const deriveKey=promisify(scrypt);
const DIRECTORY = fileURLToPath(new URL('.', import.meta.url));
const ASSETS = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.mjs': ['app.mjs', 'text/javascript; charset=utf-8'],
  '/game-data.mjs': ['game-data.mjs', 'text/javascript; charset=utf-8'],
  '/learning-data.mjs': ['learning-data.mjs', 'text/javascript; charset=utf-8'],
  '/learning.mjs': ['learning.mjs', 'text/javascript; charset=utf-8'],
  '/dom.mjs': ['dom.mjs', 'text/javascript; charset=utf-8'],
  '/composition.mjs': ['composition.mjs', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/werewolf.webp': ['werewolf.webp', 'image/webp'],
  '/avalon.webp': ['avalon.webp', 'image/webp'],
  '/assets/wolf.webp': ['assets/wolf.webp', 'image/webp'],
  '/assets/knight.webp': ['assets/knight.webp', 'image/webp'],
  '/assets/mooncat.webp': ['assets/mooncat.webp', 'image/webp'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json']
};
const ROOM_ID = /^(wolf|avalon)-[123]$/;
const DEVICE = 'moon_device';
const ADMIN = 'moon_admin';
const ONLINE_FOR = 35_000;
const OWNER_FOR = 120_000;
const RECOVERY_FOR = 600_000;
const ADMIN_FOR = 8 * 60 * 60 * 1000;
const TOKEN = /^[a-f0-9]{64}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('hex');

function session(req, key) {
  const raw = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith(key + '='))?.slice(key.length + 1);
  return raw && TOKEN.test(raw) ? hash(raw) : null;
}

function cookie(res, name, value, age, secure) {
  const existing=res.getHeader('Set-Cookie');
  const line=name + '=' + value + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + age + (secure ? '; Secure' : '');
  res.setHeader('Set-Cookie',[...(existing?(Array.isArray(existing)?existing:[existing]):[]),line]);
}

function json(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sameOrigin(req, secure, publicOrigin) {
  const expected = (secure ? 'https://' : 'http://') + req.headers.host;
  const renderUrl = secure && process.env.RENDER_EXTERNAL_URL;
  const trustedOrigin = publicOrigin ? req.headers.origin === publicOrigin
    : req.headers.origin === expected || (renderUrl && req.headers.origin === renderUrl);
  check(trustedOrigin && req.headers['sec-fetch-site'] !== 'cross-site', '请从本站页面提交操作。', 403);
  check(req.headers['content-type']?.split(';')[0] === 'application/json', '请求格式错误。', 415);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 8192) {
      req.resume();
      throw new GameError('请求内容过长。', 413);
    }
    chunks.push(chunk);
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new GameError('请求格式错误。', 400); }
  check(data && typeof data === 'object' && !Array.isArray(data), '请求格式错误。', 400);
  return data;
}

function nickname(value) {
  const name = typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\p{Zs}+/gu, ' ') : '';
  check(name && [...name].length <= 18 && !/[\p{Cc}\p{Cf}]/u.test(name), '请输入 1–18 个字符的有效昵称。', 400);
  return name;
}

const nameKey = name => name.toLocaleLowerCase('zh-CN');
const publicMeta = room => ({
  id: room.id, type: room.type, number: room.number, count: room.seats.length,
  status: room.resetUntil ? 'resetting' : roomStatus(room), min: GAMES[room.type].min, max: GAMES[room.type].max
});

function openStorage(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS matches (
      id TEXT PRIMARY KEY, room TEXT NOT NULL, type TEXT NOT NULL,
      started INTEGER NOT NULL, ended INTEGER NOT NULL, winner TEXT NOT NULL, summary TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS matches_ended ON matches(ended DESC);
    CREATE TABLE IF NOT EXISTS seats (id TEXT PRIMARY KEY, device TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS seats_device ON seats(device);
    CREATE TABLE IF NOT EXISTS match_seats (
      match TEXT NOT NULL REFERENCES matches(id), seat TEXT NOT NULL REFERENCES seats(id),
      PRIMARY KEY (match, seat)
    );
    CREATE INDEX IF NOT EXISTS match_seats_seat ON match_seats(seat);
  `);
  const storeRoom = db.prepare('INSERT INTO rooms (id,state) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state');
  const storeSeat = db.prepare('INSERT INTO seats (id,device) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET device=excluded.device');
  const storeMatch = db.prepare('INSERT OR IGNORE INTO matches (id,room,type,started,ended,winner,summary) VALUES (?,?,?,?,?,?,?)');
  const storeMatchSeat = db.prepare('INSERT OR IGNORE INTO match_seats (match,seat) VALUES (?,?)');
  const loadRoom = db.prepare('SELECT state FROM rooms WHERE id=?');
  const columns = 'id, room, type, started, ended, winner';
  const access = 'EXISTS (SELECT 1 FROM match_seats ms JOIN seats s ON s.id=ms.seat WHERE ms.match=matches.id AND s.device=?)';
  const listMine = db.prepare('SELECT ' + columns + ' FROM matches WHERE ' + access + ' ORDER BY ended DESC,id LIMIT 26 OFFSET ?');
  const listAll = db.prepare('SELECT ' + columns + ' FROM matches ORDER BY ended DESC,id LIMIT 26 OFFSET ?');
  const oneMine = db.prepare('SELECT summary FROM matches WHERE id=? AND ' + access);
  const oneAll = db.prepare('SELECT summary FROM matches WHERE id=?');

  return {
    load(id) {
      const row = loadRoom.get(id);
      return row ? JSON.parse(row.state) : null;
    },
    save(room, archive) {
      db.exec('BEGIN IMMEDIATE');
      try {
        storeRoom.run(room.id, JSON.stringify(room));
        for (const seat of room.seats) storeSeat.run(seat.id, seat.device);
        if (archive) {
          storeMatch.run(archive.id, archive.room, archive.type, archive.startedAt, archive.endedAt,
            archive.outcome.winner, JSON.stringify(archive));
          for (const p of archive.players) storeMatchSeat.run(archive.id, p.id);
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    list(device, admin, offset) {
      const rows = admin ? listAll.all(offset) : device ? listMine.all(device, offset) : [];
      return { rows: rows.slice(0, 25), more: rows.length > 25 };
    },
    match(id, device, admin) {
      const row = admin ? oneAll.get(id) : device ? oneMine.get(id, device) : null;
      return row ? JSON.parse(row.summary) : null;
    },
    health() { db.prepare('SELECT 1').get(); },
    close() { db.close(); }
  };
}

export function createApp({
  dataDir = process.env.DATA_DIR || resolve(DIRECTORY, 'data'),
  adminPassword = process.env.ADMIN_PASSWORD || '',
  secure = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true',
  publicOrigin = process.env.PUBLIC_ORIGIN || '',
  storageDriver = process.env.STORAGE_DRIVER || 'sqlite',
  trustedProxyCidrs = process.env.TRUSTED_PROXY_CIDRS || '',
  clientIPHeader = process.env.CLIENT_IP_HEADER || 'x-forwarded-for',
  now = Date.now,
  clockInterval = 500
} = {}) {
  if (adminPassword && (adminPassword.length < 12 || adminPassword.length > 256)) {
    throw new Error('ADMIN_PASSWORD 必须在 12–256 个字符之间。');
  }
  if (secure && !adminPassword) throw new Error('生产部署需要设置 ADMIN_PASSWORD。');
  if (publicOrigin) {
    const origin = new URL(publicOrigin);
    if (origin.origin !== publicOrigin || (secure && origin.protocol !== 'https:')) throw new Error('PUBLIC_ORIGIN 必须是完整 HTTPS 源地址，不包含路径或结尾斜杠。');
  }
  if (!['sqlite', 'snapshot'].includes(storageDriver)) throw new Error('STORAGE_DRIVER 必须是 sqlite 或 snapshot。');
  const resolveAddress=createAddressResolver(trustedProxyCidrs,clientIPHeader);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const storage = storageDriver === 'snapshot' ? openSnapshotStorage(dataDir) : openStorage(resolve(dataDir, 'moon-table.sqlite'));
  const assets = new Map(Object.entries(ASSETS).map(([url, [filename, mime]]) => [
    url, { mime, data: readFileSync(resolve(DIRECTORY, filename)) }
  ]));
  const booted = now();
  const rooms = new Map();
  for (const type of Object.keys(GAMES)) {
    for (const n of [1, 2, 3]) {
      const base = freshRoom(type, n);
      const saved=storage.load(base.id);
      rooms.set(base.id,saved?{...saved,config:{...base.config,...saved.config}}:base);
    }
  }
  const presence = new Map();
  const chats = new Map();
  const streams = new Set();
  const limits = new Map();
  const adminSessions = new Map();
  let adminJobs=0;
  const salt = randomBytes(16);
  const adminKey = adminPassword ? scryptSync(adminPassword, salt, 32) : null;

  const isOnline = (id, at) => presence.has(id) && at - presence.get(id) <= ONLINE_FOR;
  const seatFor = (room, device) => device && room.seats.find(p => p.device === device);

  function rate(key, limit, duration, at) {
    const entry = limits.get(key);
    if (!entry || at >= entry.expires) {
      limits.set(key, { count: 1, expires: at + duration });
    } else {
      check(entry.count < limit, '操作过于频繁，请稍后再试。', 429);
      entry.count += 1;
    }
  }

  function lobby(device) { return { rooms: [...rooms.values()].map(room => ({ ...publicMeta(room), joined: Boolean(seatFor(room, device)) })) }; }

  function state(room, device, at) {
    const result = { room: publicMeta(room) };
    const seat = seatFor(room, device);
    if (!seat) {
      const request = Object.values(room.recoveries).find(r => r.device === device && r.expires > at);
      if (request) result.recovery = { status: request.status, expires: request.expires };
      return result;
    }
    result.self = { id: seat.id, name: seat.name, owner: room.owner === seat.id };
    result.seats = room.seats.map(p => ({
      id: p.id, name: p.name, avatar:p.avatar??'moon', online: isOnline(p.id, at), ready: p.ready, owner: p.id === room.owner
    }));
    result.config = room.config;
    result.configEpoch = room.configEpoch;
    result.board = boardInfo(room);
    if (room.game) {
      const chat = chats.get(room.id);
      const validChat = chat?.game === room.game.id && chat.day === room.game.wolf?.day ? chat.messages : [];
      result.game = viewGame(room, seat.id, validChat);
    }
    if (result.self.owner) {
      result.requests = Object.entries(room.recoveries).filter(([, r]) => r.status === 'pending' && r.expires > at)
        .map(([id, r]) => ({ id, name: room.seats.find(p => p.id === id)?.name, expires: r.expires }));
    }
    return result;
  }

  function sendStream(stream, at, force = false) {
    const snapshot = stream.room ? state(rooms.get(stream.room), stream.device, at) : lobby(stream.device);
    const signature = JSON.stringify(snapshot);
    if (!force && stream.signature === signature) return;
    stream.signature = signature;
    if (stream.res.writableLength > 131072) {
      stream.res.end();
      return;
    }
    stream.res.write('event: snapshot\ndata: ' + JSON.stringify({ ...snapshot, serverNow: at }) + '\n\n');
  }

  function broadcast(at) {
    for (const stream of streams) sendStream(stream, at);
  }

  function stream(req, res, room, device, at) {
    check(streams.size < 200, '在线连接较多，请稍后重试。', 503);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no'
    });
    const item = { room, device, res, signature: null };
    streams.add(item);
    res.on('close', () => streams.delete(item));
    res.flushHeaders();
    res.write('retry: 1800\n\n');
    sendStream(item, at, true);
  }

  function commit(previous, next, at, aborted = null) {
    const archive = aborted || (next.game?.phase === 'ended' && previous.game?.phase !== 'ended' ? buildArchive(next, at) : null);
    next.revision = previous.revision + 1;
    storage.save(next, archive);
    rooms.set(next.id, next);
    const chat = chats.get(next.id);
    if (chat && (next.game?.id !== chat.game || next.game?.wolf?.day !== chat.day
      || !next.game.players.some(p => wolfChatAllowed(next, p.id)))) chats.delete(next.id);
    for (const p of previous.seats) {
      if (!next.seats.some(s => s.id === p.id)) presence.delete(p.id);
    }
  }

  function maintain(id, at) {
    const previous = rooms.get(id);
    const owner = previous.seats.find(p => p.id === previous.owner);
    const successor = owner && at - Math.max(booted, presence.get(owner.id) ?? owner.joinedAt) >= OWNER_FOR
      ? previous.seats.find(p => p.id !== owner.id && isOnline(p.id, at))
      : null;
    const timedGame = active(previous) && (at >= (previous.game.deadline ?? Infinity)
      || (previous.game.phase === 'night_three' && at >= (previous.game.wolf.night.noticeUntil ?? Infinity)
        && previous.game.wolf.night.canAdvanceEarly));
    const expired = Object.entries(previous.recoveries).filter(([, request]) => request.expires <= at);
    const resetDone = previous.resetUntil && at >= previous.resetUntil;
    if (!successor && !timedGame && !expired.length && !resetDone) return previous;
    const room = structuredClone(previous);
    if (resetDone) delete room.resetUntil;
    if (successor) transferOwner(room, successor.id, at, '原房主离线约 120 秒');
    for (const [seatId] of expired) delete room.recoveries[seatId];
    if (advance(room, at) || successor || expired.length || resetDone) {
      commit(previous, room, at);
      return room;
    }
    return previous;
  }

  function touch(room, device, at) {
    const p = seatFor(room, device);
    if (p) presence.set(p.id, at);
  }

  function seatRemoved(room, id, at) {
    room.seats = room.seats.filter(p => p.id !== id);
    delete room.recoveries[id];
    if (room.owner === id) {
      const successor = room.seats.find(p => isOnline(p.id, at)) ?? room.seats[0];
      transferOwner(room, successor?.id ?? null, at, '原房主离开房间');
    } else if (!room.game) clearReady(room);
    if (!room.seats.length) return freshRoom(room.type, room.number);
    return room;
  }

  function grantRecovery(room, p, device) {
    p.device = device;
    delete room.recoveries[p.id];
  }

  function updateRoom(req, res, id, device, body, at) {
    const previous = maintain(id, at);
    let room = structuredClone(previous);
    check(!room.resetUntil, '房间正在重置，请稍等。');
    const { action, data = {}, gameId, turn } = body;
    check(data && typeof data === 'object' && !Array.isArray(data), '请求数据格式错误。', 400);
    const seat = seatFor(room, device);
    let response = {};
    let newDevice = null;
    let abortArchive = null;
    let touchAfter = seat?.id;
    if (action === 'join' || action === 'recover') {
      check(!seat, '此浏览器已在房间中。');
      const name = nickname(data.name);
      rate('join:' + device + ':' + id, 30, 60_000, at);
      if (!device) {
        newDevice = token();
        device = hash(newDevice);
      }
      if (action === 'join') {
        check(!room.game, '当前对局已锁定。已有座位的玩家可以申请恢复。');
        check(room.seats.length < GAMES[room.type].max, '房间人数已满。');
        check(!room.seats.some(p => nameKey(p.name) === nameKey(name)), '该昵称已被占用。');
        check(data.avatar===undefined || ['moon','wolf','knight','cat'].includes(data.avatar),'请选择可用头像。',400);
        const code = randomBytes(10).toString('hex').toUpperCase();
        const p = { id: randomUUID(), name, avatar:data.avatar??'moon', device, code: hash(code), joinedAt: at, ready: false };
        room.seats.push(p);
        if (!room.owner) room.owner = p.id;
        clearReady(room);
        touchAfter = p.id;
        response = { code };
      } else {
        rate('recover:' + device + ':' + id, 15, 60_000, at);
        const code = typeof data.code === 'string' ? data.code.toUpperCase().replace(/[\s-]/g, '') : '';
        const p = room.seats.find(player => nameKey(player.name) === nameKey(name));
        check(/^[0-9A-F]{20}$/.test(code) && p && timingSafeEqual(Buffer.from(p.code, 'hex'), Buffer.from(hash(code), 'hex')),
          '昵称或恢复码不正确。', 403);
        if (room.owner === p.id) {
          grantRecovery(room, p, device);
          touchAfter = p.id;
        } else {
          for (const [key, request] of Object.entries(room.recoveries)) {
            if (request.device === device) delete room.recoveries[key];
          }
          room.recoveries[p.id] = { device, expires: at + RECOVERY_FOR, status: 'pending' };
        }
      }
    } else {
      check(seat, '请先加入房间或恢复座位。', 403);
      const owner = seat.id === room.owner;
      const requireOwner = () => check(owner, '只有房主能进行此操作。', 403);
      const requireGame = () => check(room.game?.id === gameId && room.game?.turn === turn, '游戏阶段已更新，请按当前页面操作。');
      switch (action) {
        case 'ready':
          check(!room.game && data.epoch === room.configEpoch, '房间设置已更新，请重新确认准备。');
          check(!owner && typeof data.ready === 'boolean', '准备状态无效。', 400);
          seat.ready = data.ready;
          autoStart(room, at);
          break;
        case 'configure':
          requireOwner();
          check(data.epoch === room.configEpoch, '房间人数或配置已更新，请重新编辑。');
          updateConfig(room, data);
          break;
        case 'start':
          requireOwner();
          check(data.confirm === true && data.epoch === room.configEpoch, '请确认当前配置后开局。');
          startGame(room, at, true);
          break;
        case 'leave':
          check(!active(room), '对局进行中会保留座位。');
          room = seatRemoved(room, seat.id, at);
          touchAfter = null;
          break;
        case 'kick':
          requireOwner();
          check(!room.game && data.confirm === true && data.target !== seat.id
            && room.seats.some(p => p.id === data.target), '开局前可确认移除其他玩家。');
          room = seatRemoved(room, data.target, at);
          break;
        case 'next':
          requireOwner();
          requireGame();
          check(room.game.phase === 'ended', '请等待当前对局结束。');
          room.game = null;
          clearReady(room);
          break;
        case 'reset':
          requireOwner();
          check(data.confirm === true && data.epoch === room.configEpoch && (room.game?.id ?? null) === (gameId ?? null)
            && (room.game?.turn ?? null) === (turn ?? null), '状态已变更，请重新确认重置。');
          if (active(room)) abortArchive = buildArchive(room, at, seat.id);
          room = freshRoom(room.type, room.number);
          room.resetUntil = at + 1200;
          touchAfter = null;
          break;
        case 'rotateCode': {
          check(data.avatar===undefined || ['moon','wolf','knight','cat'].includes(data.avatar),'请选择可用头像。',400);
        const code = randomBytes(10).toString('hex').toUpperCase();
          seat.code = hash(code);
          delete room.recoveries[seat.id];
          response = { code };
          break;
        }
        case 'recoveryDecision': {
          requireOwner();
          const p = room.seats.find(player => player.id === data.target);
          const request = p && room.recoveries[p.id];
          check(request?.status === 'pending' && request.expires > at
            && request.expires === data.expires && typeof data.allow === 'boolean', '该恢复申请已处理或过期。');
          if (data.allow) {
            check(!seatFor(room, request.device), '申请设备已经占有一个座位。');
            grantRecovery(room, p, request.device);
            presence.delete(p.id);
          } else request.status = 'denied';
          break;
        }
        case 'wolfChat': {
          requireGame();
          check(wolfChatAllowed(room, seat.id), '当前没有狼队聊天权限。', 403);
          const message = typeof data.message === 'string' ? data.message.trim() : '';
          check(message && [...message].length <= 180 && !/[\p{Cc}\p{Cf}]/u.test(message),
            '请输入 1–180 个字符的单行消息。', 400);
          rate('chat:' + seat.id, 12, 15_000, at);
          const chat = chats.get(room.id) ?? { game: room.game.id, day: room.game.wolf.day, messages: [] };
          chat.messages.push({ id: randomUUID(), from: seat.id, message, at });
          if (chat.messages.length > 80) chat.messages.shift();
          chats.set(room.id, chat);
          touch(room, device, at);
          broadcast(at);
          json(res, { ...state(room, device, at), serverNow: at });
          return;
        }
        default:
          requireGame();
          play(room, seat.id, action, data, at);
      }
    }
    advance(room, at);
    commit(previous, room, at, abortArchive);
    if (touchAfter) presence.set(touchAfter, at);
    if (newDevice) cookie(res, DEVICE, newDevice, 31_536_000, secure);
    broadcast(at);
    json(res, { ...state(room, device, at), ...response, serverNow: at });
  }

  function adminAuthorized(req, at) {
    const key = session(req, ADMIN);
    return key && (adminSessions.get(key) ?? 0) > at;
  }

  function commonHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }

  function maintainAll(at) {
    for (const id of rooms.keys()) maintain(id, at);
  }

  async function route(req, res) {
    commonHeaders(res);
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const at = now();
    let device = session(req, DEVICE);
    if(!device && path!=='/healthz'){
      const address=resolveAddress(req);
      // Coarse issuance protection applies only to a direct client or an explicitly trusted proxy chain.
      if(address.forwarded || !trustedProxyCidrs)rate('issue:'+hash(address.ip),2000,60_000,at);
      const value=token();device=hash(value);cookie(res,DEVICE,value,31_536_000,secure);
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (path === '/healthz') {
        storage.health();
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : 'ok');
        return;
      }
      const asset = assets.get(path);
      if (asset) {
        if (path === '/' && !device && req.method === 'GET') cookie(res, DEVICE, token(), 31_536_000, secure);
        res.writeHead(200, { 'Content-Type': asset.mime, 'Content-Length': asset.data.length,
          'Cache-Control': path === '/' ? 'no-store' : 'no-cache' });
        res.end(req.method === 'HEAD' ? undefined : asset.data);
        return;
      }
      if (req.method === 'HEAD') throw new GameError('页面不存在。', 404);
      if (path === '/api/lobby') {
        maintainAll(at);
        json(res, { ...lobby(device), serverNow: at });
        return;
      }
      if (path === '/api/lobby/stream') {
        maintainAll(at);
        stream(req, res, null, device, at);
        return;
      }
      const roomGet = path.match(/^\/api\/rooms\/([^/]+)(\/stream)?$/);
      if (roomGet && ROOM_ID.test(roomGet[1])) {
        const room = maintain(roomGet[1], at);
        touch(room, device, at);
        if (roomGet[2]) stream(req, res, room.id, device, at);
        else json(res, { ...state(room, device, at), serverNow: at });
        return;
      }
      const admin = path.startsWith('/api/admin/');
      if (path === '/api/admin/status') {
        json(res, { enabled: Boolean(adminKey), authenticated: Boolean(adminAuthorized(req, at)) });
        return;
      }
      if (admin) check(adminAuthorized(req, at), '请先登录开发者后台。', 401);
      if (path === '/api/admin/overview') {
        maintainAll(at);
        const offset = Math.min(100_000, Math.max(0, Number.parseInt(url.searchParams.get('offset'), 10) || 0));
        json(res, { ...lobby(), ...storage.list(device, true, offset), serverNow: at });
        return;
      }
      if (path === '/api/history') {
        const offset = Math.min(100_000, Math.max(0, Number.parseInt(url.searchParams.get('offset'), 10) || 0));
        json(res, storage.list(device, false, offset));
        return;
      }
      const match = path.match(/^\/api\/(?:admin\/)?matches\/([a-f0-9-]{36})(\/export)?$/);
      if (match) {
        check(!match[2] || admin, '没有导出权限。', 403);
        const summary = storage.match(match[1], device, admin);
        check(summary, '未找到可查看的复盘。', 404);
        if (match[2]) res.setHeader('Content-Disposition', 'attachment; filename="moon-table-' + summary.id + '.json"');
        json(res, summary);
        return;
      }
    } else if (req.method === 'POST') {
      sameOrigin(req, secure, publicOrigin);
      const body = await readJson(req);
      const stamp = now();
      const roomPost = path.match(/^\/api\/rooms\/([^/]+)\/actions$/);
      if (roomPost && ROOM_ID.test(roomPost[1])) {
        rate('act:' + device, 150, 20_000, stamp);
        updateRoom(req, res, roomPost[1], device, body, stamp);
        return;
      }
      if (path === '/api/admin/login') {
        check(adminKey, '部署时设置 ADMIN_PASSWORD 后即可启用后台。', 503);
        const loginKey='admin:'+device;
        rate(loginKey,8,300_000,stamp);
        check(typeof body.password==='string' && body.password.length<=256,'管理密码不正确。',401);
        check(adminJobs<4,'后台验证繁忙，请稍后重试。',503);
        adminJobs++;let candidate;
        try{candidate=await deriveKey(body.password,salt,32);}finally{adminJobs--;}
        check(timingSafeEqual(candidate,adminKey),'管理密码不正确。',401);
        adminSessions.delete(session(req, ADMIN));
        const value = token();
        adminSessions.set(hash(value), stamp + ADMIN_FOR);
        limits.delete(loginKey);
        cookie(res, ADMIN, value, ADMIN_FOR / 1000, secure);
        json(res, { authenticated: true });
        return;
      }
      if (path === '/api/admin/logout') {
        adminSessions.delete(session(req, ADMIN));
        cookie(res, ADMIN, '', 0, secure);
        json(res, { authenticated: false });
        return;
      }
    }
    throw new GameError('页面不存在。', 404);
  }

  const server = createServer((req, res) => {
    route(req, res).catch(error => {
      if (res.headersSent || res.destroyed) {
        res.end();
        return;
      }
      if (error instanceof GameError) json(res, { error: error.message }, error.status);
      else {
        // Never log request bodies or database payloads.
        console.error('Request failed:', error.code ?? error.name);
        json(res, { error: '服务器暂时无法完成操作，请重试。' }, 500);
      }
    });
  });

  function tick() {
    const at = now();
    maintainAll(at);
    broadcast(at);
    for (const [key, value] of limits) if (value.expires <= at) limits.delete(key);
    for (const [key, expires] of adminSessions) if (expires <= at) adminSessions.delete(key);
  }
  const clock = clockInterval && setInterval(() => {
    try { tick(); } catch (error) { console.error('Clock update failed:', error.code ?? error.name); }
  }, clockInterval).unref();
  const ping = setInterval(() => {
    for (const stream of streams) {
      if (stream.res.writableLength > 131072) stream.res.end();
      else stream.res.write(': keepalive\n\n');
    }
  }, 10_000).unref();

  return {
    server, tick,
    close() {
      clearInterval(clock);
      clearInterval(ping);
      for (const item of streams) item.res.end();
      return new Promise((done, fail) => {
        server.close(error => {
          storage.close();
          if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') fail(error);
          else done();
        });
      });
    }
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createApp();
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || (process.env.NODE_ENV === 'production' || process.env.RENDER === 'true' ? '0.0.0.0' : '127.0.0.1');
  app.server.listen(port, host, () => console.log('月下圆桌已启动，监听 ' + host + ':' + port));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => app.close().catch(() => process.exitCode = 1));
}
