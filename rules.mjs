import { randomInt, randomUUID } from 'node:crypto';
import { AVALON_COUNTS, AVALON_PRESETS, AVALON_TASKS, GAMES, NIGHT_SCHEDULE, ROLES, WOLF_BOARDS, WOLF_KEYS } from './game-data.mjs';

export const NIGHT_PHASES = ['night_one', 'night_two', 'night_three'];
const IDENTITY_TIME = 30_000;
const RESULT_TIME = 5_000;
const POISON_NOTICE_TIME = 4_000;
const phaseRoles = ['wolf guard seer'.split(' '), ['witch'], ['hunter']];

export class GameError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.status = status;
  }
}

export function check(condition, message, status) {
  if (!condition) throw new GameError(message, status);
}

export function freshRoom(type, number) {
  return {
    id: type + '-' + number, type, number, revision: 0, configEpoch: 0,
    owner: null, seats: [], recoveries: {}, ownerChanges: [],
    config: type === 'wolf' ? { board: null, winMode: 'city', nightSeconds: 180, sheriffEnabled: true, lastWords: true } : { preset: 'base', ladyEnabled: true },
    game: null
  };
}

export const active = room => room.game && room.game.phase !== 'ended';
const living = game => game.players.filter(p => p.alive);
const person = (game, id) => game.players.find(p => p.id === id);
const evil = player => ROLES[player.role].side === '邪恶';
const mine = (obj, key) => Object.hasOwn(obj, key);
const total = values => values.reduce((sum, value) => sum + value, 0);

function shuffled(list) {
  const result = list.slice();
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function boardInfo(room) {
  const count = room.seats.length;
  const within = count >= GAMES[room.type].min && count <= GAMES[room.type].max;
  if (room.type === 'wolf') {
    const counts = room.config.board ?? WOLF_BOARDS[count] ?? WOLF_BOARDS[6];
    const [wolves, villagers, ...specials] = counts;
    const gods = total(specials);
    const good = villagers + gods;
    const size = wolves + good;
    const edgeOk = villagers > 0 && gods > 0;
    let error = '';
    if (!within) error = '狼人杀需要 6–12 人。';
    else if (size !== count) error = '身份牌总数必须等于在座人数。';
    else if (!wolves || !good) error = '至少需要一名狼人和一名好人。';
    else if (room.config.winMode === 'edge' && !edgeOk) error = '屠边需要平民和神职同时存在。';
    const warnings = [];
    if (wolves && wolves >= good) warnings.push('狼人数量达到或超过好人，阵营可能失衡。');
    if (specials.some(n => n > 1)) warnings.push('娱乐板子，重复神职按座位独立行动。');
    if (!villagers || !gods) warnings.push('此板子缺少平民或神职，仅可使用屠城。');
    return { counts, size, wolves, villagers, gods, good, edgeOk, error, warnings };
  }
  const [good, bad] = AVALON_COUNTS[count] ?? AVALON_COUNTS[5];
  const options = Object.entries(AVALON_PRESETS).map(([id, value]) => ({
    id, name: value.name, valid: value.good.length < good && value.evil.length < bad
  }));
  const preset = AVALON_PRESETS[room.config.preset];
  const validPreset = options.find(o => o.id === room.config.preset)?.valid;
  const roles = [
    'merlin', ...preset.good, ...Array(Math.max(0, good - 1 - preset.good.length)).fill('loyal'),
    'assassin', ...preset.evil, ...Array(Math.max(0, bad - 1 - preset.evil.length)).fill('minion')
  ];
  const error = !within ? '阿瓦隆需要 5–10 人。' : validPreset ? '' : '当前人数容纳不了所选的预设。';
  return { good, bad, options, roles, error };
}

export function clearReady(room) {
  room.configEpoch += 1;
  for (const seat of room.seats) seat.ready = seat.id === room.owner;
}

export function updateConfig(room, settings) {
  check(!room.game, '请在开局前调整设置。');
  let config;
  if (room.type === 'wolf') {
    const { board, winMode, nightSeconds } = settings;
    check(board === null || (Array.isArray(board) && board.length === WOLF_KEYS.length
      && board.every(n => Number.isInteger(n) && n >= 0 && n <= 12)), '请输入 0–12 之间的整数身份数量。', 400);
    check(['city', 'edge'].includes(winMode) && mine(NIGHT_SCHEDULE, nightSeconds), '请选择可用的胜负和夜晚模式。', 400);
    const effective = board ?? WOLF_BOARDS[room.seats.length] ?? WOLF_BOARDS[6];
    check(winMode !== 'edge' || (effective[1] && total(effective.slice(2))), '屠边需要平民和神职同时存在。');
    for(const key of ['sheriffEnabled','lastWords'])check(settings[key]===undefined || typeof settings[key]==='boolean','扩展规则开关必须是布尔值。',400);
    config = { board, winMode, nightSeconds: Number(nightSeconds), sheriffEnabled: settings.sheriffEnabled ?? room.config.sheriffEnabled ?? false, lastWords: settings.lastWords ?? room.config.lastWords ?? false };
  } else {
    check(mine(AVALON_PRESETS, settings.preset), '请选择可用的角色预设。', 400);
    check(settings.ladyEnabled===undefined || typeof settings.ladyEnabled==='boolean','湖中仙女开关必须是布尔值。',400);
    config = { preset: settings.preset, ladyEnabled: settings.ladyEnabled ?? room.config.ladyEnabled ?? false };
    check(boardInfo({ ...room, config }).options.find(o => o.id === config.preset).valid,
      '当前人数容纳不了所选的预设。');
  }
  if (JSON.stringify(config) !== JSON.stringify(room.config)) {
    room.config = config;
    clearReady(room);
  }
}

function record(game, kind, data, at, visible = false) {
  game.events.push({ kind, ...data, at, visible });
}

function enter(game, phase, at, due = null) {
  game.phase = phase;
  game.phaseAt = at;
  game.deadline = due;
  game.turn += 1;
}

export function startGame(room, now, forced = false) {
  check(!room.game, '当前房间还不能开始新对局。');
  const info = boardInfo(room);
  check(!info.error, info.error);
  const deck = room.type === 'wolf'
    ? WOLF_KEYS.flatMap((role, index) => Array(info.counts[index]).fill(role))
    : info.roles;
  const roles = shuffled(deck);
  const game = {
    id: randomUUID(), type: room.type, turn: 0, startedAt: now, endedAt: null, outcome: null,
    phase: null, phaseAt: null, deadline: null, confirmed: [],
    players: room.seats.map((seat, index) => ({ id: seat.id, name: seat.name, avatar:seat.avatar??'moon', role: roles[index], alive: true })),
    settings: { ...room.config, ...(room.type === 'wolf' ? { board: info.counts.slice() } : { ladyEnabled: room.seats.length>=8 && room.config.ladyEnabled!==false }) },
    events: [], deaths: []
  };
  if (game.type === 'wolf') {
    game.wolf = { day: 1, previousGuard: {}, potions: {}, checks: {}, night: null, ballot: null, hunter: null, sheriff: {holder:null,broken:false,flow:[],election:{completed:false,signups:{},candidates:[],voters:[],votes:{},pk:false}}, aftermath:null, wordsActor:null, exiled:null };
    for (const p of game.players.filter(player => player.role === 'witch')) {
      game.wolf.potions[p.id] = { save: true, poison: true };
    }
  } else {
    game.avalon = {
      round: 0, leader: randomInt(game.players.length), rejects: 0, team: [],
      votes: {}, cards: {}, results: [], lady: {holder:null,used:[],history:[],completed:[],lastActor:null}
    };
  }
  if(game.avalon?.lady && game.settings.ladyEnabled)game.avalon.lady.holder=game.players[(game.avalon.leader+game.players.length-1)%game.players.length].id;
  room.game = game;
  record(game, 'start', { forced, owner: room.owner }, now, true);
  enter(game, 'identity', now, now + IDENTITY_TIME);
}

export function autoStart(room, now) {
  if (!room.game && room.seats.length && room.seats.every(p => p.ready) && !boardInfo(room).error) {
    startGame(room, now);
  }
}

export function initialIntel(game, player) {
  if (player.role === 'wolf') {
    return { label: '狼队同伴', players: game.players.filter(p => p.role === 'wolf' && p.id !== player.id).map(p => p.id) };
  }
  if (game.type !== 'avalon') return null;
  if (player.role === 'merlin') {
    return { label: '已知邪恶座位', players: game.players.filter(p => evil(p) && p.role !== 'mordred').map(p => p.id) };
  }
  if (player.role === 'percival') {
    return { label: '梅林候选座位', players: game.players.filter(p => ['merlin', 'morgana'].includes(p.role)).map(p => p.id) };
  }
  if (evil(player) && player.role !== 'oberon') {
    return { label: '已知邪恶同伴', players: game.players.filter(p => evil(p) && p.role !== 'oberon' && p.id !== player.id).map(p => p.id) };
  }
  return null;
}

function finish(game, winner, reason, now) {
  game.outcome = { winner, reason };
  game.endedAt = now;
  record(game, 'finish', game.outcome, now, true);
  enter(game, 'ended', now);
}

export function wolfWinner(game) {
  const alive = living(game);
  const wolves = alive.some(p => p.role === 'wolf');
  const good = alive.some(p => p.role !== 'wolf');
  if (!wolves && !good) return ['draw', '双方同阶段全部出局'];
  if (!wolves) return ['good', '所有狼人已出局'];
  if (game.settings.winMode === 'city' && !good) return ['wolf', '所有好人已出局'];
  if (game.settings.winMode === 'edge') {
    if (!alive.some(p => p.role === 'villager')) return ['wolf', '所有平民已出局'];
    if (!alive.some(p => p.role !== 'wolf' && p.role !== 'villager')) return ['wolf', '所有神职已出局'];
  }
  return null;
}

function applyDeath(game, id, cause, now, period=NIGHT_PHASES.includes(game.phase)?'night':'day') {
  const player = person(game, id);
  if (!player?.alive) return false;
  player.alive = false;
  game.deaths.push({ id, cause, period, at: now, day: game.wolf.day });
  return true;
}

function beginNight(game, now) {
  const schedule = NIGHT_SCHEDULE[game.settings.nightSeconds];
  game.wolf.night = {
    end: now + schedule[2] * 1000, bounds: schedule.map(s => now + s * 1000),
    actions: {}, ready: {}, drafts: {}, canAdvanceEarly: true,
    bite: null, deaths: [], noticeUntil: null
  };
  game.wolf.ballot = null;
  record(game, 'night', { day: game.wolf.day }, now, true);
  enter(game, 'night_one', now, game.wolf.night.bounds[0]);
}

function witchCanSave(game, player) {
  const night = game.wolf.night;
  return game.wolf.potions[player.id].save && night.bite
    && (game.wolf.day === 1 || player.id !== night.bite);
}

function nightActors(game) {
  const stage = NIGHT_PHASES.indexOf(game.phase);
  if (stage === -1) return [];
  return living(game).filter(p => {
    if (!phaseRoles[stage].includes(p.role)) return false;
    if (stage === 1) return game.wolf.night.actions[p.id] || game.wolf.potions[p.id].poison || witchCanSave(game, p);
    if (stage === 2) return game.wolf.night.deaths.some(d => d.id === p.id && d.cause === 'bite');
    return true;
  });
}

function countVotes(votes, weights={}) {
  const tally = {};
  for (const [voter,target] of Object.entries(votes)) {
    if (target) tally[target] = (tally[target] ?? 0) + (weights[voter]??1);
  }
  const max = Math.max(0, ...Object.values(tally));
  return { tally, leaders: Object.keys(tally).filter(id => tally[id] === max) };
}

function lockWolfTargets(game, now) {
  const night = game.wolf.night;
  const votes = Object.fromEntries(living(game).filter(p => p.role === 'wolf').map(p => [
    p.id, night.actions[p.id]?.target ?? null
  ]));
  const { leaders } = countVotes(votes);
  night.bite = leaders.length ? leaders[randomInt(leaders.length)] : null;
  for (const guard of living(game).filter(p => p.role === 'guard')) {
    game.wolf.previousGuard[guard.id] = night.actions[guard.id]?.target ?? null;
  }
  record(game, 'wolf_bite', { votes, leaders, target: night.bite }, now);
  enter(game, 'night_two', now, night.bounds[1]);
}

function lockWitches(game, now) {
  const night = game.wolf.night;
  const actions = Object.values(night.actions);
  const guarded = night.bite && actions.some(a => a.kind === 'guard' && a.target === night.bite);
  const saved = night.bite && actions.some(a => a.kind === 'save' && a.target === night.bite);
  const poisoned = new Set(actions.filter(a => a.kind === 'poison').map(a => a.target));
  night.deaths = [];
  if (night.bite && Boolean(guarded) === Boolean(saved) && !poisoned.has(night.bite)) {
    night.deaths.push({ id: night.bite, cause: 'bite' });
  }
  for (const id of poisoned) night.deaths.push({ id, cause: 'poison' });
  record(game, 'night_resolution', { day: game.wolf.day, bite: night.bite, guarded: Boolean(guarded), saved: Boolean(saved), deaths: night.deaths }, now);
  if (night.deaths.some(d => d.cause === 'poison' && person(game, d.id).role === 'hunter')) {
    night.noticeUntil = Math.min(night.end, now + POISON_NOTICE_TIME);
  }
  enter(game, 'night_three', now, night.end);
}

// Sheriff is a public office, never an extra secret role/card.
function sheriffSignupDone(game, now) {
  const e=game.wolf.sheriff.election;
  e.candidates=game.players.filter(p=>p.alive && e.signups[p.id]).map(p=>p.id);
  if(e.candidates.length<2) return completeSheriff(game,e.candidates[0]??null,now);
  enter(game,'sheriff_speech',now);
}
function completeSheriff(game, target, now) {
  const s=game.wolf.sheriff;
  s.holder=target;s.election.completed=true;
  if(!target)s.broken=true;
  record(game,'sheriff_elected',{target},now,true);
  resolveDawn(game,now);
}
function openSheriffVote(game, pk, now) {
  const e=game.wolf.sheriff.election;
  if(!pk)e.voters=game.players.filter(p=>p.alive && !e.candidates.includes(p.id)).map(p=>p.id);
  e.votes={};e.pk=pk;
  if(!e.voters.length) return completeSheriff(game,null,now);
  enter(game,pk?'sheriff_pk_vote':'sheriff_vote',now);
}
function settleSheriffVote(game, now) {
  const e=game.wolf.sheriff.election;
  const votes=Object.fromEntries(e.voters.map(id=>[id,e.votes[id]??null]));
  const {tally,leaders}=countVotes(votes);
  record(game,'sheriff_vote',{pk:e.pk,votes,tally,candidates:e.candidates.slice()},now,true);
  if(!e.pk && leaders.length>1){e.candidates=leaders;enter(game,'sheriff_pk_speech',now);}
  else completeSheriff(game,leaders.length===1?leaders[0]:null,now);
}
function beginAftermath(game, now, resume, wordIds=[]) {
  const winner=wolfWinner(game);
  if(winner)return finish(game,...winner,now);
  game.wolf.aftermath={resume,words:game.settings.lastWords?wordIds.slice():[]};
  continueAftermath(game,now);
}
function continueAftermath(game, now) {
  const w=game.wolf,s=w.sheriff;
  if(s?.holder && !person(game,s.holder)?.alive && !s.broken) {
    enter(game,'badge_transfer',now,now+30_000);return;
  }
  const next=w.aftermath.words.shift();
  if(next){w.wordsActor=next;enter(game,'last_words',now,now+60_000);record(game,'last_words',{actor:next,day:w.day},now,true);return;}
  w.wordsActor=null;
  const resume=w.aftermath.resume;w.aftermath=null;
  enter(game,resume,now,now+RESULT_TIME);
}
function transferBadge(game, target, now, forced=false) {
  const s=game.wolf.sheriff;
  const previous=s.holder;s.holder=target;s.flow=[];
  if(!target)s.broken=true;
  record(game,'badge_transfer',{actor:previous,target,forced},now,true);
  continueAftermath(game,now);
}
function sheriffAction(room, actor, action, data, now) {
  const g=room.game,w=g.wolf,s=w.sheriff,p=person(g,actor),phase=g.phase;
  const owner=room.owner===actor;
  check(g.settings.sheriffEnabled && s,'本局未启用警长。',403);
  check(['sheriffSignup','sheriffAdvance','sheriffVote','sheriffBadge','sheriffFlow'].includes(action),'未知警长操作。',400);
  const e=s.election;
  if(action==='sheriffSignup') {
    check(['sheriff_signup','sheriff_speech'].includes(phase) && p.alive,'当前不能调整上警状态。',403);
    check(typeof data.run==='boolean','请选择上警或不上警。',400);
    if(phase==='sheriff_speech')check(e.candidates.includes(actor) && data.run===false,'发言阶段仅候选人可退水。',403);
    e.signups[actor]=data.run;
    if(phase==='sheriff_speech'){e.candidates=e.candidates.filter(id=>id!==actor);if(e.candidates.length<2)completeSheriff(g,e.candidates[0]??null,now);}
    else if(g.players.filter(p=>p.alive).every(p=>mine(e.signups,p.id)))sheriffSignupDone(g,now);
  } else if(action==='sheriffAdvance') {
    check(owner,'只有房主可以推进现场竞选。',403);
    if(phase==='sheriff_signup')sheriffSignupDone(g,now);
    else if(['sheriff_speech','sheriff_pk_speech'].includes(phase))openSheriffVote(g,phase==='sheriff_pk_speech',now);
    else throw new GameError('当前不能推进竞选。');
  } else if(action==='sheriffVote') {
    check(['sheriff_vote','sheriff_pk_vote'].includes(phase) && e.voters.includes(actor),'只有警下选民可以投警长票。',403);
    check(!mine(e.votes,actor),'警长选票已锁定。');
    check(data.target===null || e.candidates.includes(data.target),'请选择竞选候选人。',400);
    e.votes[actor]=data.target;
    if(e.voters.every(id=>mine(e.votes,id)))settleSheriffVote(g,now);
  } else if(action==='sheriffBadge') {
    check(phase==='badge_transfer' && s.holder===actor,'只有出局的警长可移交或撕毁警徽。',403);
    check(data.confirm===true && (data.target===null || person(g,data.target)?.alive),'请确认一名存活玩家或撕毁警徽。',400);
    transferBadge(g,data.target,now);
  } else if(action==='sheriffFlow') {
    check(s.holder===actor && p.alive && !NIGHT_PHASES.includes(phase),'当前仅存活警长可公开警徽流。',403);
    check(Array.isArray(data.targets) && data.targets.length<=2 && new Set(data.targets).size===data.targets.length
      && data.targets.every(id=>id!==actor && person(g,id)?.alive),'请选择最多两个不同的存活目标。',400);
    s.flow=data.targets.slice();record(g,'sheriff_flow',{actor,targets:s.flow},now,true);
  }
}

function dawn(game, now) {
  const w=game.wolf;
  if(w.day===1 && game.settings.sheriffEnabled && !w.sheriff.election.completed) {
    w.pendingDawn=w.night;w.night=null;
    enter(game,'sheriff_signup',now,now+60_000);return;
  }
  resolveDawn(game,now);
}

function resolveDawn(game, now) {
  const night = game.wolf.pendingDawn??game.wolf.night;
  const before = game.deaths.length;
  for (const death of night.deaths) applyDeath(game, death.id, death.cause, now,'night');
  for (const player of game.players) {
    const action = night.actions[player.id];
    if (action?.kind === 'night_shot') applyDeath(game, action.target, 'shot', now,'night');
  }
  record(game, 'dawn', { day: game.wolf.day, dead: game.deaths.slice(before).map(d => d.id) }, now, true);
  game.wolf.night = null;game.wolf.pendingDawn=null;
  const words=game.wolf.day===1?game.deaths.slice(before).map(d=>d.id):[];
  beginAftermath(game,now,'dawn',words);
}

function nightStep(game, now) {
  const night = game.wolf.night;
  const allReady = nightActors(game).every(p => night.ready[p.id]);
  const timedOut = now >= game.deadline;
  const early = night.canAdvanceEarly && allReady && (!night.noticeUntil || now >= night.noticeUntil);
  if (!timedOut && !early) return false;
  if (!allReady) night.canAdvanceEarly = false;
  const at = timedOut ? game.deadline : now;
  if (game.phase === 'night_one') lockWolfTargets(game, at);
  else if (game.phase === 'night_two') lockWitches(game, at);
  else dawn(game, at);
  return true;
}

function nightSubmit(game, player, data, now) {
  const night = game.wolf.night;
  check(nightActors(game).some(p => p.id === player.id), '当前没有可提交的夜间行动。', 403);
  check(!mine(night.actions, player.id), '你的本阶段行动已锁定。');
  const { choice, target } = data;
  let action;
  if (choice === 'pass') {
    action = { kind: 'pass', role: player.role, target: null };
  } else if (player.role === 'witch' && choice === 'save') {
    check(witchCanSave(game, player), '本夜不能使用解药。');
    game.wolf.potions[player.id].save = false;
    action = { kind: 'save', target: night.bite };
  } else {
    check(typeof target === 'string' && person(game, target)?.alive, '请选择一名存活的玩家。');
    switch (player.role) {
      case 'wolf':
        check(choice === 'target', '请选择刀票目标。', 400);
        action = { kind: 'bite_vote', target };
        delete night.drafts[player.id];
        break;
      case 'guard':
        check(choice === 'target' && target !== game.wolf.previousGuard[player.id], '不能连续两夜守护同一人。');
        action = { kind: 'guard', target };
        break;
      case 'seer': {
        check(choice === 'target', '请选择查验目标。', 400);
        const camp = person(game, target).role === 'wolf' ? '狼人' : '好人';
        (game.wolf.checks[player.id] ??= []).push({ day: game.wolf.day, target, camp });
        action = { kind: 'inspect', target, camp };
        break;
      }
      case 'witch':
        check(choice === 'poison' && game.wolf.potions[player.id].poison, '本夜不能使用毒药。');
        game.wolf.potions[player.id].poison = false;
        action = { kind: 'poison', target };
        break;
      case 'hunter':
        check(choice === 'target' && target !== player.id, '请选择另一名存活玩家。');
        action = { kind: 'night_shot', target };
        break;
      default: throw new GameError('当前没有这个夜间技能。', 403);
    }
  }
  if (player.role === 'wolf') delete night.drafts[player.id];
  night.actions[player.id] = action;
  record(game, 'night_action', { day: game.wolf.day, actor: player.id, action }, now);
}

function endWolfDay(game, now) {
  const words=game.wolf.exiled?[game.wolf.exiled]:[];game.wolf.exiled=null;
  beginAftermath(game,now,'day_result',words);
}

function openBallot(game, pk, now) {
  const candidates = pk ? game.wolf.ballot.candidates : living(game).map(p => p.id);
  const voters = living(game).filter(p => !pk || !candidates.includes(p.id)).map(p => p.id);
  game.wolf.ballot = { candidates, voters, votes: {}, pk };
  if (!voters.length) settleDayVote(game, now);
  else enter(game, pk ? 'pk_vote' : 'day_vote', now);
}

function settleDayVote(game, now) {
  const { pk, candidates, voters, votes } = game.wolf.ballot;
  const complete = Object.fromEntries(voters.map(id => [id, votes[id] ?? null]));
  const sheriff=game.wolf.sheriff?.holder;
  const weights=Object.fromEntries(voters.map(id=>[id,id===sheriff?1.5:1]));
  const { tally, leaders } = countVotes(complete,weights);
  const target = leaders.length === 1 ? leaders[0] : null;
  record(game, 'day_vote', { day: game.wolf.day, pk, candidates, votes: complete, weights, tally, leaders, target }, now, true);
  if (!pk && leaders.length > 1) {
    const eligible = living(game).some(p => !leaders.includes(p.id));
    if (eligible) {
      game.wolf.ballot = { candidates: leaders, voters: [], votes: {}, pk: true };
      enter(game, 'pk_discussion', now);
    } else {
      record(game, 'no_exile', { day: game.wolf.day, reason: 'PK 无可投票玩家' }, now, true);
      endWolfDay(game, now);
    }
    return;
  }
  if (!target) {
    record(game, 'no_exile', { day: game.wolf.day, reason: leaders.length ? 'PK 再次平票' : '没有有效选票' }, now, true);
    endWolfDay(game, now);
    return;
  }
  applyDeath(game, target, 'exile', now);
  game.wolf.exiled=target;
  record(game, 'exile', { day: game.wolf.day, target }, now, true);
  if (person(game, target).role === 'hunter') {
    game.wolf.hunter = target;
    enter(game, 'day_hunter', now);
  } else {
    endWolfDay(game, now);
  }
}

function avalonTeamSize(game) {
  return AVALON_TASKS[game.players.length][game.avalon.round];
}

export function avalonThreshold(game) {
  return game.avalon.round === 3 && game.players.length >= 7 ? 2 : 1;
}

function nextLeader(game, now) {
  const av = game.avalon;
  av.leader = (av.leader + 1) % game.players.length;
  av.team = [];
  av.votes = {};
  av.cards = {};
  enter(game, 'nomination', now);
}

function settleTeam(game, now, nominationSkipped = false) {
  const av = game.avalon;
  const votes = nominationSkipped ? {} : Object.fromEntries(game.players.map(p => [p.id, av.votes[p.id] ?? 'no']));
  const yes = Object.values(votes).filter(v => v === 'yes').length;
  const passed = !nominationSkipped && yes > game.players.length / 2;
  if (!passed) av.rejects += 1;
  record(game, 'team_vote', {
    round: av.round + 1, leader: game.players[av.leader].id,
    team: av.team.slice(), votes, yes, passed, rejected: av.rejects, nominationSkipped
  }, now, true);
  if (passed) {
    av.rejects = 0;
    enter(game, 'mission', now);
  } else if (av.rejects >= 5) {
    finish(game, 'evil', '同一任务连续五次组队被否决', now);
  } else {
    nextLeader(game, now);
  }
}

function settleMission(game, now) {
  const av = game.avalon;
  const cards = Object.fromEntries(av.team.map(id => [id, av.cards[id] ?? 'success']));
  const defaults = av.team.filter(id => !mine(av.cards, id));
  const fail = Object.values(cards).filter(card => card === 'fail').length;
  const success = av.team.length - fail;
  const passed = fail < avalonThreshold(game);
  const result = { round: av.round + 1, leader: game.players[av.leader].id, team: av.team.slice(), fail, success, passed };
  av.results.push(result);
  record(game, 'mission_result', result, now, true);
  record(game, 'mission_cards', { round: av.round + 1, cards, defaults }, now);
  enter(game, 'mission_result', now, now + RESULT_TIME);
}

function afterMission(game, now) {
  const av = game.avalon;
  if (av.results.filter(r => !r.passed).length === 3) {
    finish(game, 'evil', '三次任务失败', now);
  } else if (av.results.filter(r => r.passed).length === 3) {
    enter(game, 'assassination', now);
    record(game, 'assassination_open', {}, now, true);
  } else if (game.settings.ladyEnabled && [1,2,3].includes(av.round) && !av.lady.completed.includes(av.round)) {
    enter(game,'lady_lake',now);
  } else nextQuest(game,now);
}
function nextQuest(game,now){const av=game.avalon;av.round+=1;av.rejects=0;nextLeader(game,now);}

export function advance(room, now) {
  const game = room.game;
  if (!game || game.phase === 'ended') return false;
  let changed = false;
  for (;;) {
    if (NIGHT_PHASES.includes(game.phase)) {
      if (!nightStep(game, now)) break;
    } else if (game.phase === 'identity' && (now >= game.deadline || game.confirmed.length === game.players.length)) {
      const at = Math.min(now, game.deadline);
      if (game.type === 'wolf') beginNight(game, at);
      else enter(game, 'nomination', at);
    } else if (game.phase === 'sheriff_signup' && now>=game.deadline) {
      sheriffSignupDone(game,game.deadline);
    } else if (game.phase === 'badge_transfer' && now>=game.deadline) {
      transferBadge(game,null,game.deadline,true);
    } else if (game.phase === 'last_words' && now>=game.deadline) {
      record(game,'words_end',{actor:game.wolf.wordsActor,timeout:true},game.deadline,true);
      continueAftermath(game,game.deadline);
    } else if (game.phase === 'lady_result' && now>=game.deadline) {
      nextQuest(game,game.deadline);
    } else if (game.phase === 'dawn' && now >= game.deadline) {
      enter(game, 'discussion', game.deadline);
    } else if (game.phase === 'day_result' && now >= game.deadline) {
      game.wolf.day += 1;
      beginNight(game, game.deadline);
    } else if (game.phase === 'mission_result' && now >= game.deadline) {
      afterMission(game, game.deadline);
    } else {
      break;
    }
    changed = true;
  }
  return changed;
}

function logForce(game, actor, operation, now, missing = []) {
  record(game, 'host_action', { actor, operation, missing }, now, true);
}

export function transferOwner(room, target, now, reason) {
  if (room.owner === target) return;
  const previous = room.owner;
  room.owner = target;
  (room.ownerChanges ??= []).push({ previous, target, at: now, reason });
  if (room.ownerChanges.length > 50) room.ownerChanges.shift();
  if (!room.game) clearReady(room);
  if (active(room)) record(room.game, 'owner_change', { previous, target, reason }, now, true);
}

export function play(room, actor, action, data, now) {
  check(active(room), '当前没有进行中的对局。');
  const game = room.game;
  const p = person(game, actor);
  check(p, '你没有本局的席位。', 403);
  const isOwner = room.owner === actor;
  const phase = game.phase;
  const { target } = data;
  if(typeof action==='string' && action.startsWith('sheriff')){check(game.type==='wolf','仅狼人杀有警长。',403);sheriffAction(room,actor,action,data,now);return;}
  if(action==='finishWords'){check(phase==='last_words' && game.wolf.wordsActor===actor,'当前不是你的遗言时间。',403);record(game,'words_end',{actor,timeout:false},now,true);continueAftermath(game,now);return;}
  if (action === 'identityConfirm') {
    check(phase === 'identity', '已进入游戏流程。');
    if (!game.confirmed.includes(actor)) game.confirmed.push(actor);
    return;
  }
  if (action === 'forcePhase') {
    check(isOwner && data.confirm === true, '此操作需要房主二次确认。', 403);
    if(['sheriff_vote','sheriff_pk_vote'].includes(phase)){
      logForce(game,actor,'结束警长投票，未投按弃权',now,game.wolf.sheriff.election.voters.filter(id=>!mine(game.wolf.sheriff.election.votes,id)));settleSheriffVote(game,now);
    } else if(phase==='badge_transfer'){logForce(game,actor,'等待结束，撕毁警徽',now);transferBadge(game,null,now,true);
    } else if(phase==='last_words'){logForce(game,actor,'结束遗言',now,[game.wolf.wordsActor]);continueAftermath(game,now);
    } else if(phase==='lady_lake'){
      logForce(game,actor,'跳过湖中仙女查验',now,[game.avalon.lady.holder]);game.avalon.lady.completed.push(game.avalon.round);nextQuest(game,now);
    } else if(phase==='lady_result'){logForce(game,actor,'结束仙女结果查看',now);nextQuest(game,now);
    } else if (phase === 'day_vote' || phase === 'pk_vote') {
      const ballot = game.wolf.ballot;
      logForce(game, actor, '跳过当前放逐投票', now, ballot.voters.filter(id => !mine(ballot.votes, id)));
      settleDayVote(game, now);
    } else if (phase === 'nomination') {
      logForce(game, actor, '跳过本次提名', now, [game.players[game.avalon.leader].id]);
      settleTeam(game, now, true);
    } else if (phase === 'team_vote') {
      logForce(game, actor, '结束组队投票', now, game.players.filter(p => !mine(game.avalon.votes, p.id)).map(p => p.id));
      settleTeam(game, now);
    } else if (phase === 'mission') {
      logForce(game, actor, '结束任务等待', now, game.avalon.team.filter(id => !mine(game.avalon.cards, id)));
      settleMission(game, now);
    } else if (phase === 'assassination') {
      logForce(game, actor, '放弃刺杀', now);
      finish(game, 'good', '房主确认放弃刺杀', now);
    } else {
      throw new GameError('这个阶段不能强制结束。');
    }
    return;
  }
  switch (action) {
    case 'wolfDraft': {
      check(phase === 'night_one' && p.alive && p.role === 'wolf', '当前没有狼队刀票权限。', 403);
      const night = game.wolf.night;
      check(!mine(night.actions, actor), '你的刀票已锁定。');
      check(target === null || (typeof target === 'string' && person(game, target)?.alive), '请选择一名存活玩家。');
      night.drafts[actor] = target;
      return;
    }
    case 'nightSubmit':
      check(game.type === 'wolf' && NIGHT_PHASES.includes(phase), '当前不在狼人杀夜间阶段。', 403);
      nightSubmit(game, p, data, now);
      return;
    case 'nightReady':
      check(nightActors(game).some(player => player.id === actor) && mine(game.wolf.night.actions, actor),
        '先提交或主动放弃本阶段行动。');
      game.wolf.night.ready[actor] = true;
      return;
    case 'openDayVote':
      check(isOwner && ['discussion', 'pk_discussion'].includes(phase), '当前无法开始投票。', 403);
      openBallot(game, phase === 'pk_discussion', now);
      return;
    case 'dayVote': {
      check(['day_vote', 'pk_vote'].includes(phase), '当前不在放逐投票阶段。');
      const ballot = game.wolf.ballot;
      check(ballot.voters.includes(actor), '你没有本轮投票权限。', 403);
      check(!mine(ballot.votes, actor), '你已锁定本轮选票。');
      check(target === null || ballot.candidates.includes(target), '该玩家不在候选名单。', 400);
      ballot.votes[actor] = target;
      if (ballot.voters.every(id => mine(ballot.votes, id))) settleDayVote(game, now);
      return;
    }
    case 'dayShot':
      check(phase === 'day_hunter' && game.wolf.hunter === actor, '你没有当前的开枪权限。', 403);
      check(target === null || person(game, target)?.alive, '请选择仍存活的玩家。');
      if (target) applyDeath(game, target, 'shot', now);
      record(game, 'day_shot', { actor, target }, now, true);
      game.wolf.hunter = null;
      endWolfDay(game, now);
      return;
    case 'ladyInspect': {
      const av=game.avalon;
      check(phase==='lady_lake' && game.settings.ladyEnabled && av.lady.holder===actor,'只有当前仙女持有者可以查验。',403);
      check(data.confirm===true && target!==actor && person(game,target) && !av.lady.used.includes(target),'不能查验自己或曾用过仙女的玩家。',400);
      const result={round:av.round+1,actor,target,camp:ROLES[person(game,target).role].side};
      av.lady.history.push(result);av.lady.used.push(actor);av.lady.holder=target;av.lady.lastActor=actor;av.lady.completed.push(av.round);
      record(game,'lady_inspect',{round:av.round+1,actor,target},now,true);record(game,'lady_result',result,now);
      enter(game,'lady_result',now,now+20_000);return;
    }
    case 'ladyContinue':
      check(phase==='lady_result' && game.avalon.lady.lastActor===actor,'当前不是你查看仙女结果。',403);nextQuest(game,now);return;
    case 'nominate': {
      check(phase === 'nomination' && game.players[game.avalon.leader].id === actor, '只有当前队长可以提名。', 403);
      const { team } = data;
      check(Array.isArray(team) && team.length === avalonTeamSize(game) && new Set(team).size === team.length
        && team.every(id => person(game, id)), '请选择准确人数的不同队员。', 400);
      game.avalon.team = game.players.filter(player => team.includes(player.id)).map(player => player.id);
      game.avalon.votes = {};
      game.avalon.cards = {};
      enter(game, 'team_vote', now);
      return;
    }
    case 'teamVote':
      check(phase === 'team_vote', '当前不在组队投票阶段。');
      check(!mine(game.avalon.votes, actor), '你的组队选票已锁定。');
      check(['yes', 'no'].includes(data.choice), '请选择同意或反对。', 400);
      game.avalon.votes[actor] = data.choice;
      if (game.players.every(player => mine(game.avalon.votes, player.id))) settleTeam(game, now);
      return;
    case 'missionCard':
      check(phase === 'mission' && game.avalon.team.includes(actor), '只有本轮任务队员可以出牌。', 403);
      check(!mine(game.avalon.cards, actor), '你的任务牌已锁定。');
      check(data.choice === 'success' || (evil(p) && data.choice === 'fail'), '该身份不能提交此任务牌。', 403);
      game.avalon.cards[actor] = data.choice;
      if (game.avalon.team.every(id => mine(game.avalon.cards, id))) settleMission(game, now);
      return;
    case 'assassinate': {
      check(phase === 'assassination' && p.role === 'assassin', '只有刺客可以提交目标。', 403);
      check(data.confirm === true && target !== actor && person(game, target), '请确认一名其他玩家。', 400);
      const hit = person(game, target).role === 'merlin';
      record(game, 'assassination', { actor, target, hit }, now, true);
      finish(game, hit ? 'evil' : 'good', hit ? '刺客命中梅林' : '刺客未命中梅林', now);
      return;
    }
    default: throw new GameError('未知操作。', 400);
  }
}

export function wolfChatAllowed(room, id) {
  const game = room.game;
  const p = game && person(game, id);
  return Boolean(p?.alive && p.role === 'wolf' && NIGHT_PHASES.includes(game.phase));
}

export function buildArchive(room, now, abortedBy = null) {
  const game = room.game;
  const aborted = Boolean(abortedBy);
  const events = aborted ? [
    ...game.events.filter(e => e.visible),
    { kind: 'host_action', actor: abortedBy, operation: '重置房间并中止对局', missing: [], at: now, visible: true }
  ] : game.events;
  return {
    id: game.id, room: room.id, type: game.type, number: room.number, startedAt: game.startedAt,
    endedAt: aborted ? now : game.endedAt, outcome: aborted ? { winner: 'aborted', reason: '房主重置了房间' } : game.outcome,
    settings: game.settings, events,
    players: aborted ? game.players.map(p => ({ id: p.id, name: p.name, avatar:p.avatar??'moon' })) : game.players.map(p => ({
      id: p.id, name: p.name, avatar:p.avatar??'moon', role: p.role, intel: initialIntel(game, p)
    })),
    deaths: aborted ? [] : game.deaths
  };
}

export function roomStatus(room) {
  if (room.game) return room.game.phase === 'ended' ? 'ended' : 'playing';
  if (!room.seats.length) return 'idle';
  return room.seats.length < GAMES[room.type].min ? 'waiting' : 'ready';
}

export function viewGame(room, actor, chat) {
  const g = room.game;
  const p = person(g, actor);
  const phase = g.phase;
  const view = {
    id: g.id, type: g.type, phase, turn: g.turn, phaseAt: g.phaseAt, deadline: g.deadline,
    players: g.players.map(player => ({ id: player.id, name: player.name, avatar:player.avatar??'moon', alive: player.alive,
      exit: player.alive?null:(g.deaths.find(d=>d.id===player.id)?.period==='night'?'night':g.deaths.find(d=>d.id===player.id)?.cause==='exile'?'exile':g.deaths.find(d=>d.id===player.id)?.cause==='shot'?'shot':'night') })),
    settings:{sheriffEnabled:Boolean(g.settings.sheriffEnabled),lastWords:Boolean(g.settings.lastWords),ladyEnabled:Boolean(g.settings.ladyEnabled)},
    me: { role: p.role, intel: initialIntel(g, p), alive: p.alive, confirmed: g.confirmed.includes(actor) },
    recent: g.events.filter(e => e.visible).slice(-14), outcome: g.outcome
  };
  if (g.type === 'wolf') {
    const w = g.wolf;
    view.day = w.day;
    view.sheriff=w.sheriff?{enabled:Boolean(g.settings.sheriffEnabled),holder:w.sheriff.holder,flow:w.sheriff.flow,broken:w.sheriff.broken}:null;
    if(phase.startsWith('sheriff_')){const e=w.sheriff.election;view.election={candidates:e.candidates,signupCount:Object.keys(e.signups).length,signups:e.signups,eligible:e.voters.includes(actor),submitted:mine(e.votes,actor),count:Object.keys(e.votes).length,total:e.voters.length};if(mine(e.votes,actor))view.election.mine=e.votes[actor];}
    if(phase==='last_words')view.wordsActor=w.wordsActor;
    if(phase==='badge_transfer')view.badgeActor=w.sheriff.holder;
    view.me.checks = w.checks[actor] ?? [];
    if (p.role === 'witch') view.me.potions = w.potions[actor];
    if (p.role === 'guard' && phase === 'night_one') view.me.previousGuard = w.previousGuard[actor] ?? null;
    if (w.night) {
      view.night = { end: w.night.end, seconds: g.settings.nightSeconds };
      view.me.canAct = nightActors(g).some(player => player.id === actor);
      view.me.action = w.night.actions[actor] ?? null;
      view.me.nightReady = Boolean(w.night.ready[actor]);
      if (phase === 'night_two' && p.alive && p.role === 'witch') {
        view.me.bite = w.night.bite;
        view.me.canSave = Boolean(witchCanSave(g, p));
      }
      if (phase === 'night_three' && p.role === 'hunter' && p.alive) {
        view.me.poisoned = w.night.deaths.some(d => d.id === actor && d.cause === 'poison');
      }
      if (wolfChatAllowed(room, actor)) {
        view.me.chat = chat;
        view.me.wolves = living(g).filter(player => player.role === 'wolf').map(player => ({
          id: player.id, draft: w.night.drafts[player.id] ?? null,
          locked: mine(w.night.actions, player.id), target: w.night.actions[player.id]?.target ?? null
        }));
      }
    }
    if (phase === 'pk_discussion' || phase === 'pk_vote' || phase === 'day_vote') {
      view.ballot = {
        candidates: w.ballot.candidates, eligible: w.ballot.voters.includes(actor),
        submitted: mine(w.ballot.votes, actor), count: Object.keys(w.ballot.votes).length, total: w.ballot.voters.length
      };
      if (view.ballot.submitted) view.ballot.mine = w.ballot.votes[actor];
    }
    if (phase === 'day_hunter') view.me.canAct = w.hunter === actor;
  } else {
    const av = g.avalon;
    view.avalon = {
      round: av.round + 1, taskSize: avalonTeamSize(g), threshold: avalonThreshold(g),
      leader: g.players[av.leader].id, rejects: av.rejects, team: av.team, results: av.results
    };
    if(g.settings.ladyEnabled && av.lady){view.avalon.lady={holder:av.lady.holder,used:av.lady.used,eligible:g.players.filter(p=>p.id!==av.lady.holder && !av.lady.used.includes(p.id)).map(p=>p.id)};view.me.ladyChecks=av.lady.history.filter(r=>r.actor===actor);if(phase==='lady_result')view.avalon.lady.viewer=av.lady.lastActor;}
    if (phase === 'team_vote') {
      view.avalon.submitted = Object.keys(av.votes).length;
      view.me.teamVote = av.votes[actor] ?? null;
    }
    if (phase === 'mission') {
      view.avalon.submitted = Object.keys(av.cards).length;
      view.me.card = av.cards[actor] ?? null;
    }
  }
  return view;
}
