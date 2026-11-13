import assert from 'node:assert/strict';
import test from 'node:test';
import { createLearningDeck, shuffledOptions } from './learning.mjs';
import { LEARNING, IDENTITY_TIPS } from './learning-data.mjs';
import { ROLES, WOLF_KEYS } from './game-data.mjs';
const memory=()=>{const data=new Map();return{getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v)}};

test('六身份的策略、术语、案例均12组；全部身份卡各有10条独立提示',()=>{
  assert.deepEqual(Object.keys(LEARNING).sort(),WOLF_KEYS.slice().sort());
  for(const [role,pool] of Object.entries(LEARNING)) {
    for(const [kind,rows] of Object.entries(pool)) {assert.ok(rows.length===12,role+kind);assert.equal(new Set(rows.map(r=>JSON.stringify(r))).size,rows.length);}
    for(const row of pool.strategies) for(const k of ['background','tactic','mistake','prompt']) assert.ok(row[k]?.length>5,role+k);
    assert.equal(new Set(pool.terms.map(r=>r.term)).size,pool.terms.length);
    for(const q of pool.cases) {assert.equal(q.options.length,3);assert.equal(new Set(q.options).size,3);assert.ok(q.answer>=0 && q.answer<3);assert.ok(q.feedback);}
  }
  for(const role of Object.keys(ROLES)) {assert.equal(IDENTITY_TIPS[role].length,10);assert.equal(new Set(IDENTITY_TIPS[role]).size,10);}
});

test('随机牌堆连续跨夜不重复，同夜多次重绘保持内容，跨周期不紧接重复',()=>{
  for(const rng of [()=>0,()=>.5,()=>.999999]) {
    const deck=createLearningDeck({rng});const items=Array.from({length:8},(_,i)=>i);
    const first=items.map((_,i)=>deck.draw('villager:strategy',items,'night'+i));
    assert.equal(new Set(first).size,8);
    assert.equal(deck.draw('villager:strategy',items,'night7'),first[7]);
    assert.notEqual(deck.draw('villager:strategy',items,'night8'),first[7]);
  }
});

test('刷新恢复本晚内容、换一条消耗未读内容，不影响其他文本类别',()=>{
  const storage=memory();const rows=['一','二','三','四'];
  const one=createLearningDeck({storage,rng:()=>.42});
  const original=one.draw('a',rows,'game1:night1');
  const other=one.draw('b',rows,'game1:night1');
  const renewed=one.draw('a',rows,'game1:night1',true);
  assert.notEqual(renewed,original);
  const reloaded=createLearningDeck({storage});
  assert.equal(reloaded.draw('a',rows,'game1:night1'),renewed);
  assert.equal(reloaded.draw('b',rows,'game1:night1'),other);
  const following=reloaded.draw('a',rows,'game1:night2');
  assert.ok(![renewed,original].includes(following));
  const saved=storage.getItem('moon.learning.v2');assert.ok(!saved.includes('game1'));assert.ok(!saved.includes('一'));
});

test('存储禁用、文本池更新、单条文本与无效缓存都有明确处理',()=>{
  const blocked={getItem(){throw Error('blocked')},setItem(){throw Error('blocked')}};
  const deck=createLearningDeck({storage:blocked});
  assert.equal(deck.draw('single',['only'],'one'),'only');
  assert.equal(deck.draw('single',['only'],'two'),'only');
  assert.throws(()=>deck.draw('empty',[],'x'),/不能为空/);
  const storage=memory();const prior=createLearningDeck({storage});prior.draw('x',['a','b'],'1');
  const updated=createLearningDeck({storage});assert.ok(['c','d','e'].includes(updated.draw('x',['c','d','e'],'2')));
  storage.setItem('moon.learning.v2','null');assert.equal(createLearningDeck({storage}).draw('x',['safe'],'x'),'safe');
});

test('案例选项随机排列之后，正确答案与解释保持对应',()=>{
  for(const pool of Object.values(LEARNING)) for(const q of pool.cases) {
    const shuffled=shuffledOptions(q,()=>.3);
    assert.equal(shuffled.filter(r=>r.correct).length,1);
    assert.equal(shuffled.find(r=>r.correct).text,q.options[q.answer]);
    assert.deepEqual(shuffled.map(r=>r.text).sort(),q.options.slice().sort());
  }
});
