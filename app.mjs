import {
  AVALON_COUNTS, AVALON_PRESETS, AVALON_TASKS, GAMES, NIGHT_SCHEDULE, PHASE_NAMES,
  PRACTICE, ROLES, ROOM_STATUS, WOLF_BOARDS, WOLF_KEYS
} from './game-data.mjs';
import { patchHTML } from './dom.mjs';
import { createCompositionGuard } from './composition.mjs';
import { LEARNING, IDENTITY_TIPS } from './learning-data.mjs';
import { createLearningDeck, shuffledOptions } from './learning.mjs';

let learningStorage;
try { learningStorage = sessionStorage; } catch {}
const learningDeck = createLearningDeck({storage:learningStorage});
const learningOptions = new Map();
function lessonContext(g) { return g.id + ':night:' + g.day; }
function lesson(g, kind, renew=false) {
  return learningDeck.draw(g.me.role + ':' + kind, LEARNING[g.me.role][kind], lessonContext(g), renew);
}
function questionOptions(key, question) {
  const signature=key+':'+JSON.stringify(question);
  if (!learningOptions.has(signature)) learningOptions.set(signature,shuffledOptions(question));
  return learningOptions.get(signature);
}

const $ = selector => document.querySelector(selector);
const root = $('#app');
const dialog = $('#dialog');
const dialogContent = $('#dialog-content');
const network = $('#network');
const toast = $('#toast');
const nightPhases = ['night_one', 'night_two', 'night_three'];
const uuidPattern = /^[a-f0-9-]{36}$/;
const labels = { good: '好人胜利', wolf: '狼人胜利', evil: '邪恶阵营胜利', draw: '平局', aborted: '对局中止' };
const causeNames = { bite: '狼刀', poison: '毒药', shot: '猎人开枪', exile: '白天放逐' };
const teamVotes = { yes: '同意', no: '反对' };
const cardNames = { success: '成功', fail: '失败' };
const phaseGuide = ['读取圆桌信息并进行夜间互动', '按当前页面提示完成操作或练习', '等待天亮，随后查看公共结果'];
const roomPattern = /^(wolf|avalon)-[123]$/;

function escape(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function readLocal(key, fallback) {
  try { return JSON.parse(localStorage.getItem('moon.' + key)) ?? fallback; } catch { return fallback; }
}
function writeLocal(key, value) {
  try { localStorage.setItem('moon.' + key, JSON.stringify(value)); } catch { /* The current browser session remains playable. */ }
}

function button(label, action, { kind = '', value = '', disabled = false, pressed, type = 'button', focus = '' } = {}) {
  return `<button class="btn ${kind}" type="${type}"${action ? ' data-act="' + escape(action) + '"' : ''}${value === '' ? '' : ' data-value="' + escape(value) + '"'}${disabled ? ' disabled' : ''}${pressed === undefined ? '' : ' aria-pressed="' + pressed + '"'}${focus ? ' data-focus="' + escape(focus) + '"' : ''}>${escape(label)}</button>`;
}
const link = (label, target, kind = 'ghost') => `<a class="btn ${kind}" href="#${escape(target)}">${escape(label)}</a>`;
const back = (label, target) => `<a class="back-link" href="#${escape(target)}">‹ ${escape(label)}</a>`;
const badge = (label, tone = '') => `<span class="badge" data-tone="${tone}">${escape(label)}</span>`;
const chips = items => `<div class="chips">${items.map(text => `<span class="chip">${escape(text)}</span>`).join('')}</div>`;
const note = (text, tone = '') => `<p class="note ${tone}">${escape(text)}</p>`;
const loading = () => '<div class="loading" role="status">正在获取信息…</div>';
const title = (heading, text = '') => `<header class="page-head"><h1>${escape(heading)}</h1>${text ? '<p class="subtitle">' + escape(text) + '</p>' : ''}</header>`;
const statusBadge = status => badge(ROOM_STATUS[status], { idle: '', waiting: '', ready: 'warn', playing: 'good', ended: 'warn', resetting: 'danger' }[status]);
const selfRole = () => snapshot?.game?.me.role;
const mascot = (name, className = '', alt = '') => `<img class="mascot ${className}" src="/assets/${name}.webp" alt="${alt}" width="400" height="400" decoding="async">`;
const gameMascot = type => type === 'wolf' ? 'wolf' : 'knight';
const gameDescriptions = { wolf: '月色之下，谁藏起了獠牙？', avalon: '举起圣杯，找出圆桌上的暗影。' };
const emptyState = (heading, text, action = '') => `<div class="empty-state">${mascot('mooncat')}<h2>${escape(heading)}</h2><p class="muted small">${escape(text)}</p>${action}</div>`;


let page;
let generation = 0;
let snapshot;
let signature = '';
let stream;
let streamOpen = false;
let lastPoll = 0;
let lastStamp = 0;
let clockOffset = 0;
let busy = false;
let fetching = false;
let errorText = '';
let pageData = null;
let archiveLoading = null;
let cachedArchive = null;
let ui;
let toastTimer;
let dialogKind = '';
let confirmCallback;
let boardDraft;
let settingFocus;
let pendingPoll = false;
const ime=createCompositionGuard();
let compositionSession=null;
function draftScope(){const g=snapshot?.game;return [page?.id,g?.id,g?.day,g?.night?'night':g?.phase].join(':');}

document.documentElement.dataset.reduce = readLocal('reduce', false);
document.documentElement.dataset.large = readLocal('large', false);
let wakeLock;
let identityViews = 0;
async function keepAwake() {
  if (!('wakeLock' in navigator) || document.hidden || !readLocal('awake', false) || !snapshot?.self || !snapshot?.game || snapshot.game.phase === 'ended') {
    if (wakeLock) await wakeLock.release().catch(() => {});
    wakeLock = null;
    return;
  }
  if (!wakeLock || wakeLock.released) {
    try { wakeLock = await navigator.wakeLock.request('screen'); }
    catch { /* Battery saving and browser policy may override this optional preference. */ }
  }
}
function updateConnection() {
  const el = $('#connection');
  const offline = !navigator.onLine;
  const passive = !['lobby','rooms','room'].includes(page?.view);
  el.textContent = offline ? '已离线' : passive ? '圆桌待命' : streamOpen ? '实时同步' : lastStamp ? '在线 · 自动同步' : '正在连接';
  el.dataset.state = offline ? 'offline' : passive ? 'idle' : lastStamp ? 'online' : 'connecting';
}


function notify(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  if (readLocal('haptic', false) && !document.hidden) navigator.vibrate?.(12);
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3600);
}

function showDialog(heading, html, kind = '') {
  dialogKind = kind;
  dialogContent.innerHTML = `<header><h2 id="dialog-title">${escape(heading)}</h2>${button('×', 'close', {kind: 'close', focus: 'dialog-close'})}</header>${html}`;
  dialogContent.querySelector('[data-act=close]').setAttribute('aria-label', '关闭');
  if (!dialog.open) dialog.showModal();
}

function closeDialog() {
  if (dialog.open) dialog.close();
  dialogContent.innerHTML = '';
  dialogKind = '';
  document.body.dataset.private = 'false';
  confirmCallback = null;
}

function confirmAction(heading, text, callback, danger = true, label = '确认') {
  confirmCallback = callback;
  showDialog(heading, `<p class="muted">${escape(text)}</p><div class="actions">${button('取消', 'close', {kind: 'ghost'})}${button(label, 'confirm', {kind: danger ? 'danger' : 'primary'})}</div>`, 'confirm');
  dialogContent.dataset.context = currentRoomContext();
}

function reducedTime(epoch) {
  if (!epoch) return '—';
  return new Date(epoch).toLocaleString('zh-CN', { hour12: false });
}
function clockTime(epoch) {
  return new Date(epoch).toLocaleTimeString('zh-CN', { hour12: false });
}

async function api(path, body) {
  const args = { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(12_000) };
  if (body !== undefined) {
    args.method = 'POST';
    args.headers = { 'Content-Type': 'application/json' };
    args.body = JSON.stringify(body);
  }
  const res = await fetch(path, args);
  let data;
  try { data = await res.json(); } catch { throw new Error('服务器正在启动或返回异常，请稍后重试。'); }
  if (!res.ok) throw new Error(data.error || '请求失败，请稍后重试。');
  return data;
}

function route() {
  const [view, id] = (location.hash.slice(1) || 'lobby').split('/');
  if (view === 'room' && roomPattern.test(id)) return { view, id, type: id.split('-')[0] };
  if (view === 'rooms' && Object.hasOwn(GAMES, id)) return { view, type: id };
  if (['match', 'admin-match'].includes(view) && uuidPattern.test(id)) return { view, id };
  if (['history', 'admin'].includes(view)) return { view, offset: Math.max(0, Math.min(100_000, Number.parseInt(id, 10) || 0)) };
  if (view === 'rules') return { view, type: Object.hasOwn(GAMES, id) ? id : 'wolf' };
  if (view === 'profile') return { view };
  return { view: 'lobby' };
}

function livePath() {
  if (page.view === 'room') return '/api/rooms/' + page.id;
  if (['lobby', 'rooms'].includes(page.view)) return '/api/lobby';
  return null;
}

function setNetwork(message) {
  network.hidden = !message;
  network.innerHTML = message ? `<span>${escape(message)}</span>${button('立即重连', 'reconnect', {kind:'ghost slim'})}` : '';
  updateConnection();
}

function markNav() {
  const key = page.view === 'rules' ? 'rules' : ['lobby', 'rooms', 'room'].includes(page.view) ? 'lobby' : 'profile';
  for (const a of document.querySelectorAll('[data-nav]')) {
    if (a.dataset.nav === key) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

function resetLocalPhase(previous, next) {
  const old = previous?.game;
  const game = next.game;
  if (old?.id !== game?.id || old?.day !== game?.day) learningOptions.clear();
  if (old?.id !== game?.id || old?.turn !== game?.turn) {
    ui.roomTab='action';
    ui.pick = null;
    ui.team = [];
    ui.choice = '';
    ui.draftTouched = false;
    ui.draftTicket = 0;
  }
  if (old?.id !== game?.id || old?.day !== game?.day || !nightPhases.includes(game?.phase)) {
    ui.memo = '';
    ui.chatDraft = '';
    ui.savedMemo = false;
    ui.tab = 'strategy';
    ui.quiz = null;
    ui.term = null;
  }
  if (!next.self && previous?.self) {
    ime.cancel();compositionSession=null;ui.memo='';ui.chatDraft='';
    closeDialog();
    notify('本浏览器的座位已变更。');
  }
}

function accept(data, offset = Date.now()) {
  if (!data || data.serverNow < lastStamp) return;
  lastStamp = data.serverNow;
  if (Number.isFinite(data.serverNow)) clockOffset = data.serverNow - offset;
  const { serverNow, code, ...next } = data;
  const key = JSON.stringify(next);
  if (key === signature) return;
  signature = key;
  const previous = snapshot;
  snapshot = next;
  if(Array.isArray(previous?.game?.me?.chat) && !Array.isArray(next.game?.me?.chat)) {
    // Night chat expires immediately, even if a keyboard composition is in progress.
    ime.cancel();compositionSession=null;ui.chatDraft='';
  }
  if (page.view === 'room') {
    resetLocalPhase(previous, next);
    if (next.self && !previous?.self && next.room.type === 'wolf' && !readLocal('nightIntro', false) && !busy && !dialog.open) {
      writeLocal('nightIntro', true);
      showIntro();
    }
    if (next.game?.phase === 'ended' && cachedArchive?.id !== next.game.id && archiveLoading !== next.game.id) {
      archiveLoading = next.game.id;
      const visit = generation;
      api('/api/matches/' + next.game.id).then(report => {
        if (visit === generation) { cachedArchive = report; paint(); }
      }).catch(() => {});
    }
  }
  paint();
  keepAwake();
  updateConnection();
}

function startStream(path, visit) {
  stream?.close();
  streamOpen = false;
  if (!('EventSource' in window)) return;
  const activeStream = new EventSource(path + '/stream');
  stream = activeStream;
  activeStream.addEventListener('snapshot', event => {
    if (visit !== generation || stream !== activeStream) return;
    streamOpen = true;
    setNetwork('');
    try { accept(JSON.parse(event.data)); } catch { poll(true); }
    updateConnection();
  });
  activeStream.onerror = () => {
    if (visit !== generation || stream !== activeStream) return;
    streamOpen = false;
    updateConnection();
    if (!snapshot) setNetwork('正在重新连接服务器…');
    poll(true);
  };
}

async function poll(force = false) {
  const path = livePath();
  if (!path || pendingPoll || (!force && document.hidden)) return;
  pendingPoll = true;
  const visit = generation;
  const before = Date.now();
  lastPoll = before;
  try {
    const data = await api(path);
    if (visit === generation) {
      setNetwork('');
      accept(data, (before + Date.now()) / 2);
    }
  } catch {
    if (visit === generation) setNetwork('连接中断，正在自动重连。页面会保留上次收到的进度。');
  } finally {
    if (visit === generation) pendingPoll = false;
  }
}

async function loadPage() {
  const visit = generation;
  const { view, id, offset } = page;
  fetching = true;
  errorText = '';
  paint();
  try {
    let result;
    if (view === 'history') result = await api('/api/history?offset=' + offset);
    if (view === 'admin') {
      const status = await api('/api/admin/status');
      result = status.authenticated ? { ...status, ...await api('/api/admin/overview?offset=' + offset) } : status;
    }
    if (view === 'match' || view === 'admin-match') {
      result = await api('/api/' + (view === 'admin-match' ? 'admin/' : '') + 'matches/' + id);
    }
    if (visit === generation) pageData = result;
  } catch (error) {
    if (visit === generation) errorText = error.message;
  } finally {
    if (visit === generation) { fetching = false; paint(); }
  }
}

function navigate() {
  const target = route();
  if (JSON.stringify(target) === JSON.stringify(page)) return;
  ime.cancel();compositionSession=null;
  generation += 1;
  stream?.close();
  stream = null;
  streamOpen = false;
  pendingPoll = false;
  page = target;
  snapshot = null;
  signature = '';
  lastStamp = 0;
  keepAwake();
  pageData = null;
  archiveLoading = null;
  cachedArchive = null;
  errorText = '';
  fetching = false;
  busy = false;
  setNetwork('');
  closeDialog();
  ui = {
    pick: null, team: [], choice: '', memo: '', chatDraft: '', savedMemo: false, draftTouched: false, draftTicket: 0,
    quiz: null, term: null, tab: 'strategy', recover: false, phaseSeen: '', roomTab:'action', avatar:readLocal('avatar','moon')
  };
  markNav();
  document.title = (page.view === 'lobby' ? '好友入座，好戏开场' : page.type ? GAMES[page.type].name : ({rules:'玩法手册',profile:'我的圆桌',history:'对局记录',admin:'开发者管理',match:'对局复盘'}[page.view] || '月下圆桌')) + ' · 月下圆桌';
  window.scrollTo(0, 0);
  paint();
  const path = livePath();
  if (path) { poll(true); startStream(path, generation); }
  else if (['history', 'admin', 'match', 'admin-match'].includes(page.view)) loadPage();
}

function showIntro() {
  showDialog('夜晚，也一起入戏', `${mascot('mooncat','dialog-mascot')}<p>无论拿到什么身份，夜间都可能需要阅读、打字或点击。</p><p class="muted small">这样可以减少从手机动作猜身份，也能帮新朋友熟悉玩法。真正的技能操作只在「夜间行动卡」完成，练习不会影响对局。</p><div class="actions">${button('明白了，一起入座', 'close', {kind: 'primary full'})}</div>`, 'intro');
}
function guideDialog() {
  showDialog('第一次来？一分钟上手', `<div class="guide-intro">${mascot('mooncat')}<p>朋友在身边，手机负责保守秘密。</p></div><ol class="guide-list"><li><strong>选玩法，进同一间房</strong><span>狼人杀 6–12 人，阿瓦隆 5–10 人。点「邀请朋友」分享直达链接。</span></li><li><strong>用昵称入座，保存恢复码</strong><span>第一位入座的朋友是房主，无需注册。换手机时用恢复码找回座位。</span></li><li><strong>确认配置，准备开局</strong><span>人数有效且全员准备就会开始。身份只给自己看，现场面对面讨论。</span></li></ol><div class="actions">${button('准备好入座了', 'close', {kind:'primary full'})}${link('先看看详细规则','rules')}</div>`, 'guide');
}
function privacyScreen() {
  if (!snapshot?.game || snapshot.game.phase === 'ended') return;
  ime.cancel();compositionSession=null;
  closeDialog();
  document.body.dataset.private = 'true';
  showDialog('秘密，先替你收好', `<div class="privacy-screen">${mascot('mooncat')}<h3>屏幕已遮住</h3><p class="muted small">可以放心把手机放下。游戏仍在同步。</p>${button('回到游戏', 'close', {kind:'primary full'})}</div>`, 'privacy');
}

async function send(action, data = {}, { quiet = false, after, draft = false } = {}) {
  if (busy && !draft) return;
  const path = livePath() + '/actions';
  const visit = generation;
  const current = snapshot?.game;
  const body = { action, data, gameId: current?.id, turn: current?.turn };
  if (!draft) {
    busy = true;
    paint();
  }
  const before = Date.now();
  try {
    const result = await api(path, body);
    if (visit !== generation) return;
    accept(result, (before + Date.now()) / 2);
    if (action === 'join' || action === 'recover') startStream(livePath(), visit);
    if (result.code) codeDialog(result.code);
    if (after) after(result);
    if (!quiet && !result.code) notify(action === 'recover' && result.recovery ? '申请已送达房主。' : '操作已确认');
  } catch (error) {
    if (visit === generation) {
      notify(error.message);
      poll(true);
    }
  } finally {
    if (!draft && visit === generation) { busy = false; paint(); }
  }
}

function showRoomHead(room) {
  return `${back('返回房间列表', 'rooms/' + room.type)}<header class="room-head"><div><p class="eyebrow">${GAMES[room.type].name} <span class="tiny">/ ROUND TABLE</span></p><h1>${room.number} 号圆桌</h1><p class="subtitle small">${room.count} / ${room.max} 人 · ${ROOM_STATUS[room.status]}</p></div><div class="actions first">${snapshot?.game && snapshot.game.phase !== 'ended' ? button('暂时遮屏', 'privacy', {kind:'ghost slim'}) : ''}${button('邀请朋友 ↗', 'share', {kind: 'ghost'})}</div></header>`;
}

function home() {
  const rooms = snapshot?.rooms ?? [];
  const joined = rooms.filter(r => r.joined).sort((a,b)=>(b.status==='playing')-(a.status==='playing')).slice(0,1);
  const available = type => rooms.filter(r => r.type === type && ['idle','waiting','ready'].includes(r.status) && r.count < r.max).length;
  return `<section class="home-hero"><div class="hero-copy"><p class="eyebrow"><span class="tiny-star">✦</span> 好友在身边，身份是秘密</p><h1>月光就位，<br><span>好戏开场。</span></h1><p class="hero-description">一张圆桌，两种冒险。<br>把秘密交给手机，把故事留给朋友。</p><div class="hero-meta"><span class="live" data-live="${Boolean(snapshot)}">${snapshot ? '六张圆桌，等你入座' : '正在点亮圆桌'}</span><span class="hero-divider"></span><span>无需注册 · 面对面畅玩</span></div></div><div class="hero-art" aria-hidden="true"><div class="moon-orbit orbit-one"></div><div class="moon-orbit orbit-two"></div><span class="hero-star star-one">✧</span><span class="hero-star star-two">✦</span>${mascot('mooncat','hero-mascot')}<span class="hero-art-caption">GOOD FRIENDS. GREAT STORIES.</span></div></section>
    ${joined.length ? `<section class="resume-strip"><span class="resume-icon" aria-hidden="true">↶</span><div><strong>你的座位还在</strong><span class="muted small">${joined.map(r=>GAMES[r.type].name+' · '+r.number+' 号圆桌').join(' / ')}</span></div><div class="actions first">${joined.map(r=>link('回到'+(joined.length>1?GAMES[r.type].name:'圆桌')+' →','room/'+r.id,'primary slim')).join('')}</div></section>` : ''}
    <div class="section-heading"><div><p class="eyebrow">PICK YOUR STORY</p><h2>今晚，玩哪一场？</h2></div><button class="text-button" data-act="guide">新朋友指南 <span aria-hidden="true">↗</span></button></div>
    <div class="game-grid">${Object.entries(GAMES).map(([id, game],i) => `<a class="game-card theme-${id}" href="#rooms/${id}" aria-label="进入${game.name}，${game.min}至${game.max}人"><span class="card-index">0${i+1} / ${id==='wolf'?'WEREWOLF':'AVALON'}</span><div class="game-card-copy"><div class="game-tags"><span>${game.min}–${game.max} 人</span><span>${id==='wolf'?'阵营推理':'策略博弈'}</span></div><h2>${game.name}</h2><p>${gameDescriptions[id]}</p></div>${mascot(gameMascot(id),'game-mascot')}<div class="card-bottom"><span><span class="availability-dot"></span>${snapshot ? available(id)+' 个房间可入座' : '正在连接圆桌'}</span><strong>选择圆桌 <span class="arrow-disc" aria-hidden="true">↗</span></strong></div></a>`).join('')}</div>
    <section class="start-guide"><div class="guide-heading"><span class="guide-symbol" aria-hidden="true">✧</span><div><h2>相聚很简单</h2><p class="muted small">不用下载，三步就能开场。</p></div></div><ol class="quick-steps"><li><span>01</span><div><strong>选择玩法</strong><small>狼人或骑士，今晚由你定</small></div></li><li><span>02</span><div><strong>同桌入座</strong><small>分享房间链接，填写昵称</small></div></li><li><span>03</span><div><strong>准备开场</strong><small>确认身份，故事正式开始</small></div></li></ol></section>
    <div class="home-foot"><span>小提示：每个人都用自己的手机查看身份。</span><a href="#rules">翻开玩法手册 ↗</a></div>`;
}

function roomsPage(type) {
  const game = GAMES[type];
  const rooms = snapshot?.rooms.filter(r => r.type === type);
  const recommended = rooms?.filter(r=>['idle','waiting','ready'].includes(r.status) && r.count<r.max).sort((a,b)=>b.count-a.count || a.number-b.number)[0];
  return `${back('返回大厅', 'lobby')}<header class="room-banner theme-${type}"><div><p class="eyebrow">${type==='wolf'?'UNDER THE MOON':'FOR THE ROUND TABLE'}</p><h1>${game.name}</h1><p class="subtitle">${gameDescriptions[type]}</p><div class="game-tags"><span>${game.min}–${game.max} 人</span><span>${game.subtitle}</span></div></div>${mascot(gameMascot(type),'banner-mascot')}</header><div class="section-heading"><div><h2>选张圆桌，等朋友来</h2><p class="muted small subtitle">大家记得进入相同的房间号。</p></div>${recommended ? link('找个空位 ↗','room/'+recommended.id,'ghost slim') : ''}</div>
    ${rooms ? `<div class="room-grid">${rooms.map(r => {const locked=['playing','ended','resetting'].includes(r.status);return `<a class="room-tile ${locked?'is-locked':''}" href="#room/${r.id}"><div class="room-row"><span class="room-number">0${r.number}</span>${statusBadge(r.status)}</div><strong>${r.number} 号圆桌 ${r.joined?'<span class="mine-label">你在这里</span>':''}</strong><div class="seat-preview" aria-hidden="true">${Array.from({length:r.max},(_,i)=>`<span class="${i<r.count?'occupied':''}"></span>`).join('')}</div><div class="spread"><span class="muted small">${r.count} / ${r.max} 人${!locked && r.count<r.min?' · 还差 '+(r.min-r.count)+' 人':''}</span><span class="room-enter">${r.joined?'回到座位':locked?'查看房间':'入座'} ↗</span></div></a>`}).join('')}</div>` : loading()}<div class="room-help">${mascot('mooncat')}<div><strong>人齐之前，先把朋友喊来。</strong><p class="muted small">第一位入座的玩家自动成为房主，可以调整配置、分享邀请。开局后名单锁定。</p></div><a class="text-button" href="#rules/${type}">了解玩法 ↗</a></div>`;
}

function joinPanel(s) {
  const r = s.room;
  const locked = ['playing', 'ended', 'resetting'].includes(r.status);
  const recovery = s.recovery;
  if (recovery?.status === 'pending') {
    return `<section class="panel narrow join"><h2>正在等待房主确认</h2><p class="muted">请让房主在房间内的「座位恢复」处理。批准后，此页面会恢复原座位。</p>${note('申请有效至 ' + clockTime(recovery.expires))}</section>`;
  }
  return `<section class="panel narrow join"><div class="join-welcome">${mascot(gameMascot(r.type))}<span class="eyebrow">YOUR SEAT IS WAITING</span></div>
    <h2>${ui.recover ? '欢迎回来，找回你的座位' : '留个昵称，就能入座'}</h2><p class="muted small subtitle">${ui.recover ? '填写原昵称与恢复码，继续这场故事。' : '无需注册。同一房间内，昵称要与朋友不同。'}</p>
    ${recovery?.status === 'denied' ? note('房主拒绝了上一次恢复申请。', 'warn') : ''}
    ${locked && !ui.recover ? note(r.status === 'resetting' ? '房间正在重置，请稍等。' : '座位已锁定。已有座位的玩家可用恢复码申请恢复。', 'warn') : ''}
    ${!locked || ui.recover ? `<form class="fields" data-form="${ui.recover ? 'recover' : 'join'}">${!ui.recover?`<fieldset class="avatar-picker"><legend>选一个圆桌头像</legend>${['moon','wolf','knight','cat'].map(id=>`<button type="button" data-act="choose-avatar" data-value="${id}" aria-label="${({moon:'昵称头像',wolf:'狼人装扮',knight:'骑士装扮',cat:'月亮猫'})[id]}" aria-pressed="${(ui.avatar??readLocal('avatar','moon'))===id}">${avatarImage(id,'☾')}</button>`).join('')}</fieldset><input type="hidden" name="avatar" value="${ui.avatar??readLocal('avatar','moon')}">`: ''}
      <label class="field">本局昵称<input name="name" data-focus="join-name" autocomplete="nickname" required maxlength="36" enterkeyhint="go" spellcheck="false" placeholder="大家怎么称呼你？（1–18 字）" value="${escape(ui.nameDraft ?? readLocal('nickname', ''))}"></label>
      ${ui.recover ? `<label class="field">恢复码<input name="code" data-focus="restore-code" autocomplete="off" autocapitalize="characters" maxlength="30" required value="${escape(ui.codeDraft ?? '')}"></label>` : ''}
      ${button(ui.recover ? '提交恢复申请' : '确认入座 →', '', {type:'submit',kind:'primary full',disabled:busy})}
    </form>` : ''}
    <p class="tiny muted subtitle">首次入座会生成恢复码，请妥善保存。</p><div class="actions">${button(ui.recover ? '返回入座' : '我有恢复码', 'toggle-recover', {kind:'ghost'})}</div>
  </section>`;
}

function roster(s) {
  const list = s.game?.players ?? s.seats;
  return `<section class="panel"><div class="spread"><h2>在座玩家</h2>${badge(list.length + ' 人')}</div>
    <ul class="roster">${list.map((p, i) => {
      const seat = s.seats.find(item => item.id === p.id);
      const marker = seat?.owner ? badge('房主', 'warn') : s.game ? p.alive ? '' : badge('出局') : seat?.ready ? badge('已准备', 'good') : badge('未准备');
      return `<li class="${s.game && !p.alive ? 'dim' : ''} ${p.id === s.self.id ? 'is-self' : ''}"><span class="player-avatar avatar-${i%5}" aria-hidden="true">${escape([...p.name][0])}<small>${i+1}</small></span><span class="person-name">${escape(p.name)}${p.id === s.self.id ? '（你）' : ''}</span>
        <span class="dot ${seat?.online ? 'on' : ''}" title="${seat?.online ? '在线' : '离线'}" aria-label="${seat?.online ? '在线' : '离线'}"></span>${marker}
        ${!s.game && s.self.owner && p.id !== s.self.id ? button('移除', 'kick', {kind:'ghost slim',value:p.id,disabled:busy}) : ''}
      </li>`;
    }).join('')}</ul></section>`;
}

function recoveryPanel(s) {
  const requests = s.requests ?? [];
  return `<section class="panel"><h2>座位恢复</h2><p class="muted small">保管你的恢复码，换设备时使用。</p>
    <div class="actions">${button('生成新恢复码', 'rotate-code', {kind:'ghost',disabled:busy})}</div>
    ${requests.length ? `<ul class="rows">${requests.map(r => `<li><span class="person-name">${escape(r.name)}</span>${button('批准','approve',{value:r.id,kind:'slim',disabled:busy})}${button('拒绝','deny',{value:r.id,kind:'ghost slim',disabled:busy})}</li>`).join('')}</ul>` : ''}</section>`;
}

function roomConfig(s) {
  if (s.room.type === 'wolf') {
    return `${chips([s.config.board ? '自定义板子' : '推荐板子', s.config.winMode === 'edge' ? '屠边' : '屠城', s.config.nightSeconds + ' 秒夜晚',s.config.sheriffEnabled?'警长1.5票':'无警长',s.config.lastWords?'首夜/放逐遗言':'无遗言'])}
      <details data-detail="board"><summary>查看角色配置</summary>
        ${chips(WOLF_KEYS.map((role, i) => ROLES[role].name + ' ' + s.board.counts[i]))}
        <p class="muted small">狼队 ${s.board.wolves} · 好人 ${s.board.good} · 神职 ${s.board.gods} · 平民 ${s.board.villagers} · 共 ${s.board.size} 张。</p>
        <p class="muted small">同守同救失效。重复神职各自行动，女巫药剂独立，猎人击中另一名猎人时不会触发连锁。</p>
      </details>`;
  }
  return `${chips([AVALON_PRESETS[s.config.preset].name, s.board.good + ' 好人', s.board.bad + ' 邪恶',s.room.count>=8&&s.config.ladyEnabled?'湖中仙女':'无仙女'])}
    <details data-detail="board"><summary>查看角色配置</summary>${chips(s.board.roles.map(role => ROLES[role].name))}</details>`;
}

function roomWaiting(s) {
  const me = s.seats.find(p => p.id === s.self.id);
  const ready = s.seats.filter(p=>p.ready).length;
  const missing = Math.max(0, s.room.min-s.room.count);
  const phase = missing ? '还差 '+missing+' 位朋友，就能开场' : s.board.error ? '请房主调整一下配置' : '人已到齐，准备好就开场';
  return `<section class="waiting-progress"><div><p class="eyebrow">BEFORE THE STORY</p><h2>${phase}</h2><p class="muted small">${s.self.owner?'你是房主，配置确认后等待大家准备。':'先看看本局配置，再确认准备。'} 全员准备后自动开局。</p></div><div class="ready-meter"><strong>${ready}<small> / ${s.seats.length}</small></strong><span>已准备</span></div><progress max="${Math.max(s.room.min,s.seats.length)}" value="${ready}" aria-label="准备进度"></progress></section><div class="two-col"><div class="stack">
    <section class="panel"><div class="spread"><h2>本局怎么玩</h2>${badge(s.room.type==='wolf'?'月夜推理':'圆桌任务','warn')}</div><div class="subtitle">${roomConfig(s)}</div>
      ${s.board.error ? note(s.board.error, 'warn') : note('人数与配置有效，等待朋友们确认准备。', 'success')}
      ${(s.board.warnings ?? []).map(w => note(w, 'warn')).join('')}
      <div class="actions waiting-actions">${s.self.owner ? button(s.room.type === 'wolf' ? '调整身份配置' : '选择角色预设', 'settings', {kind:'primary',disabled:busy})+button('提前开局', 'start', {kind:'ghost',disabled:busy || Boolean(s.board.error)}) : button(me.ready ? '已准备 ✓ · 取消' : '我准备好了', 'ready', {kind:me.ready ? 'ghost' : 'primary',disabled:busy})}</div>
      ${s.self.owner?'<p class="tiny muted subtitle">「提前开局」仅跳过准备状态，人数和配置仍需有效。</p>':''}
      ${s.room.type === 'wolf' ? `<details data-detail="night-intro"><summary>为什么夜晚每个人都能操作？</summary><p class="small muted">阅读、练习和打字可以减少手机动作暴露身份。只有「夜间行动卡」里的正式提交会影响对局。</p>${button('看看说明', 'intro', {kind:'ghost slim'})}</details>` : ''}</section>
    ${recoveryPanel(s)}<details class="room-management" data-detail="room-tools"><summary>座位与房间管理</summary><div class="actions">${button('退出座位', 'leave', {kind:'ghost',disabled:busy})}${s.self.owner ? button('重置房间','reset',{kind:'danger',disabled:busy}) : ''}</div></details></div><div class="stack">${roster(s)}<section class="panel invite-card"><span class="eyebrow">BETTER TOGETHER</span><h3>朋友都到齐了吗？</h3><p class="muted small">分享直达链接，省去找房间的时间。</p>${button('邀请朋友入座 ↗','share',{kind:'ghost full'})}</section></div></div>`;
}

function nameIn(players, id) {
  return players.find(p => p.id === id)?.name ?? '—';
}
function nameOf(id) { return nameIn(snapshot?.game?.players ?? snapshot?.seats ?? [], id); }
function aliveIds(g) { return g.players.filter(p => p.alive).map(p => p.id); }
function namesIn(players, ids) { return ids?.length ? ids.map(id => nameIn(players, id)).join('、') : '无'; }

function seatsChoice(game, ids, selected, key = 'pick', disabled = false) {
  if(page.view==='room' && snapshot?.self){const names=Array.isArray(selected)?selected.filter(Boolean).map(nameOf):selected?[nameOf(selected)]:[];return `<div class="selection-hint"><span>${names.length?'已选：'+escape(names.join('、')):'← 点击两侧亮起的头像选择 →'}</span>${key==='team-pick'?'<small>选择 '+snapshot.game.avalon.taskSize+' 人</small>':''}</div>`;}
  return `<div class="options">${game.players.map((p, i) => !ids.includes(p.id) ? '' : `<button type="button" class="option" data-act="${key}" data-value="${p.id}" data-focus="option-${p.id}"
    aria-pressed="${Array.isArray(selected) ? selected.includes(p.id) : selected === p.id}"${disabled ? ' disabled' : ''}><span class="seat-num">${i + 1}</span><span class="person-name">${escape(p.name)}</span></button>`).join('')}</div>`;
}

function stageHead(s) {
  const g = s.game;
  const phaseKey = g.id + ':' + g.turn;
  const fresh = ui.phaseSeen !== phaseKey;
  ui.phaseSeen = phaseKey;
  const av = g.avalon;
  const phase = PHASE_NAMES[g.phase];
  const head = g.outcome ? labels[g.outcome.winner] : g.night ? '夜晚 ' + g.day : g.type === 'wolf' ? '第 ' + g.day + ' 天' : '';
  const stageClass = g.outcome ? 'ended' : g.night ? 'night' : g.phase === 'dawn' ? 'dawn' : av ? 'avalon' : '';
  const caption = g.outcome?.reason ?? (g.night ? '第 ' + g.day + ' 夜 · ' + phase : av ? '第 ' + av.round + ' 项任务' : head);
  const phaseIndex = nightPhases.indexOf(g.phase);
  return `<section class="stage ${stageClass}${fresh ? ' new' : ''}"><div class="spread"><div><p class="eyebrow">${escape(caption)}</p><h2>${escape(g.outcome ? head : g.night ? '夜幕已至' : phase)}</h2></div>
    ${g.night ? `<div><div class="clock" data-clock="${g.night.end}" role="timer" aria-label="夜晚剩余时间">—</div><div class="clock-label">全房间倒计时</div></div>`
      : g.deadline ? `<div><div class="clock" data-clock="${g.deadline}" role="timer">—</div><div class="clock-label">自动继续</div></div>` : ''}
    </div>
    ${g.night ? `<div class="phase-track">${['第一阶段','第二阶段','状态确认'].map((label,i) => `<span class="${i === phaseIndex ? 'current' : ''}">${label}</span>`).join('')}</div>
      <p class="phase-guide">${phaseGuide[phaseIndex]} · 本阶段剩余 <span data-clock="${g.deadline}">—</span></p>` : ''}
  </section>`;
}

function identityPanel(s) {
  const g = s.game;
  return `<section class="panel identity-preview"><div class="identity-card-back" aria-hidden="true"><span>☾</span></div><h2>属于你的秘密，已送达</h2><p class="muted">请单独查看屏幕。身份卡可以在本局随时重看。</p>
    ${s.room.type === 'wolf' ? note('夜间每位玩家都会有可点击、可输入的互动。') : ''}
    <div class="actions">${button(g.me.confirmed ? '重看身份' : '翻开身份卡', 'identity', {kind:'primary'})}</div>
    ${g.me.confirmed ? '<p class="muted small subtitle">你已确认身份，等待其他玩家查看。</p>' : ''}
  </section>`;
}

function showIdentity() {
  const g = snapshot?.game;
  if (!g) return;
  const role = ROLES[g.me.role];
  const intel = g.me.intel;
  const checks = g.me.checks ?? [];
  const reminder = learningDeck.draw(g.me.role+':identity', IDENTITY_TIPS[g.me.role], 'identity:'+Date.now()+':'+(++identityViews));
  const roleCopy = [['能力', role.ability], ['目标', role.goal], ['操作', role.how], ['新手提示', role.tip]];
  showDialog('仅你可见', `<div class="role-sheet">${mascot(gameMascot(g.type),'identity-mascot')}<span class="role-sign" aria-hidden="true">${role.sign}</span><h3>${role.name}</h3>${badge(role.side, role.side === '好人' ? 'good' : 'danger')}</div>
    <div class="role-copy">${roleCopy.map(([key, value]) => `<p><strong>${key}</strong>${escape(value)}</p>`).join('')}</div>
    <aside class="identity-tip"><span class="eyebrow">这一局的小锦囊</span><p>${escape(reminder)}</p></aside>
    ${intel ? `<h3>${intel.label}</h3><p class="muted small">${escape(namesIn(g.players, intel.players))}</p>` : ''}
    ${checks.length ? `<h3>你的查验记录</h3><ul class="rows">${checks.map(c => `<li>第 ${c.day} 夜 · ${escape(nameOf(c.target))} · ${escape(c.camp)}</li>`).join('')}</ul>` : ''}
    <div class="actions">${g.phase === 'identity' && !g.me.confirmed ? button('确认身份','identity-confirm',{kind:'primary'}) : button('收起身份卡','close',{kind:'primary'})}</div>`, 'identity');
}

function wolfDraftStatus(g) {
  return `<details data-detail="wolf-votes"><summary>狼队刀票</summary>
    <ul class="rows">${g.me.wolves.map(w => `<li><span class="person-name">${escape(nameOf(w.id))}</span>
      ${badge(w.locked ? w.target ? '已锁定 · ' + nameOf(w.target) : '已弃权' : w.draft ? '暂选 · ' + nameOf(w.draft) : '未选', w.locked ? 'good' : '')}</li>`).join('')}</ul></details>`;
}

function nightPanel(s) {
  const g = s.game;
  const { me } = g;
  const active = me.canAct && !me.action;
  const role = me.role;
  const wolf = role === 'wolf';
  const witch = role === 'witch';
  const actionLabel = { wolf:'锁定刀票', guard:'确认守护', seer:'确认查验', witch:'确认用毒', hunter:'确认预提交' };
  const instruction = {
    wolf: '选择一名活人作为暂选。你可以改选，也可以选择狼队成员或自己。',
    guard: '可守自己。上一个夜晚守过的人会从列表排除。',
    seer: '选中目标后确认。查验只显示阵营，结果仅你可见。',
    witch: '本夜最多使用一瓶药。守护与解药会冲突，毒药不可抵消。',
    hunter: '你有开枪资格。先选目标或放弃，效果在天亮时统一结算。'
  };
  const waitingTip = learningDeck.draw(role+':waiting', IDENTITY_TIPS[role], lessonContext(g));
  let interaction = `<div class="waiting-tip"><span class="eyebrow">等候时的小锦囊</span><p>${escape(waitingTip)}</p></div>${note('下方还有策略、术语和案例。保持手机在自己视线内，等候阶段推进。')}`;
  if (me.poisoned) interaction = `<p class="note warn">${mascot('mooncat','poison-mascot')}本夜因毒药出局，无法开枪。天亮时会统一播报。</p>`;
  if (me.action) {
    let summary = me.action.kind === 'pass' ? '你已主动放弃本夜行动。' : '你的夜间行动已锁定。';
    if (me.action.kind === 'inspect') summary = '查验结果 · ' + nameOf(me.action.target) + ' 属于' + me.action.camp + '阵营';
    interaction = note(summary, 'success');
    if (me.canAct) {
      interaction += me.nightReady ? note('你已准备天亮。') :
        `<div class="actions">${button('准备天亮','night-ready',{kind:'primary',disabled:busy})}</div>`;
    }
  }
  if (active) {
    const ids = aliveIds(g).filter(id => role === 'guard' ? id !== me.previousGuard : role === 'hunter' ? id !== s.self.id : true);
    const selfDraft = wolf && !ui.draftTouched ? me.wolves.find(w => w.id === s.self.id)?.draft : ui.pick;
    interaction = `<p class="muted small">${instruction[role]}</p>
      ${witch ? chips(['狼刀 · ' + (me.bite ? nameOf(me.bite) : '无'), '解药 ' + (me.potions.save ? '1' : '0'), '毒药 ' + (me.potions.poison ? '1' : '0')]) : ''}
      ${!witch || me.potions.poison ? seatsChoice(g, ids, selfDraft, 'pick', busy) : ''}
      <div class="actions">
      ${witch && me.canSave ? button('使用解药','night-save',{kind:'primary',disabled:busy}) : ''}
      ${!witch || me.potions.poison ? button(actionLabel[role],'night-target',{kind:witch ? '' : 'primary',disabled:busy || !selfDraft}) : ''}
      ${button('主动放弃','night-pass',{kind:'ghost',disabled:busy})}</div>`;
  }
  if (witch && g.phase === 'night_two' && !me.action && !active) {
    interaction = note('狼刀 · ' + (me.bite ? nameOf(me.bite) : '无') + '。你在本夜没有可用药剂。');
  }
  return `<section class="panel"><h2>夜间行动卡</h2>${interaction}
    ${wolf && me.wolves && g.phase === 'night_one' ? wolfDraftStatus(g) : ''}</section>`;
}

function practicePanel(s) {
  const g=s.game;
  const context=lessonContext(g);
  const strategy=lesson(g,'strategies');
  const term=lesson(g,'terms');
  const scenario=lesson(g,'cases');
  const termDistractors=Object.values(LEARNING).flatMap(pool=>pool.terms).filter(item=>item.meaning!==term.meaning);
  const alternatives=questionOptions(context+':distractors:'+term.term,{options:[...new Set(termDistractors.map(item=>item.meaning))],answer:-1}).slice(0,2).map(item=>item.text);
  const termOptions=questionOptions(context+':term',{options:[term.meaning,...alternatives],answer:0});
  const caseOptions=questionOptions(context+':case',scenario);
  const wolfChat=Array.isArray(g.me.chat);
  const tab=ui.tab==='chat' && !wolfChat?'strategy':ui.tab;
  const tabs=[['strategy','策略锦囊'],['terms','术语配对'],['case','情境挑战']];
  // Wolf chat lives in its own room tab, alongside action and learning.
  let content;
  if(tab==='strategy') {
    content=`<span class="lesson-label">本夜思路</span><p>${escape(strategy.background)}</p><p class="lesson-advice"><strong>试试看</strong>${escape(strategy.tactic)}</p><p class="muted small"><strong>新手避坑</strong> · ${escape(strategy.mistake)}</p>`;
  } else if(tab==='terms') {
    content=`<span class="lesson-label">认得这个词，讨论更轻松</span><p class="term-question">「${escape(term.term)}」指什么？</p><div class="learning-choices">${termOptions.map((item,i)=>button(item.text,'term',{kind:'ghost full',value:String(i),pressed:ui.term===i})).join('')}</div>${ui.term===null?'':note(termOptions[ui.term]?.correct?'配对正确 · '+term.meaning:'再想一想。正确含义：'+term.meaning,termOptions[ui.term]?.correct?'success':'warn')}`;
  } else if(tab==='case') {
    content=`<span class="lesson-label">都是虚构示例，与本局秘密无关</span><p>${escape(scenario.case)}</p><div class="learning-choices">${caseOptions.map((item,i)=>button(item.text,'quiz',{kind:'ghost full',value:String(i),pressed:ui.quiz===i})).join('')}</div>${ui.quiz===null?'':note((caseOptions[ui.quiz]?.correct?'答对了。':'一起看规则。')+scenario.feedback,caseOptions[ui.quiz]?.correct?'success':'warn')}`;
  } else {
    content=g.me.chat.length?`<ul class="chat-lines" id="chat-lines" aria-label="狼队消息">${g.me.chat.map(item=>`<li><strong>${escape(nameOf(item.from))}</strong>${escape(item.message)}</li>`).join('')}</ul>`:'<p class="muted small">本夜还没有狼队消息。</p>';
  }
  const form=tab==='chat'?`<form data-form="chat" class="fields"><label class="field">给狼队留言<input name="message" data-focus="wolf-chat" autocomplete="off" maxlength="360" placeholder="仅本夜有权限的狼队可见" required value="${escape(ui.chatDraft)}"></label>${button('发送消息','',{kind:'primary',type:'submit',disabled:busy})}</form>`:`<div class="lesson-controls"><span>同晚保留 · 下夜换新</span>${button('换一条灵感 ↻','next-lesson',{kind:'ghost slim',value:tab})}</div><form data-form="memo" class="fields"><label class="field">${escape(strategy.prompt)}<textarea name="memo" data-focus="memo" rows="2" maxlength="360" placeholder="先写下一个想法，不需要提交给其他人">${escape(ui.memo)}</textarea></label>${button('记下我的思路','',{kind:'ghost',type:'submit'})}${ui.savedMemo?note('已暂存在本机，本夜结束时清除。','success'):'<p class="muted tiny">练习只影响本机反馈，不触发技能、不投票、不进入复盘。</p>'}</form>`;
  return `<section class="panel learning-panel"><div class="spread"><h2>月下小课堂</h2>${button('展开','lesson-read',{kind:'ghost slim'})}${badge('第 '+g.day+' 夜','warn')}</div><p class="muted tiny subtitle">战术是推测，不是系统确认；请结合本桌规则。</p><div class="tab-row">${tabs.map(([id,label])=>button(label,'practice-tab',{value:id,kind:'ghost slim',pressed:id===tab})).join('')}</div><div class="practice-box">${content}</div>${form}</section>`;
}

function selectedDawn(g) {
  return [...g.recent].reverse().find(e => e.kind === 'dawn' && e.day === g.day);
}

function dayPanel(s) {
  const g = s.game;
  const a = g.ballot;
  const owner = s.self.owner;
  if (g.phase === 'dawn') {
    const event = selectedDawn(g);
    return `<section class="panel"><h2>${event?.dead.length ? '昨夜出局' : '昨夜是平安夜'}</h2>
      ${event?.dead.length ? chips(event.dead.map(nameOf)) : '<p class="muted">昨夜无人出局。</p>'}</section>`;
  }
  if (g.phase === 'discussion' || g.phase === 'pk_discussion') {
    const event = selectedDawn(g);
    return `<section class="panel"><h2>${g.phase === 'discussion' ? '现场讨论' : 'PK 候选发言'}</h2>
      ${g.phase === 'discussion' && event ? note(event.dead.length ? '昨夜出局 · ' + event.dead.map(nameOf).join('、') : '昨夜是平安夜。') : ''}
      ${g.phase === 'pk_discussion' ? chips(a.candidates.map(nameOf)) : ''}
      <p class="muted">${g.phase === 'pk_discussion' ? '并列者先发言，其他存活玩家参加第二轮投票。' : '请面对面讨论。讨论完毕后，由房主开启投票。'}</p>
      <div class="actions">${owner ? button(g.phase === 'discussion' ? '开始放逐投票' : '开始 PK 投票','open-vote',{kind:'primary',disabled:busy}) : ''}</div></section>`;
  }
  if (g.phase === 'day_vote' || g.phase === 'pk_vote') {
    const mine = a.submitted ? note(a.mine ? '你的选票已锁定 · ' + nameOf(a.mine) : '你已锁定弃权。','success') : '';
    return `<section class="panel"><div class="spread"><h2>${PHASE_NAMES[g.phase]}</h2>${badge(a.count + ' / ' + a.total + ' 已提交')}</div>
      <p class="muted small subtitle">选票先保密，全部锁定后公布投票关系。</p>
      ${mine || (a.eligible ? seatsChoice(g, a.candidates, ui.pick, 'pick', busy) + `<div class="actions">${button('锁定选票','day-vote',{kind:'primary',disabled:busy || !ui.pick})}${button('弃权','day-pass',{kind:'ghost',disabled:busy})}</div>` : note('你没有本轮投票资格。'))}
      ${owner ? `<div class="actions">${button('跳过当前投票','force',{kind:'danger',disabled:busy})}</div>` : ''}</section>`;
  }
  if (g.phase === 'day_hunter') {
    return `<section class="panel"><h2>等待猎人结算</h2><p class="muted">先完成猎人的行动，再检查胜负。</p>
      ${g.me.canAct ? seatsChoice(g, aliveIds(g), ui.pick, 'pick', busy) + `<div class="actions">
        ${button('确认开枪','day-shot',{kind:'primary',disabled:busy || !ui.pick})}${button('放弃开枪','day-no-shot',{kind:'ghost',disabled:busy})}</div>` : ''}</section>`;
  }
  return `<section class="panel"><h2>放逐已结算</h2><p class="muted">查看公开记录。夜幕即将降临。</p></section>`;
}

function avalonProgress(g) {
  const av = g.avalon;
  return `<section class="panel"><div class="spread"><h2>任务进度</h2>${badge('否决 ' + av.rejects + ' / 5', av.rejects >= 3 ? 'danger' : '')}</div>
    <div class="result-track">${AVALON_TASKS[g.players.length].map((size, i) => {
      const result = av.results.find(r => r.round === i + 1);
      const text = result ? result.passed ? '成功' : '失败' : size + ' 人';
      return `<div class="result-step ${result ? (result.passed ? 'good' : 'bad') : av.round === i + 1 ? 'active' : ''}">${i+1} · ${text}</div>`;
    }).join('')}</div>
    <p class="muted small">本轮需要 ${av.taskSize} 名队员，至少 ${av.threshold} 张失败牌才会判失败。</p></section>`;
}

function avalonPanel(s) {
  const g = s.game;
  const av = g.avalon;
  const owner = s.self.owner;
  if (g.phase === 'nomination') {
    const leading = s.self.id === av.leader;
    return `<section class="panel"><div class="spread"><h2>队长提名</h2>${badge('队长 · ' + nameOf(av.leader),'warn')}</div>
      <p class="muted small subtitle">请选择 ${av.taskSize} 名队员，之后由全员投票。</p>
      ${leading ? seatsChoice(g,g.players.map(p=>p.id),ui.team,'team-pick',busy) + `<div class="actions">${button('提交队伍 '+ui.team.length+' / '+av.taskSize,'nominate',{kind:'primary',disabled:busy || ui.team.length !== av.taskSize})}</div>` : note('正在等候队长选人。')}
      ${owner ? `<div class="actions">${button('跳过本次提名','force',{kind:'danger',disabled:busy})}</div>` : ''}</section>`;
  }
  if (g.phase === 'team_vote') {
    return `<section class="panel"><div class="spread"><h2>组队投票</h2>${badge(av.submitted + ' / ' + g.players.length + ' 已提交')}</div>
      ${chips(av.team.map(nameOf))}<p class="muted small subtitle">过半数同意方可通过。投票结束后会公开每个人的选择。</p>
      ${g.me.teamVote ? note('你的选择已锁定 · ' + teamVotes[g.me.teamVote],'success') : `<div class="actions">
        ${button('同意','choice',{value:'yes',pressed:ui.choice==='yes',disabled:busy})}${button('反对','choice',{value:'no',pressed:ui.choice==='no',disabled:busy})}
        ${button('锁定组队选票','team-vote',{kind:'primary',disabled:busy || !ui.choice})}</div>`}
      ${owner ? `<div class="actions">${button('结束组队投票','force',{kind:'danger',disabled:busy})}</div>` : ''}</section>`;
  }
  if (g.phase === 'mission') {
    const onTeam = av.team.includes(s.self.id);
    const evil = ROLES[g.me.role].side === '邪恶';
    return `<section class="panel"><div class="spread"><h2>秘密出牌</h2>${badge(av.submitted + ' / ' + av.team.length + ' 已提交')}</div>
      ${chips(av.team.map(nameOf))}<p class="muted small subtitle">仅任务队员出牌。结算时公布牌数。</p>
      ${g.me.card ? note('任务牌已锁定 · ' + cardNames[g.me.card],'success') : onTeam ? `<div class="actions">
        ${button('成功牌','choice',{value:'success',pressed:ui.choice==='success',disabled:busy})}
        ${evil ? button('失败牌','choice',{value:'fail',pressed:ui.choice==='fail',disabled:busy}) : ''}
        ${button('锁定任务牌','mission-card',{kind:'primary',disabled:busy || !ui.choice})}</div>` : note('你没有入队，请等待结果。')}
      ${owner ? `<div class="actions">${button('结束任务等待','force',{kind:'danger',disabled:busy})}</div>` : ''}</section>`;
  }
  if (g.phase === 'mission_result') {
    const result = av.results.at(-1);
    return `<section class="panel"><h2>${result.passed ? '任务成功' : '任务失败'}</h2>
      ${chips([result.success + ' 张成功牌', result.fail + ' 张失败牌'])}
      <p class="muted small subtitle">第四轮的双失败阈值适用于 7–10 人局。稍后进入下一阶段。</p></section>`;
  }
  if (g.phase === 'assassination') {
    const isAssassin = g.me.role === 'assassin';
    return `<section class="panel"><h2>刺杀梅林</h2><p class="muted">三次任务已成功。刺客拥有一次选择机会。</p>
      ${isAssassin ? seatsChoice(g,g.players.filter(p => p.id !== s.self.id).map(p=>p.id),ui.pick,'pick',busy) + `<div class="actions">${button('确认刺杀目标','assassinate',{kind:'primary',disabled:busy || !ui.pick})}</div>` : note('请在线下讨论，等待刺客提交。')}
      ${owner ? `<div class="actions">${button('放弃刺杀','force',{kind:'danger',disabled:busy})}</div>` : ''}</section>`;
  }
  return '';
}

function eventText(event, players) {
  const name = id => nameIn(players,id);
  const names = ids => namesIn(players,ids);
  const votes = (rows, text) => Object.entries(rows).map(([who,v]) => name(who) + ' → ' + text(v)).join('；');
  const day = event.day ? '第 ' + event.day + ' 天' : '';
  switch(event.kind) {
    case 'sheriff_elected':return [event.target?'警长当选 · '+name(event.target):'本局无警长',''];
    case 'sheriff_vote':return [event.pk?'警长PK投票结果':'警长投票结果',votes(event.votes,v=>v?name(v):'弃权')];
    case 'badge_transfer':return [event.target?'警徽移交给 '+name(event.target):'警徽已撕毁',''];
    case 'sheriff_flow':return ['警徽流声明 · '+name(event.actor),names(event.targets)+'（玩家声明，不是系统验人）'];
    case 'last_words':return ['遗言时间 · '+name(event.actor),''];
    case 'words_end':return ['遗言结束',name(event.actor)];
    case 'lady_inspect':return ['湖中仙女查验完成',name(event.actor)+' → '+name(event.target)+'；阵营仅查验者可见'];
    case 'lady_result':return ['仙女查验阵营（终局复盘）',name(event.actor)+' 查验 '+name(event.target)+'：'+event.camp];
    case 'start': return [event.forced ? '房主强制开始' : '全员准备后开局', '当时房主 · ' + name(event.owner)];
    case 'night': return ['第 ' + event.day + ' 夜开始',''];
    case 'night_action': {
      const a = event.action;
      const types = { pass:'放弃行动', bite_vote:'提交刀票', guard:'守护', inspect:'查验', save:'解药', poison:'毒药', night_shot:'预提交开枪' };
      return ['第 ' + event.day + ' 夜 · ' + name(event.actor) + ' · ' + types[a.kind], a.target ? name(a.target) + (a.camp ? ' · '+a.camp : '') : ''];
    }
    case 'wolf_bite':
      return [event.target ? '狼刀目标 · ' + name(event.target) : '本夜无狼刀', votes(event.votes, v => v ? name(v) : '弃权')];
    case 'night_resolution':
      return ['夜间伤害与保护结算', '守护 ' + (event.guarded ? '有' : '无') + ' · 解药 ' + (event.saved ? '有' : '无') + ' · 预结算 ' +
        (event.deaths.map(d => name(d.id) + '（' + causeNames[d.cause] + '）').join('、') || '无人出局')];
    case 'dawn': return [day + ' · ' + (event.dead.length ? '昨夜出局 ' + names(event.dead) : '昨夜是平安夜'),''];
    case 'day_vote': return [day + ' · ' + (event.pk ? 'PK 投票' : '放逐投票'),
      votes(event.votes, v => v ? name(v) : '弃权') + (Object.keys(event.tally).length ? ' ｜ 票数 ' + Object.entries(event.tally).map(([id,n]) => name(id)+' '+n).join('、') : '')];
    case 'no_exile': return [day + ' · 无人放逐',event.reason];
    case 'exile': return [day + ' · 放逐 ' + name(event.target),''];
    case 'day_shot': return [event.target ? '猎人开枪 · ' + name(event.target) : '猎人放弃开枪',''];
    case 'team_vote':
      return ['任务 ' + event.round + ' · ' + (event.nominationSkipped ? '提名被跳过' : event.passed ? '组队通过' : '组队否决'),
        '队长 ' + name(event.leader) + ' · 队伍 ' + names(event.team) + (event.nominationSkipped ? '' : ' ｜ ' + votes(event.votes, v => teamVotes[v]))];
    case 'mission_result':
      return ['任务 ' + event.round + ' · ' + (event.passed ? '成功' : '失败'),
        '队长 ' + name(event.leader) + ' · 队伍 ' + names(event.team) + ' · 成功 ' + event.success + ' / 失败 ' + event.fail];
    case 'mission_cards':
      return ['任务 ' + event.round + ' · 任务牌归属', Object.entries(event.cards).map(([id,v]) =>
        name(id) + ' → ' + cardNames[v] + (event.defaults.includes(id) ? '（默认）' : '')).join('；')];
    case 'assassination_open': return ['三次任务成功，进入刺杀阶段',''];
    case 'assassination': return [event.hit ? '刺客命中梅林' : '刺客未命中梅林', '目标 · ' + name(event.target)];
    case 'host_action': return ['房主操作 · ' + event.operation, name(event.actor) + (event.missing.length ? ' · 未提交或未操作 ' + names(event.missing) : '')];
    case 'owner_change': return ['房主转交 · ' + name(event.target), event.reason];
    case 'finish': return [labels[event.winner],event.reason];
    default: return ['游戏事件',''];
  }
}

function timeline(events, players) {
  return `<ol class="timeline">${events.map(event => {
    const [main,detail] = eventText(event,players);
    return `<li><span class="event-time">${clockTime(event.at)}</span><strong>${escape(main)}</strong>${detail ? '<span class="event-detail">' + escape(detail) + '</span>' : ''}</li>`;
  }).join('')}</ol>`;
}

function playersSummary(report) {
  if (!report?.players.some(p => p.role)) return '';
  return `<section class="panel"><h2>身份揭晓</h2><ul class="roster">
    ${report.players.map((p,i) => `<li><span class="seat-num">${i+1}</span><span class="person-name">${escape(p.name)}</span>${badge(ROLES[p.role].name,ROLES[p.role].side==='好人'?'good':'warn')}</li>`).join('')}</ul></section>`;
}

function gameRoom(s) {
  const g = s.game;
  let panels;
  if (g.phase === 'ended') {
    panels = `<section class="panel"><h2>本局复盘</h2><p class="muted">查看身份、死亡顺序和对局记录。</p><div class="actions">
      ${link('查看完整复盘','match/'+g.id,'primary')}${s.self.owner ? button('保留座位再来一局','next',{disabled:busy}) : ''}
      ${link('返回大厅','lobby')}${button('退出座位','leave',{kind:'ghost',disabled:busy})}</div></section>
      ${playersSummary(cachedArchive)}`;
  } else if (g.phase === 'identity') {
    panels = identityPanel(s);
  } else if (g.night) {
    panels = g.me.alive ? nightPanel(s) + practicePanel(s) : `<section class="panel"><h2>旁观夜间进度</h2><p class="muted">你已出局，仍可查看天亮后的公开结果。</p></section>`;
  } else if (g.avalon) {
    panels = avalonProgress(g) + avalonPanel(s);
  } else {
    panels = dayPanel(s);
  }
  return `${stageHead(s)}<div class="two-col">
    <div class="stack">${panels}${g.phase !== 'ended' && g.phase !== 'identity' ? `<div class="actions first">${button('查看身份','identity',{kind:'ghost'})}</div>` : ''}
    ${g.recent.length ? `<section class="panel"><h2>公开记录</h2>${timeline(g.recent.slice(-4).reverse(),g.players)}
      ${g.recent.length > 4 ? `<details data-detail="timeline"><summary>较早记录</summary>${timeline(g.recent.slice(0,-4).reverse(),g.players)}</details>` : ''}</section>` : ''}
    </div><div class="stack">${roster(s)}${recoveryPanel(s)}${s.self.owner ? `<div class="actions first">${button('重置房间','reset',{kind:'danger',disabled:busy})}</div>` : ''}</div></div>`;
}

function avatarImage(avatar, name, className='') {
  const file={wolf:'wolf',knight:'knight',cat:'mooncat'}[avatar];
  return file ? `<img class="seat-art ${className}" src="/assets/${file}.webp" alt="" width="56" height="56">` : `<span class="seat-initial ${className}" aria-hidden="true">${escape(name?[...name][0]:'☾')}</span>`;
}
function skullIcon() {
  return '<svg class="skull-icon" viewBox="0 0 48 48" aria-hidden="true"><path d="M9 21C9 10 16 5 24 5s15 5 15 16c0 7-4 11-9 13v7H18v-7c-5-2-9-6-9-13Z" fill="#eee1cc" stroke="#675f70" stroke-width="2"/><ellipse cx="18" cy="22" rx="4" ry="5" fill="#62586e"/><ellipse cx="30" cy="22" rx="4" ry="5" fill="#62586e"/><path d="m24 27-3 5h6Z" fill="#8b8094"/><path d="M22 36v5m4-5v5" stroke="#8b8094" stroke-width="2"/><path d="m8 9 2-4m28 4 2-4" stroke="#e7c98c" stroke-width="2" stroke-linecap="round"/></svg>';
}
function seatInteraction(s) {
  const g=s.game;if(!g)return {ids:[],key:'',selected:[]};
  if(g.night && g.me.canAct && !g.me.action) {
    const role=g.me.role;
    if(role==='witch' && !g.me.potions.poison)return {ids:[],key:'',selected:[]};
    const ids=aliveIds(g).filter(id=>role==='guard'?id!==g.me.previousGuard:role==='hunter'?id!==s.self.id:true);
    const draft=role==='wolf'&&!ui.draftTouched?g.me.wolves?.find(w=>w.id===s.self.id)?.draft:ui.pick;
    return {ids,key:'pick',selected:[draft]};
  }
  if(['day_vote','pk_vote'].includes(g.phase) && g.ballot.eligible && !g.ballot.submitted)return {ids:g.ballot.candidates,key:'pick',selected:[ui.pick]};
  if(g.phase==='day_hunter' && g.me.canAct)return {ids:aliveIds(g),key:'pick',selected:[ui.pick]};
  if(g.phase==='nomination' && g.avalon.leader===s.self.id)return {ids:g.players.map(p=>p.id),key:'team-pick',selected:ui.team};
  if(g.phase==='assassination' && g.me.role==='assassin')return {ids:g.players.filter(p=>p.id!==s.self.id).map(p=>p.id),key:'pick',selected:[ui.pick]};
  if(['sheriff_vote','sheriff_pk_vote'].includes(g.phase) && g.election.eligible && !g.election.submitted)return {ids:g.election.candidates,key:'pick',selected:[ui.pick]};
  if(g.phase==='badge_transfer' && g.badgeActor===s.self.id)return {ids:aliveIds(g),key:'pick',selected:[ui.pick]};
  if(g.phase==='lady_lake' && g.avalon.lady.holder===s.self.id)return {ids:g.avalon.lady.eligible,key:'pick',selected:[ui.pick]};
  return {ids:[],key:'',selected:[]};
}
function seatRails(s) {
  const players=s.game?.players??s.seats;
  const count=s.game?players.length:s.room.max;
  const middle=Math.ceil(count/2),choice=seatInteraction(s);
  const cells=Array.from({length:count},(_,i)=>{
    const p=players[i];if(!p)return `<div class="table-seat empty-seat" data-key="empty-${i}"><span class="seat-portrait"><span>＋</span><small>${i+1}</small></span><span class="seat-name">等朋友</span></div>`;
    const seat=s.seats.find(x=>x.id===p.id);const dead=s.game&&!p.alive;
    const selected=choice.selected.includes(p.id),eligible=choice.ids.includes(p.id);
    const special=[p.id===s.game?.sheriff?.holder?'警长':null,p.id===s.game?.avalon?.leader?'队长':null,p.id===s.game?.avalon?.lady?.holder?'仙女':null].filter(Boolean).join(' · ');
    const exit=dead?(p.exit==='exile'?'流放':p.exit==='shot'?'带走':'夜殁'):'';
    return `<button type="button" class="table-seat avatar-${i%5}${dead?' is-dead':''}${p.id===s.self.id?' is-me':''}${selected?' is-selected':''}${eligible?' is-eligible':''}" data-key="seat-${p.id}" data-act="${eligible?choice.key:'seat-info'}" data-value="${p.id}" aria-pressed="${selected}" aria-label="${i+1}号 ${escape(p.name)}${special?'，'+special:''}${dead?'，'+exit:''}" title="${escape(p.name)}"><span class="seat-portrait">${avatarImage(p.avatar,p.name)}<small class="seat-number">${i+1}</small>${special?`<span class="seat-office">${special}</span>`:''}${dead?`<span class="seat-death">${p.exit==='exile'?'<span class="exile-stamp">流放</span>':skullIcon()}</span>`:''}${!s.game?`<span class="ready-dot ${seat?.ready?'ready':''}" aria-label="${seat?.ready?'已准备':'未准备'}"></span>`:''}${selected?'<span class="seat-check">✓</span>':''}</span><span class="seat-name">${escape(p.name)}</span>${!seat?.online?'<span class="offline-mark">离线</span>':''}</button>`;
  });
  const rail=(items,side)=>`<aside class="seat-rail ${side} rows-${middle}" aria-label="${side==='left'?'左':'右'}侧玩家">${items.join('')}</aside>`;
  return {left:rail(cells.slice(0,middle),'left'),right:rail(cells.slice(middle),'right')};
}
function compactStage(s) {
  const g=s.game;
  if(!g)return `<header class="table-status" data-key="table-status"><span class="eyebrow">准备入座</span><h2>${s.room.count} / ${s.room.max} 人</h2><small>准备 ${s.seats.filter(p=>p.ready).length} / ${s.seats.length}</small></header>`;
  const time=g.night?.end??g.deadline;
  const caption=g.outcome?labels[g.outcome.winner]:PHASE_NAMES[g.phase];
  return `<header class="table-status" data-key="table-status"><span class="eyebrow">${g.type==='wolf'?'第 '+g.day+' '+(g.night?'夜':'天'):'第 '+g.avalon.round+' 项任务'}</span><h2>${escape(caption)}</h2>${time?`<span class="table-clock" data-clock="${time}" role="timer" aria-label="阶段剩余时间">—</span>`:''}${g.sheriff?.holder?`<small>警长 ${escape(nameOf(g.sheriff.holder))} · 1.5 票</small>`:''}</header>`;
}
function publicMessage(s) {
  if(!s.game)return '朋友们进入同一圆桌，确认配置后准备开场。';
  const g=s.game;
  if(g.phase==='last_words')return nameOf(g.wordsActor)+' 正在发表遗言，其他玩家请耐心听完。';
  if(g.phase==='badge_transfer')return nameOf(g.badgeActor)+' 正在移交或撕毁警徽。';
  if(g.phase.startsWith('sheriff_'))return '首夜结果尚未公布，先完成警长竞选。警下选民每人 1 票。';
  const recent=g.recent.filter(e=>!['night','start','words_end'].includes(e.kind)).at(-1);
  if(recent){const [main]=eventText(recent,g.players);return main;}
  return g.night?'夜幕降临。按行动卡操作，完成后可阅读小课堂。':'请面对面讨论，秘密身份只给自己看。';
}
function sheriffPanel(s) {
  const g=s.game,e=g.election,phase=g.phase;
  if(phase==='last_words')return `<section class="panel" data-key="action-panel"><h2>请 ${escape(nameOf(g.wordsActor))} 发言</h2><p class="muted small">首夜出局与白天放逐有遗言；其他夜晚默认没有。倒计时结束后自动继续。</p><div class="actions">${g.wordsActor===s.self.id?button('我的遗言结束了','words-done',{kind:'primary full',disabled:busy}):''}</div></section>`;
  if(phase==='badge_transfer')return `<section class="panel" data-key="action-panel"><h2>警徽的下一站</h2><p class="small muted">出局警长选择存活玩家接徽，或撕毁警徽；30 秒未操作自动撕毁。</p>${g.badgeActor===s.self.id?seatsChoice(g,aliveIds(g),ui.pick)+`<div class="actions">${button('确认移交','badge-give',{kind:'primary full',disabled:busy||!ui.pick})}${button('撕毁警徽','badge-break',{kind:'ghost full',disabled:busy})}</div>`:note('等待出局警长操作。')}</section>`;
  if(!e)return '';
  if(phase==='sheriff_signup')return `<section class="panel" data-key="action-panel"><h2>要上警吗？</h2><p class="muted small">首夜死讯公布前竞选。警长在放逐投票中有 1.5 票，并可声明警徽流。</p><p class="small muted">已表态 ${e.signupCount} / ${g.players.length}</p><div class="actions">${button('我要竞选','sheriff-run',{kind:'primary full',pressed:e.signups[s.self.id]===true,disabled:busy})}${button('留在警下','sheriff-stay',{kind:'ghost full',pressed:e.signups[s.self.id]===false,disabled:busy})}${s.self.owner?button('报名结束','sheriff-advance',{kind:'ghost slim',disabled:busy}):''}</div></section>`;
  if(['sheriff_speech','sheriff_pk_speech'].includes(phase))return `<section class="panel" data-key="action-panel"><h2>${phase==='sheriff_speech'?'候选人发言':'警长平票 PK'}</h2>${chips(e.candidates.map(nameOf))}<p class="small muted">按座位现场发言，房主确认后开启投票。平票最多 PK 一次。</p><div class="actions">${phase==='sheriff_speech'&&e.candidates.includes(s.self.id)?button('我退水','sheriff-stay',{kind:'ghost full',disabled:busy}):''}${s.self.owner?button('发言完成，投票','sheriff-advance',{kind:'primary full',disabled:busy}):''}</div></section>`;
  return `<section class="panel" data-key="action-panel"><h2>警下投票选警长</h2><p class="small muted">候选人不投票，本次每名选民都是 1 票。</p>${e.submitted?note(e.mine?'已投给 '+nameOf(e.mine):'你已弃权。','success'):e.eligible?seatsChoice(g,e.candidates,ui.pick)+`<div class="actions">${button('锁定警长选票','sheriff-vote',{kind:'primary full',disabled:busy||!ui.pick})}${button('弃权','sheriff-abstain',{kind:'ghost full',disabled:busy})}</div>`:note('你本轮没有警下投票资格。')}<p class="muted tiny">提交 ${e.count} / ${e.total}</p></section>`;
}
function lakePanel(s) {
  const g=s.game,lady=g.avalon.lady,acting=lady.holder===s.self.id;
  if(g.phase==='lady_result') {
    const result=g.me.ladyChecks?.at(-1);
    return `<section class="panel" data-key="action-panel"><h2>仙女查验已完成</h2>${lady.viewer===s.self.id&&result?note(nameOf(result.target)+' · '+result.camp+'阵营（仅你可见）','success'):note('查验者正在私下查看阵营结果。')}<p class="muted small">可在线下表述你的判断；系统不会向全桌公开阵营。</p><div class="actions">${lady.viewer===s.self.id?button('我看好了，继续','lady-continue',{kind:'primary full'}):''}</div></section>`;
  }
  return `<section class="panel" data-key="action-panel"><h2>湖中仙女</h2><p class="small muted">${escape(nameOf(lady.holder))} 持有仙女。只能查看阵营，不能选自己或曾使用仙女的玩家。查验后把标记交给目标。</p>${acting?seatsChoice(g,lady.eligible,ui.pick)+`<div class="actions">${button('确认查验阵营','lady-inspect',{kind:'primary full',disabled:busy||!ui.pick})}</div>`:note('等待持有者选择目标。')}</section>`;
}
function tableAction(s) {
  if(!s.game) {
    const ready=s.seats.find(p=>p.id===s.self.id)?.ready;
    return `<section class="panel table-wait" data-key="action-panel"><h2>${s.room.count<s.room.min?'等朋友入座':'准备好，就开场'}</h2><p class="small muted">${s.room.count<s.room.min?'还差 '+(s.room.min-s.room.count)+' 位朋友。':'确认本局配置，再点击准备。全员准备自动开始。'}</p><div class="table-config">${roomConfig(s)}</div>${s.board.error?note(s.board.error,'warn'):''}<div class="actions">${s.self.owner?button('调整配置','settings',{kind:'ghost full',disabled:busy})+button('提前开局','start',{kind:'primary full',disabled:busy||Boolean(s.board.error)}):button(ready?'已准备 ✓ · 取消':'我准备好了','ready',{kind:ready?'ghost full':'primary full',disabled:busy})}</div></section>`;
  }
  const g=s.game;
  if(g.phase==='ended')return `<section class="panel" data-key="action-panel"><h2>${labels[g.outcome.winner]}</h2><p class="small muted">${escape(g.outcome.reason)}</p><div class="actions">${link('查看完整复盘','match/'+g.id,'primary full')}${s.self.owner?button('保留座位再一局','next',{kind:'ghost full',disabled:busy}):button('退出座位','leave',{kind:'ghost full',disabled:busy})}</div></section>`;
  if(g.phase==='identity')return identityPanel(s);
  if(g.phase.startsWith('sheriff_') || ['last_words','badge_transfer'].includes(g.phase))return sheriffPanel(s);
  if(['lady_lake','lady_result'].includes(g.phase))return lakePanel(s);
  if(g.night)return g.me.alive?nightPanel(s):note('你已出局，当前只能查看公开进度。');
  if(g.avalon)return avalonProgress(g)+avalonPanel(s);
  return dayPanel(s);
}
function chatPanel(s) {
  const chat=s.game?.me.chat;
  if(!Array.isArray(chat))return note('当前没有夜间私聊权限。');
  return `<section class="panel chat-panel" data-key="chat-panel"><h2>本夜狼队私聊</h2><p class="muted tiny">仅本夜有权限的狼人可见，天亮清除。</p><ul class="chat-lines" id="chat-lines" aria-live="polite">${chat.map((line,i)=>`<li data-key="chat-${i}"><strong>${escape(nameOf(line.from))}</strong>${escape(line.message)}</li>`).join('')}</ul><form data-form="chat" class="fields" data-key="chat-form"><label class="field">给狼队留言<input name="message" data-focus="wolf-chat" autocomplete="off" maxlength="360" placeholder="先沟通，再锁定刀票" value="${escape(ui.chatDraft)}" required></label>${button('发送','',{type:'submit',kind:'primary full',disabled:busy})}</form></section>`;
}
function tableTools(s) {
  const g=s.game,needsForce=g&&['day_vote','pk_vote','sheriff_vote','sheriff_pk_vote','last_words','badge_transfer','nomination','team_vote','mission','assassination','lady_lake','lady_result'].includes(g.phase);
  showDialog('圆桌工具',`<div class="tool-grid">${g&&g.phase!=='ended'?button('查看我的身份','identity',{kind:'primary full'}):''}${button('邀请朋友','share',{kind:'ghost full'})}${g&&g.phase!=='ended'?button('暂时遮屏','privacy',{kind:'ghost full'}):''}${g?.sheriff?.holder===s.self.id&&g.me.alive&&!g.night?button('公开警徽流','flow-editor',{kind:'ghost full'}):''}${s.self.owner&&!g?button('调整本局配置','settings',{kind:'ghost full'}):''}${s.self.owner&&needsForce?button('推进当前等待','force',{kind:'ghost full'}):''}${button('座位恢复与恢复码','recovery-tools',{kind:'ghost full'})}${g?.phase==='ended'||!g?button('退出座位','leave',{kind:'ghost full'}):''}${s.self.owner?button('重置房间','reset',{kind:'danger full'}):''}</div><p class="muted tiny subtitle">${s.room.type==='wolf'?'首夜和放逐有遗言；警长放逐票1.5票。':'湖中仙女是公开标记，查验阵营只给本人。'}</p>`,'tools');
}
function tableRoom(s) {
  const rails=seatRails(s),g=s.game;
  const hasLesson=g?.type==='wolf'&&g.night&&g.me.alive;
  const hasChat=Array.isArray(g?.me.chat);
  const tab=(ui.roomTab==='learn'&&!hasLesson)||(ui.roomTab==='chat'&&!hasChat)?'action':ui.roomTab??'action';
  let content=tab==='learn'?practicePanel(s):tab==='chat'?chatPanel(s):tab==='record'?`<section class="panel" data-key="record-panel"><h2>公开时间线</h2>${g?timeline(g.recent.slice().reverse(),g.players):note('等待本局开始。')}</section>`:tableAction(s);
  const tabs=[['action','行动'],...(hasLesson?[['learn','小课堂']]:[]),...(hasChat?[['chat','夜聊']]:[]),['record','记录']];
  return `<div class="table-room" data-key="table-room"><header class="table-topbar"><a class="table-back" href="#rooms/${s.room.type}" aria-label="返回房间列表">‹</a><div><strong>${GAMES[s.room.type].name} · ${s.room.number} 号圆桌</strong><small>${s.room.count} 位玩家 · ${ROOM_STATUS[s.room.status]}</small></div>${button('⋯','room-tools',{kind:'ghost slim',focus:'room-tools'})}</header><div class="table-board"><div class="table-layout">${rails.left}<section class="table-center" data-key="table-center">${compactStage(s)}<div class="table-message" data-key="table-message" role="status"><span aria-hidden="true">✧</span><p>${escape(publicMessage(s))}</p></div><div id="room-pane" class="room-pane" data-key="room-pane">${content}</div></section>${rails.right}</div></div><nav class="room-dock" aria-label="房间操作">${tabs.map(([id,label])=>button(label,'room-tab',{value:id,kind:'dock-button',pressed:tab===id,focus:'dock-'+id})).join('')}${button('更多','room-tools',{kind:'dock-button'})}</nav></div>`;
}

function roomPage() {
  if (!snapshot) return back('返回房间列表','rooms/'+page.type) + loading();
  const s = snapshot;
  return s.self ? tableRoom(s) : showRoomHead(s.room)+joinPanel(s);
}

function gridTable(head, rows) {
  return `<div class="data-scroll"><table class="data-table"><thead><tr>${head.map(h=>'<th scope="col">'+escape(h)+'</th>').join('')}</tr></thead>
    <tbody>${rows.map(row=>'<tr>'+row.map(item=>'<td>'+escape(item)+'</td>').join('')+'</tr>').join('')}</tbody></table></div>`;
}

function rulesPage(type) {
  const wolf = type === 'wolf';
  const cards = wolf ? WOLF_KEYS : Object.keys(ROLES).slice(WOLF_KEYS.length);
  return `${title('游戏规则','房主负责开局和现场节奏。系统负责保密、计时和结算。')}
    <div class="actions first">${link('狼人杀','rules/wolf',wolf?'primary':'ghost')}${link('阿瓦隆','rules/avalon',wolf?'ghost':'primary')}</div>
    <section class="panel subtitle"><h2>${wolf?'警长、警徽流与遗言':'湖中仙女 · 8–10人可选'}</h2>${wolf?`<p class="small muted">开局前房主可开关警长与遗言。首夜操作全部结算后，先竞选警长再公布死亡；尚未公布的死者也参与本次竞选。报名60秒，全员表态可提前结束。候选人线下发言后由房主开票，警下选民每人1票。平票仅PK一次，仍平票、全弃权或没有选民均无警长。</p><p class="small muted">当选警长不增加身份牌，只在普通放逐与有资格参加的放逐PK投票中拥有1.5票。警徽流是玩家公开的查验计划，不是服务端自动公布的查验。警长出局可移交给存活玩家或撕毁警徽，30秒不操作自动撕毁。</p><p class="small muted">首夜所有出局者与白天被放逐者有60秒遗言，可主动结束，房主可确认推进。其他夜晚出局与白天被猎人带走者无遗言。猎人先完成开枪结算再处理警徽和遗言；若已达胜负条件则直接终局。</p>`:`<p class="small muted">8–10人可在预设设置中启用，5–7人自动停用。标记初始交给首任队长右手位（本桌座位号逆序前一位）。第2、3、4项任务结束且尚未达成三成三败时，持有者查验另一人的阵营，然后将标记交给对方。</p><p class="small muted">不得查验自己或曾使用过仙女的人。结果只给本次查验者，公开界面仅显示谁查了谁；莫德雷德也会显示为邪恶，不显示具体身份。查验者可线下表述、甚至虚报判断，系统不会替其公开结果。三次成功立即进入刺杀，三次失败直接终局；房主只能确认跳过等待，不能代选或偷看。</p>`}</section><section class="rule-primer"><div>${mascot(gameMascot(type))}</div><div><p class="eyebrow">一分钟入门</p><h2>${wolf ? '白天听发言，夜晚藏身份' : '组好队伍，守护三次任务'}</h2><p class="muted small">${wolf ? '好人通过讨论与投票找出狼人；狼人每晚共同选择一个目标。神职按阶段使用技能，全部结算后判断胜负。' : '队长提名，全员投票，通过后队员秘密出牌。三次任务成功后，还要躲过刺客对梅林的最后一击。'}</p></div></section><div class="stack subtitle">
      ${wolf ? `<section class="panel"><h2>狼人杀推荐板子</h2>${gridTable(['人数',...WOLF_KEYS.map(id=>ROLES[id].name)],Object.entries(WOLF_BOARDS).map(([n,roles])=>[n,...roles]))}
        <p class="muted small subtitle">屠城看两阵营是否全部出局。屠边只在平民和神职都存在时可用，任一好人类别全部出局即满足狼人条件。所有技能结算完毕后检查胜负。</p></section>
        <section class="panel"><h2>夜晚与白天</h2>${gridTable(['夜晚','狼人 守卫 预言家','女巫','猎人状态'],Object.entries(NIGHT_SCHEDULE).map(([key, v])=>[key+' 秒','0–'+v[0],v[0]+'–'+v[1],v[1]+'–'+v[2]]))}
        <p class="muted small subtitle">计时由服务器掌管。具有实际行动资格的角色先锁定行动或主动放弃，再点「准备天亮」。只有必要阶段都处理完成才可提前天亮。守护与解药同时作用于狼刀会冲突。</p>
        <p class="muted small">白天面对面讨论，由房主开启投票。首轮并列进入一次 PK，候选人不可参加第二轮。再次平票、无合法投票者或全弃权，均无人出局。</p></section>`
      : `<section class="panel"><h2>阿瓦隆任务人数</h2>${gridTable(['玩家','好人','邪恶','第一轮','第二轮','第三轮','第四轮','第五轮'],Object.entries(AVALON_TASKS).map(([n,tasks])=>[n,...AVALON_COUNTS[n],...tasks]))}
        <p class="muted small subtitle">7–10 人局的第四轮需要至少两张失败牌。其他任务一张失败牌即判失败。</p></section>
        <section class="panel"><h2>组队与胜负</h2><p>首任队长随机产生，之后按座位轮换。提名队伍后，全员秘密投票，超过半数同意方可出牌。</p>
        <p class="muted">三次任务失败或同一任务连续五次组队否决，邪恶阵营获胜。三次任务成功进入刺杀阶段，刺客命中梅林则邪恶阵营获胜，否则好人获胜。</p></section>`}
      <section class="panel"><h2>身份说明</h2>${cards.map(id=>`<details data-detail="rule-${id}"><summary>${ROLES[id].name} · ${ROLES[id].side}</summary>
        <p>${ROLES[id].ability}</p><p class="muted small">${ROLES[id].goal} ${ROLES[id].how} ${ROLES[id].tip}</p></details>`).join('')}</section>
    </div>`;
}

function profilePage() {
  const nickname = readLocal('nickname','');
  return `<header class="profile-hero"><div class="profile-avatar">${nickname?escape([...nickname][0]):'☾'}</div><div><p class="eyebrow">YOUR LITTLE CORNER</p><h1>${nickname?escape(nickname):'我的圆桌'}</h1><p class="muted small">下一次相聚，还在月下。</p></div>${mascot('mooncat')}</header><div class="profile-layout"><div class="stack"><section class="panel"><h2>朋友们怎么称呼你</h2><p class="muted small">保存后，下次入座会自动填好。</p><form data-form="nickname" class="fields"><label class="field">默认昵称<input name="nickname" data-focus="profile-name" autocomplete="nickname" maxlength="36" placeholder="填写你常用的昵称" value="${escape(nickname)}"></label>${button('保存昵称','',{type:'submit',kind:'primary'})}</form></section><section class="panel"><h2>把游戏调成你喜欢的样子</h2><label class="setting-row"><span><strong>减少动画</strong><small>切换更轻盈，适合低性能手机</small></span><input type="checkbox" name="reduce" role="switch"${readLocal('reduce',false)?' checked':''}></label><label class="setting-row"><span><strong>大号文字</strong><small>放大规则与操作说明</small></span><input type="checkbox" name="large" role="switch"${readLocal('large',false)?' checked':''}></label><label class="setting-row"><span><strong>游戏时保持常亮</strong><small>${'wakeLock' in navigator?'仅游戏进行时申请，省电模式可能限制':'当前浏览器不支持屏幕常亮'}</small></span><input type="checkbox" name="awake" role="switch"${readLocal('awake',false)?' checked':''}${'wakeLock' in navigator?'':' disabled'}></label><label class="setting-row"><span><strong>轻触反馈</strong><small>支持震动的手机收到操作确认时轻震</small></span><input type="checkbox" name="haptic" role="switch"${readLocal('haptic',false)?' checked':''}${'vibrate' in navigator?'':' disabled'}></label><p class="muted tiny subtitle">偏好仅保存在当前浏览器。</p></section></div><div class="stack"><section class="panel"><span class="eyebrow">YOUR STORIES</span><h2>那些精彩的对局</h2><p class="muted small">翻看身份、票型和关键时刻，再聊聊谁的演技最好。</p>${link('我的对局记录 ↗','history','primary full')}</section><section class="panel"><h2>需要一点帮助？</h2><div class="profile-links">${button('一分钟上手指南 ↗','guide',{kind:'ghost full'})}${link('玩法与身份手册 ↗','rules','ghost full')}</div><p class="muted tiny subtitle">刷新可恢复原座位。换设备请使用恢复码；请勿把恢复码发到群里。</p></section><section class="panel admin-entry"><h2>开发者入口</h2><p class="muted small">凭管理密码查看房间与已结束的对局。</p>${link('进入管理后台 ↗','admin','ghost full')}</section></div></div>`;
}

function pagination(rows, path) {
  if (!rows || (!rows.more && !page.offset)) return '';
  return `<div class="actions">${page.offset ? link('上一页',path+'/'+Math.max(0,page.offset-25)) : ''}${rows.more ? link('下一页',path+'/'+(page.offset+25)) : ''}</div>`;
}

function reportList(rows, admin = false) {
  if (!rows.length) return emptyState('故事，还没写下第一章', '完成一场游戏后，身份、投票和关键时刻都会留在这里。', link('去大厅，开一场','lobby','primary')); 
  return `<div class="stack">${rows.map(m=>`<a class="history-card" href="#${admin?'admin-match':'match'}/${m.id}"><div class="spread"><strong>${GAMES[m.type].name} · ${m.room.split('-')[1]} 号房</strong>${badge(labels[m.winner])}</div>
    <span class="muted small">${reducedTime(m.ended)}</span></a>`).join('')}</div>`;
}

function dataFallback() {
  if (fetching) return loading();
  if (errorText) return `<section class="panel">${note(errorText,'error')}<div class="actions">${button('重新获取','refresh')}</div></section>`;
  return '';
}

function historyPage() {
  return `${back('返回我的','profile')}${title('我的历史记录','在本浏览器参加过的归档对局。')}
    ${dataFallback() || `<section class="panel narrow">${reportList(pageData?.rows ?? [])}${pagination(pageData,'history')}</section>`}`;
}

function adminPage() {
  const header = back('返回我的','profile') + title('开发者管理后台','查看六个房间的状态和已归档的对局。');
  const fallback = dataFallback();
  if (fallback) return header+fallback;
  const data = pageData;
  if (!data?.enabled) return header + `<section class="panel narrow">${note('后台尚未启用。部署时设置 ADMIN_PASSWORD。','warn')}</section>`;
  if (!data.authenticated) return header + `<section class="panel narrow"><h2>密码登录</h2><form class="fields" data-form="admin-login">
    <label class="field">管理密码<input type="password" name="password" required maxlength="256" autocomplete="current-password"></label>
    ${button('登录','',{type:'submit',kind:'primary',disabled:busy})}</form></section>`;
  return header + `<div class="actions first">${button('刷新状态','refresh')}${button('退出后台','admin-logout',{kind:'ghost'})}</div>
    <div class="two-col subtitle"><section class="panel"><h2>对局档案</h2>${reportList(data.rows,true)}${pagination(data,'admin')}</section>
    <section class="panel"><h2>房间总览</h2><ul class="rows">${data.rooms.map(r=>`<li><span class="person-name">${GAMES[r.type].name} · ${r.number} 号</span>${badge(r.count+' 人')}${statusBadge(r.status)}</li>`).join('')}</ul></section></div>`;
}

function matchPage() {
  const admin = page.view === 'admin-match';
  const fallback = dataFallback();
  if (fallback) return back('返回' + (admin?'管理后台':'历史记录'),admin?'admin':'history') + title('对局复盘') + fallback;
  const r = pageData;
  if (!r) return loading();
  const relationships = r.players.filter(p=>p.intel);
  return `${back('返回' + (admin?'管理后台':'历史记录'),admin?'admin':'history')}
    ${title(GAMES[r.type].name+'复盘',r.number+' 号房间 · '+reducedTime(r.startedAt)+' 开始')}
    <section class="stage ended new"><p class="eyebrow">${escape(r.outcome.reason)}</p><h2>${labels[r.outcome.winner]}</h2><p class="muted small subtitle">归档时间 ${reducedTime(r.endedAt)}</p></section>
    <div class="two-col"><div class="stack"><section class="panel"><h2>对局时间线</h2>${timeline(r.events,r.players)}</section></div>
    <div class="stack">${playersSummary(r)}${relationships.length ? `<section class="panel"><h2>初始情报</h2><ul class="rows">${relationships.map(p=>`<li><span class="person-name">${escape(p.name)}</span><span class="muted small">${p.intel.label} · ${escape(namesIn(r.players,p.intel.players))}</span></li>`).join('')}</ul></section>` : ''}
    ${r.type === 'wolf' && r.outcome.winner !== 'aborted' ? `<section class="panel"><h2>出局顺序</h2>${r.deaths.length ? gridTable(['玩家','天数','原因'],r.deaths.map(d=>[nameIn(r.players,d.id),d.day,causeNames[d.cause]])) : note('无人出局。')}</section>` : ''}
    ${r.outcome.winner === 'aborted' ? `<section class="panel">${note('本局中途重置。归档保留中止前的公开事件。')}</section>` : ''}
    ${admin ? `<section class="panel"><h2>导出档案</h2><a class="btn ghost" href="/api/admin/matches/${r.id}/export" download>下载 JSON</a></section>` : ''}
    </div></div>`;
}

function codeDialog(code) {
  const first = page.type === 'wolf' && !readLocal('nightIntro',false);
  if (first) writeLocal('nightIntro',true);
  showDialog('保存你的恢复码', `<p class="muted">换手机或清除浏览器数据时，可用此恢复码申请原座位。请单独保管。</p>
    <code class="recovery-code">${escape(code.match(/.{1,4}/g).join('-'))}</code>
    ${first ? `<p class="note subtitle">所有人夜间都可阅读、打字和点击。统一互动能降低身份暴露，也帮助新玩家熟悉规则。</p>` : ''}
    <div class="actions">${button('复制恢复码','copy',{value:code})}${button('已保存','close',{kind:'primary'})}</div>`,'code');
}

function shareDialog() {
  const url = location.origin + location.pathname + '#room/' + page.id;
  showDialog('邀请朋友入座', `<div class="share-ticket"><span class="eyebrow">YOU ARE INVITED</span><h3>${GAMES[page.type].name} · ${snapshot.room.number} 号圆桌</h3><p>同一个房间，一起开场。</p></div><p class="muted">把这个链接发给同桌玩家。打开后会直接进入同一房间。</p>
    <label class="field">房间链接<input id="share-url" readonly value="${escape(url)}"></label>
    <div class="actions">${button('复制邀请链接','copy',{kind:'primary',value:url})}${navigator.share?button('用手机分享','native-share',{kind:'ghost',value:url}):''}</div>`,'share');
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
    notify('已复制。');
  } catch {
    const field = $('#share-url');
    if (field) { field.focus(); field.select(); }
    else {
      const code = dialog.querySelector('.recovery-code');
      if (code) {
        const range = document.createRange();
        range.selectNodeContents(code);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
      }
    }
    notify('文本已选中。可使用浏览器的复制操作。');
  }
}

function boardMetrics(draft) {
  const [wolves,villagers,...specials] = draft.counts;
  const gods = specials.reduce((a,b)=>a+b,0);
  const good = gods+villagers;
  const sum = wolves+good;
  const edge = gods > 0 && villagers > 0;
  let error = '';
  if (draft.people < 6 || draft.people > 12) error = '当前人数未达到开局要求。';
  else if (sum !== draft.people) error = '身份总数需要与在座人数相同。';
  else if (!wolves || !good) error = '至少需要一名狼人和一名好人。';
  else if (draft.winMode==='edge' && !edge) error = '屠边需要平民和神职同时存在。';
  const warnings = [];
  if (wolves && wolves>=good) warnings.push('狼人达到或超过好人，阵营可能失衡。');
  if (specials.some(v=>v>1)) warnings.push('重复神职按座位独立行动。');
  return { html: chips(['共 '+sum+' 张 / '+draft.people+' 人','狼 '+wolves,'好人 '+good,'神职 '+gods,'平民 '+villagers]) +
    (error ? note(error,'warn') : note('当前板子有效。','success')) + warnings.map(w=>note(w,'warn')).join(''), edge };
}

function settingsDialog(init = true) {
  const s = snapshot;
  if (!s?.self?.owner || s.game) return;
  if (init) {
    boardDraft = { epoch:s.configEpoch, people:s.room.count, counts:s.board.counts?.slice(), custom:Boolean(s.config.board),
      winMode:s.config.winMode, nightSeconds:s.config.nightSeconds, preset:s.config.preset, sheriffEnabled:s.config.sheriffEnabled!==false,lastWords:s.config.lastWords!==false,ladyEnabled:s.config.ladyEnabled!==false };
  }
  if (s.room.type === 'avalon') {
    showDialog('选择角色预设', `<p class="muted small">每个预设都包含梅林和刺客。人数不足时相应预设会停用。</p>
      <form class="fields" data-form="avalon-settings"><label class="field">预设角色<select name="preset">${s.board.options.map(o=>`<option value="${o.id}"${o.id===boardDraft.preset?' selected':''}${o.valid?'':' disabled'}>${o.name}${o.valid?'':'（人数不足）'}</option>`).join('')}</select></label>
      <div id="preset-details"></div><label class="checkbox"><input type="checkbox" name="ladyEnabled"${boardDraft.ladyEnabled?' checked':''}> 8–10 人启用湖中仙女</label><p class="muted tiny">第2、3、4项非终局任务后查验阵营，结果仅持有者可见。少于8人不启用。</p>${button('应用预设','',{type:'submit',kind:'primary'})}</form>`,'settings');
    presetDetails(boardDraft.preset);
    return;
  }
  const saved = readLocal('boards',[]);
  const metrics = boardMetrics(boardDraft);
  showDialog('编辑板子', `<p class="muted small">修改后，其他玩家需要重新确认准备。推荐板子会随人数变化。</p>
    <form class="fields" data-form="wolf-settings"><div class="actions first">${button('恢复推荐配置','recommend',{kind:'ghost slim'})}
      ${boardDraft.custom ? badge('自定义板子','warn') : badge('跟随推荐')}</div>
      <div class="board-inputs">${WOLF_KEYS.map((id,i)=>`<label class="field">${ROLES[id].name}<input type="number" name="role-${i}" data-board="${i}" min="0" max="12" value="${boardDraft.counts[i]}"></label>`).join('')}</div>
      <div id="board-metrics">${metrics.html}</div>
      <label class="field">胜负模式<select name="winMode"><option value="city"${boardDraft.winMode==='city'?' selected':''}>屠城</option><option value="edge"${boardDraft.winMode==='edge'?' selected':''}${metrics.edge?'':' disabled'}>屠边</option></select></label>
      <label class="field">夜晚长度<select name="nightSeconds"><option value="180"${boardDraft.nightSeconds===180?' selected':''}>3 分钟</option><option value="300"${boardDraft.nightSeconds===300?' selected':''}>5 分钟</option></select></label>
      <label class="checkbox"><input type="checkbox" name="sheriffEnabled"${boardDraft.sheriffEnabled?' checked':''}> 启用警长竞选与1.5票</label><label class="checkbox"><input type="checkbox" name="lastWords"${boardDraft.lastWords?' checked':''}> 首夜出局／白天放逐遗言</label><details><summary>常用配置与结算说明</summary>
        <p class="muted small">屠城看阵营全灭。屠边同时需要平民和神职。守卫与解药同时保护狼刀目标时失效，毒药无法被抵消。重复角色各自行动。</p>
        ${saved.length ? `<label class="field">加载本机配置<select name="saved-board"><option value="">请选择</option>${saved.map((v,i)=>`<option value="${i}">${escape(v.name)}</option>`).join('')}</select></label>` : ''}
        <label class="field">保存常用配置的名称<input name="boardName" maxlength="28" placeholder="例如 八人双守卫"></label>
        <div class="actions">${button('保存到本机','save-board',{kind:'ghost slim'})}</div>
      </details>
      ${button('应用到房间','',{kind:'primary',type:'submit'})}
    </form>`,'settings');
}

function presetDetails(id) {
  const preset = AVALON_PRESETS[id];
  const element = $('#preset-details');
  if (preset && element) element.innerHTML = chips(['梅林','刺客',...preset.good.map(r=>ROLES[r].name),...preset.evil.map(r=>ROLES[r].name)]);
}

function updateBoardMetrics() {
  const metrics = boardMetrics(boardDraft);
  $('#board-metrics').innerHTML = metrics.html;
  const select = dialogContent.querySelector('[name=winMode]');
  select.options[1].disabled = !metrics.edge;
  if (!metrics.edge && boardDraft.winMode === 'edge') {
    boardDraft.winMode = 'city';
    select.value = 'city';
    $('#board-metrics').innerHTML = boardMetrics(boardDraft).html;
  }
}

function paint() {
  if (!page) return;
  if(ime.defer()){refreshClocks();updateConnection();return;}
  const oldFocus = document.activeElement;
  const focus = root.contains(oldFocus) && oldFocus.dataset.focus;
  const start = focus ? oldFocus.selectionStart : null;
  const end = focus ? oldFocus.selectionEnd : null;
  const open = new Set([...root.querySelectorAll('details[open][data-detail]')].map(d=>d.dataset.detail));
  const oldPane=$('#room-pane');const panePos=oldPane?.scrollTop??0;
  const oldChat = $('#chat-lines');
  const chatPos = oldChat && oldChat.scrollHeight - oldChat.clientHeight - oldChat.scrollTop > 24 ? oldChat.scrollTop : null;
  document.body.dataset.theme = page.type ?? '';
  document.body.dataset.view = page.view;
  document.body.dataset.roomMode=Boolean(page.view==='room'&&snapshot?.self);
  document.body.dataset.night = Boolean(snapshot?.game?.night);
  if (page.view === 'lobby') patchHTML(root, home(), document.activeElement);
  if (page.view === 'rooms') patchHTML(root, roomsPage(page.type), document.activeElement);
  if (page.view === 'room') patchHTML(root, roomPage(), document.activeElement);
  if (page.view === 'rules') patchHTML(root, rulesPage(page.type), document.activeElement);
  if (page.view === 'profile') patchHTML(root, profilePage(), document.activeElement);
  if (page.view === 'history') patchHTML(root, historyPage(), document.activeElement);
  if (page.view === 'admin') patchHTML(root, adminPage(), document.activeElement);
  if (['match','admin-match'].includes(page.view)) patchHTML(root, matchPage(), document.activeElement);
  for (const d of root.querySelectorAll('details[data-detail]')) if (open.has(d.dataset.detail)) d.open = true;
  const pane=$('#room-pane');if(pane)pane.scrollTop=ui.resetPane?0:panePos;ui.resetPane=false;
  const chat = $('#chat-lines');
  if (chat) chat.scrollTop = chatPos ?? chat.scrollHeight;
  if (focus) {
    const field = [...root.querySelectorAll('[data-focus]')].find(item=>item.dataset.focus===focus);
    if (field && !field.disabled) {
      if(field!==oldFocus || document.activeElement!==field){field.focus({preventScroll:true});
        if (typeof start === 'number' && field.setSelectionRange) field.setSelectionRange(start,end);}

    }
  }
  refreshClocks();
  updateConnection();
}

function refreshClocks() {
  const at = Date.now() + clockOffset;
  for (const item of root.querySelectorAll('[data-clock]')) {
    const left = Math.max(0, Math.ceil((Number(item.dataset.clock)-at)/1000));
    const value = String(Math.floor(left/60)).padStart(2,'0') + ':' + String(left%60).padStart(2,'0');
    if (item.textContent !== value) item.textContent = value;
    item.dataset.urgent = left <= 20;
  }
}

function forceAction(g) {
  const settings = {
    sheriff_vote:['结束警长投票','未提交的警下票视为弃权。'],sheriff_pk_vote:['结束警长PK投票','未提交按弃权；再次平票则无警长。'],badge_transfer:['撕毁警徽','跳过出局警长的选择并撕毁警徽。'],last_words:['结束遗言','确认当前玩家已完成现场遗言。'],lady_lake:['跳过仙女','本轮不产生查验结果，不代选目标。'],lady_result:['继续任务流程','结束当前结果展示，保留查验者的私有记录。'],
    day_vote: ['跳过当前投票','已经提交的选票仍然有效。未提交的选票将视为弃权。'],
    pk_vote: ['跳过当前 PK 投票','已经提交的选票仍然有效。未提交的选票将视为弃权。'],
    nomination: ['跳过本次提名','本次计为一次组队否决。若已累计五次，邪恶阵营立即获胜。'],
    team_vote: ['结束组队投票','未提交的选票将视为反对。'],
    mission: ['结束任务等待','未提交的任务牌将按成功处理。'],
    assassination: ['放弃刺杀','确认后好人立即获胜。']
  }[g.phase];
  if (settings) confirmAction(...settings,()=>send('forcePhase',{confirm:true}));
}

function currentRoomContext() {
  return [page?.id,snapshot?.self?.id,snapshot?.configEpoch,snapshot?.game?.id,snapshot?.game?.turn].join('|');
}
let draftQueue = Promise.resolve();

document.addEventListener('click',event=>{
  const target = event.target.closest('[data-act]');
  if (!target || target.disabled) return;
  const action = target.dataset.act;
  if (action === 'close' && dialogKind === 'privacy') { closeDialog(); return; }
  const value = target.dataset.value;
  const s = snapshot;
  const g = s?.game;
  const context = currentRoomContext();
  switch (action) {
    case 'close': closeDialog(); break;
    case 'confirm': {
      const callback = confirmCallback;
      const expected = dialogContent.dataset.context;
      closeDialog();
      if (expected === context) callback?.();
      else notify('房间状态已更新，请重新确认。');
      break;
    }
    case 'lesson-read':{const g=s.game,strategy=lesson(g,'strategies'),term=lesson(g,'terms'),scenario=lesson(g,'cases');showDialog('月下锦囊 · 阅读版',`<div class="lesson-reader"><h3>本夜策略</h3><p>${escape(strategy.background)}</p><p>${escape(strategy.tactic)}</p><p class="muted small">${escape(strategy.mistake)}</p><hr><h3>术语：${escape(term.term)}</h3><p>${escape(term.meaning)}</p><hr><h3>情境讲解</h3><p>${escape(scenario.case)}</p><p>${escape(scenario.feedback)}</p></div>`,'lesson-read');break;}
    case 'room-tab': ui.roomTab=value;ui.resetPane=true;paint();break;
    case 'room-tools': tableTools(s);break;
    case 'choose-avatar':ui.avatar=value;writeLocal('avatar',value);paint();break;
    case 'seat-info': {const p=(g?.players??s.seats).find(p=>p.id===value);if(p)showDialog('玩家座位',`<p>${escape(p.name)}</p><p class="muted small">${g?(p.alive?'仍在场上':'已出局'):'等待开局'} · 头像是玩家装扮，与秘密身份无关。</p>`,'seat-info');break;}
    case 'recovery-tools':showDialog('座位恢复',recoveryPanel(s),'recovery');break;
    case 'flow-editor':showDialog('声明你的警徽流',`<p class="muted small">填写最多两个座位号，用逗号分隔。只公开计划，不自动公开查验结果。</p><form data-form="flow" class="fields"><label class="field">座位顺序<input name="seats" data-focus="flow-seats" inputmode="text" placeholder="例如 3,7" maxlength="12"></label>${button('公开声明','',{type:'submit',kind:'primary'})}</form>`,'flow');break;
    case 'sheriff-run':send('sheriffSignup',{run:true});break;
    case 'sheriff-stay':send('sheriffSignup',{run:false});break;
    case 'sheriff-advance':send('sheriffAdvance');break;
    case 'sheriff-vote':send('sheriffVote',{target:ui.pick});break;
    case 'sheriff-abstain':send('sheriffVote',{target:null});break;
    case 'badge-give':{const target=ui.pick;confirmAction('确认移交警徽','将警徽交给「'+nameOf(target)+'」？',()=>send('sheriffBadge',{target,confirm:true}),false);break;}
    case 'badge-break':confirmAction('确认撕毁警徽','本局将不再有警长。',()=>send('sheriffBadge',{target:null,confirm:true}));break;
    case 'words-done':send('finishWords');break;
    case 'lady-inspect':{const target=ui.pick;confirmAction('确认仙女目标','仅你可见「'+nameOf(target)+'」的阵营，然后交出标记。',()=>send('ladyInspect',{target,confirm:true}),false,'确认查验');break;}
    case 'lady-continue':send('ladyContinue');break;
    case 'intro': showIntro(); break;
    case 'guide': guideDialog(); break;
    case 'privacy': privacyScreen(); break;
    case 'reconnect':
      if (livePath()) { startStream(livePath(),generation); poll(true); }
      break;
    case 'native-share':
      navigator.share?.({title:'月下圆桌 · 邀请你入座',text:GAMES[page.type].name+' · '+s.room.number+' 号圆桌，等你开场',url:value}).catch(e=>{if(e.name!=='AbortError')copyText(value);});
      break;
    case 'share': shareDialog(); break;
    case 'copy': copyText(value); break;
    case 'toggle-recover': ui.recover = !ui.recover; paint(); break;
    case 'identity': showIdentity(); break;
    case 'identity-confirm':
      closeDialog();
      if (g?.phase === 'identity') send('identityConfirm');
      break;
    case 'ready':
      send('ready',{ready:!s.seats.find(p=>p.id===s.self.id).ready,epoch:s.configEpoch});
      break;
    case 'start':
      confirmAction('强制开始','当前名单和身份将锁定。尚未准备的玩家也会入局。',()=>send('start',{confirm:true,epoch:s.configEpoch}));
      break;
    case 'leave':
      confirmAction('退出座位','退出后会释放当前席位。已归档的对局仍可在历史中查看。',()=>send('leave'));
      break;
    case 'kick':
      confirmAction('移除玩家','确认释放「'+nameOf(value)+'」的座位？',()=>send('kick',{confirm:true,target:value}));
      break;
    case 'reset':
      confirmAction('重置房间','这会清空所有座位和设置。进行中的对局会中止，已公开事件会归档。',()=>send('reset',{confirm:true,epoch:s.configEpoch}));
      break;
    case 'next': send('next'); break;
    case 'settings': settingsDialog(); break;
    case 'recommend':
      boardDraft.counts = (WOLF_BOARDS[boardDraft.people] ?? WOLF_BOARDS[6]).slice();
      boardDraft.custom = false;
      settingsDialog(false);
      break;
    case 'save-board': {
      const input = dialogContent.querySelector('[name=boardName]');
      const name = input.value.trim() || (boardDraft.counts.reduce((a,b)=>a+b,0)+' 张 · '+boardDraft.counts.join('/'));
      const saved = readLocal('boards',[]);
      writeLocal('boards',[{name,counts:boardDraft.counts.slice(),winMode:boardDraft.winMode,nightSeconds:boardDraft.nightSeconds,sheriffEnabled:boardDraft.sheriffEnabled,lastWords:boardDraft.lastWords},...saved.filter(b=>b.name!==name)].slice(0,20));
      settingsDialog(false);
      notify('已保存为本机常用配置。');
      break;
    }
    case 'rotate-code':
      confirmAction('生成新恢复码','原恢复码和待处理申请会失效。请保存新的恢复码。',()=>send('rotateCode'),false);
      break;
    case 'approve':
    case 'deny': {
      const request = s.requests.find(r=>r.id===value);
      const allow = action === 'approve';
      if (request) confirmAction(allow?'批准恢复':'拒绝恢复',
        allow?'将「'+request.name+'」的座位交给申请设备。旧浏览器会失去该座位权限。':'这次申请将结束。玩家仍可以重新申请。',
        ()=>send('recoveryDecision',{allow,target:value,expires:request.expires}),!allow);
      break;
    }
    case 'pick':
      ui.roomTab='action';
      ui.pick = value;
      ui.draftTouched = true;
      if (g.phase === 'night_one' && selfRole()==='wolf') {
        const ticket = ++ui.draftTicket;
        const visit = generation;
        draftQueue = draftQueue.then(()=>{
          if (generation === visit && context === currentRoomContext() && ticket === ui.draftTicket
            && !busy && !snapshot.game.me.action) return send('wolfDraft',{target:value},{quiet:true,draft:true});
        });
      }
      paint();
      break;
    case 'night-target': {
      const ownDraft = g.me.wolves?.find(w=>w.id===s.self.id)?.draft;
      const chosen = ui.pick ?? ownDraft;
      const submit = ()=>send('nightSubmit',{choice:selfRole()==='witch'?'poison':'target',target:chosen});
      if (['witch','hunter'].includes(selfRole())) confirmAction('确认技能目标','选择「'+nameOf(chosen)+'」，锁定后无法更改。',submit,true,'确认锁定');
      else submit();
      break;
    }
    case 'night-pass': send('nightSubmit',{choice:'pass'}); break;
    case 'night-save': confirmAction('使用解药','确认救助「'+nameOf(g.me.bite)+'」？解药整局只能使用一次。',()=>send('nightSubmit',{choice:'save'}),false,'确认用药'); break;
    case 'night-ready': send('nightReady'); break;
    case 'open-vote': send('openDayVote'); break;
    case 'day-vote': send('dayVote',{target:ui.pick}); break;
    case 'day-pass': send('dayVote',{target:null}); break;
    case 'day-shot': { const chosen=ui.pick; confirmAction('确认开枪','确认带走「'+nameOf(chosen)+'」？提交后无法更改。',()=>send('dayShot',{target:chosen}),true,'确认开枪'); break; }
    case 'day-no-shot': send('dayShot',{target:null}); break;
    case 'force': forceAction(g); break;
    case 'team-pick':
      ui.roomTab='action';
      if (ui.team.includes(value)) ui.team = ui.team.filter(id=>id!==value);
      else if (ui.team.length < g.avalon.taskSize) ui.team.push(value);
      else notify('已选满。先取消一名队员，再添加其他玩家。');
      paint();
      break;
    case 'nominate': send('nominate',{team:ui.team.slice()}); break;
    case 'choice': ui.choice = value; paint(); break;
    case 'team-vote': send('teamVote',{choice:ui.choice}); break;
    case 'mission-card': send('missionCard',{choice:ui.choice}); break;
    case 'assassinate': {
      const chosen = ui.pick;
      confirmAction('确认刺杀目标','确认选择「'+nameOf(chosen)+'」？提交后立即结算。',()=>send('assassinate',{target:chosen,confirm:true}),true,'提交刺杀');
      break;
    }
    case 'next-lesson': {
      const kind={strategy:'strategies',terms:'terms',case:'cases'}[value];
      if(g?.night && kind) {
        lesson(g,kind,true);
        if(value==='terms')ui.term=null;
        if(value==='case')ui.quiz=null;
        paint();
      }
      break;
    }
    case 'practice-tab': ui.tab = value; paint(); break;
    case 'term': ui.term = Number(value); paint(); break;
    case 'quiz': ui.quiz = Number(value); paint(); break;
    case 'refresh': loadPage(); break;
    case 'admin-logout':
      api('/api/admin/logout',{}).then(()=>loadPage()).catch(e=>notify(e.message));
      break;
  }
});

document.addEventListener('submit',event=>{
  const form = event.target;
  const key = form.dataset.form;
  if (!key) return;
  event.preventDefault();
  if(ime.blocked() || event.isComposing)return;
  const fields = Object.fromEntries(new FormData(form));
  if (key==='join' || key==='recover') {
    send(key,fields,{after:result=>{
      if (result.self) {writeLocal('nickname',result.self.name);if(fields.avatar)writeLocal('avatar',fields.avatar);}
      else if (fields.name) writeLocal('nickname',fields.name.trim());
    }});
  } else if(key==='flow'){
    const seats=fields.seats.trim()?fields.seats.split(/[,，\s]+/).filter(Boolean).map(Number):[];
    if(seats.length>2 || seats.some(i=>!Number.isInteger(i)||i<1||i>gPlayers().length)){notify('请输入最多两个有效座位号。');return;}
    send('sheriffFlow',{targets:seats.map(i=>gPlayers()[i-1].id)},{after:()=>closeDialog()});
  } else if (key==='chat') {
    send('wolfChat',{message:fields.message},{quiet:true,after:()=>{ui.chatDraft='';}});
  } else if (key==='memo') {
    ui.savedMemo = Boolean(fields.memo.trim());
    paint();
    if (!ui.savedMemo) notify('先写下你的想法。');
  } else if (key==='nickname') {
    const name = fields.nickname.normalize('NFKC').trim();
    if ([...name].length>18 || /[\p{Cc}\p{Cf}]/u.test(name)) { notify('请输入不超过 18 个字符的昵称。'); return; }
    writeLocal('nickname',name);
    notify('已保存。');
  } else if (key==='wolf-settings') {
    if (boardDraft.counts.some(n=>!Number.isInteger(n)||n<0||n>12)) { notify('请输入 0–12 的整数。'); return; }
    send('configure',{board:boardDraft.custom?boardDraft.counts:null,winMode:boardDraft.winMode,nightSeconds:boardDraft.nightSeconds,epoch:boardDraft.epoch,sheriffEnabled:Boolean(fields.sheriffEnabled),lastWords:Boolean(fields.lastWords)},
      {after:()=>closeDialog()});
  } else if (key==='avalon-settings') {
    send('configure',{preset:fields.preset,ladyEnabled:Boolean(fields.ladyEnabled),epoch:boardDraft.epoch},{after:()=>closeDialog()});
  } else if (key==='admin-login' && !busy) {
    busy = true;
    api('/api/admin/login',{password:fields.password}).then(()=>loadPage()).catch(e=>notify(e.message)).finally(()=>{busy=false;});
  }
});

document.addEventListener('input',event=>{
  const field = event.target;
  if(!root.contains(field) && !dialogContent.contains?.(field))return;
  const scope=draftScope();
  if(event.isComposing && !compositionSession)compositionSession={target:field,scope};
  const valid=!compositionSession || compositionSession.target!==field || compositionSession.scope===scope;
  ime.input(event,scope,node=>{if(valid && draftScope()===scope)commitDraft(node);},()=>{compositionSession=null;paint();});
  if(event.isComposing)ime.defer();
  if(!valid)return;
  if (field.dataset.board !== undefined && dialogKind==='settings') {
    const n = Math.min(12,Math.max(0,Math.trunc(Number(field.value)||0)));
    boardDraft.counts[Number(field.dataset.board)] = n;
    boardDraft.custom = true;
    updateBoardMetrics();
  }
  if (field.dataset.focus==='memo') {ui.memo=field.value; ui.savedMemo=false;}
  if (field.dataset.focus==='wolf-chat') ui.chatDraft = field.value;
  if (field.dataset.focus==='join-name') ui.nameDraft = field.value;
  if (field.dataset.focus==='restore-code') ui.codeDraft = field.value;
});

document.addEventListener('change',event=>{
  const field = event.target;
  if (field.name==='reduce') {
    writeLocal('reduce',field.checked);
    document.documentElement.dataset.reduce = field.checked;
  }
  if (['large','awake','haptic'].includes(field.name)) {
    writeLocal(field.name,field.checked);
    if (field.name==='large') document.documentElement.dataset.large=field.checked;
    if (field.name==='awake') keepAwake();
  }
  if (dialogKind!=='settings') return;
  if(['sheriffEnabled','lastWords','ladyEnabled'].includes(field.name))boardDraft[field.name]=field.checked;
  if (field.name==='preset') { boardDraft.preset=field.value; presetDetails(field.value); }
  if (field.name==='winMode') { boardDraft.winMode=field.value; updateBoardMetrics(); }
  if (field.name==='nightSeconds') boardDraft.nightSeconds=Number(field.value);
  if (field.name==='saved-board' && field.value!=='') {
    const saved=readLocal('boards',[])[Number(field.value)];
    if (saved) {
      Object.assign(boardDraft,{counts:saved.counts.slice(),winMode:saved.winMode,nightSeconds:saved.nightSeconds,sheriffEnabled:saved.sheriffEnabled??boardDraft.sheriffEnabled,lastWords:saved.lastWords??boardDraft.lastWords,custom:true});
      if (boardDraft.winMode==='edge' && !boardMetrics(boardDraft).edge) boardDraft.winMode='city';
      settingsDialog(false);
    }
  }
});

function gPlayers(){return snapshot?.game?.players??[];}
function commitDraft(field){
  if(field.dataset.focus==='memo'){ui.memo=field.value;ui.savedMemo=false;}
  if(field.dataset.focus==='wolf-chat')ui.chatDraft=field.value;
  if(field.dataset.focus==='join-name')ui.nameDraft=field.value;
  if(field.dataset.focus==='restore-code')ui.codeDraft=field.value;
}
document.addEventListener('compositionstart',event=>{compositionSession={target:event.target,scope:draftScope()};ime.start(event.target,draftScope());ime.defer();});
document.addEventListener('compositionend',event=>{const scope=draftScope(),session=compositionSession;ime.defer();ime.end(event.target,scope,field=>{if(draftScope()===scope&&(!session||session.scope===scope))commitDraft(field);},()=>{if(compositionSession===session)compositionSession=null;paint();});});
let viewportCeiling=0,viewportWidth=0;
function fitViewport(){
  const height=window.visualViewport?.height??window.innerHeight,width=window.innerWidth??0;
  if(!Number.isFinite(height))return;
  if(Math.abs(width-viewportWidth)>40){viewportCeiling=height;viewportWidth=width;}else viewportCeiling=Math.max(viewportCeiling,height);
  document.documentElement.style?.setProperty('--viewport-height',Math.round(height)+'px');
  document.body.dataset.keyboard=height<viewportCeiling*.78;
}
window.visualViewport?.addEventListener('resize',fitViewport);window.addEventListener('resize',fitViewport);fitViewport();
dialog.addEventListener('cancel',event=>{event.preventDefault();closeDialog();});
document.querySelector('.skip-link').addEventListener('click',event=>{event.preventDefault();root.focus();});
window.addEventListener('hashchange',navigate);
window.addEventListener('online',()=>{updateConnection();poll(true);});
window.addEventListener('offline',()=>{updateConnection();if (livePath()) setNetwork('手机已离线。网络恢复后将自动连接。');});
document.addEventListener('visibilitychange',()=>{
  if (document.hidden) {
    if (snapshot?.game && snapshot.game.phase !== 'ended') privacyScreen();
    else closeDialog();
  } else { poll(true); keepAwake(); }
});
document.addEventListener('click', event=>{
  if (event.target.closest('a[href^="#"]') && dialog.open) closeDialog();
});
setInterval(()=>{
  if (Date.now()-lastPoll >= (streamOpen?12_000:2200)) poll();
  refreshClocks();
},250);
navigate();
