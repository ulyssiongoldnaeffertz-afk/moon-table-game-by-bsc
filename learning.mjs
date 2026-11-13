// The learning deck is entirely client-side. It never submits a game action.
const opaque = value => { let n=2166136261; for(const c of value) n=Math.imul(n^c.codePointAt(0),16777619); return (n>>>0).toString(36); };
const random = () => globalThis.crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;
export function createLearningDeck({ rng=random, storage=null }={}) {
  let state={};
  try { state=JSON.parse(storage?.getItem('moon.learning.v2') || '{}'); } catch {}
  if (!state || typeof state!=='object' || Array.isArray(state)) state={};
  const save=()=>{try { storage?.setItem('moon.learning.v2',JSON.stringify(state)); } catch {}};
  return {
    draw(key, items, context, renew=false) {
      if (!items?.length) throw new Error('学习文本池不能为空');
      const id=opaque(key);
      const tag=opaque(context);
      let pool=state[id];
      if (!pool || pool.size!==items.length || !Array.isArray(pool.bag) || new Set(pool.bag).size!==pool.bag.length || pool.bag.some(i=>!Number.isInteger(i)||i<0||i>=items.length) || !Number.isInteger(pool.current) || pool.current<0 || pool.current>=items.length) {
        pool=state[id]={size:items.length,bag:[],last:-1,context:null,current:0};
      }
      if (!renew && pool.context===tag) return items[pool.current];
      if (!pool.bag.length) {
        pool.bag=Array.from({length:items.length},(_,i)=>i);
        for(let i=pool.bag.length-1;i>0;i--) { const j=Math.floor(rng()*(i+1)); [pool.bag[i],pool.bag[j]]=[pool.bag[j],pool.bag[i]]; }
        // Never show the previous cycle's last card again at the cycle boundary.
        if(items.length>1 && pool.bag.at(-1)===pool.last) [pool.bag[0],pool.bag[items.length-1]]=[pool.bag[items.length-1],pool.bag[0]];
      }
      pool.current=pool.bag.pop(); pool.last=pool.current; pool.context=tag;
      save();
      return items[pool.current];
    }
  };
}
export function shuffledOptions(question, rng=random) {
  const entries=question.options.map((text,index)=>({text,correct:index===question.answer}));
  for(let i=entries.length-1;i>0;i--) {const j=Math.floor(rng()*(i+1));[entries[i],entries[j]]=[entries[j],entries[i]];}
  return entries;
}
