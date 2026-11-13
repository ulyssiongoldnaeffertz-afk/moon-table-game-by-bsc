import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {createAddressResolver} from './client-address.mjs';
import {createApp} from './server.mjs';
const request=(peer,headers)=>({socket:{remoteAddress:peer},headers});

test('未配置代理时不信任伪造XFF；可信链从右向左遇到首个非代理即停止',()=>{
  assert.deepEqual(createAddressResolver()(request('::ffff:127.0.0.1',{'x-forwarded-for':'1.2.3.4'})),{ip:'127.0.0.1',forwarded:false});
  const trusted=createAddressResolver('10.0.0.0/8,127.0.0.1/32');
  assert.equal(trusted(request('10.1.2.3',{'x-forwarded-for':'6.6.6.6, 203.0.113.21, 10.2.3.4'})).ip,'203.0.113.21');
  assert.equal(trusted(request('198.51.100.5',{'x-forwarded-for':'1.2.3.4'})).forwarded,false);
  assert.equal(trusted(request('10.1.2.3',{'x-forwarded-for':'broken, 1.2.3.4'})).forwarded,false);
  assert.equal(trusted(request('10.1.2.3',{'x-forwarded-for':['1.2.3.4','2.3.4.5']})).forwarded,false);
});

test('CloudBase Original-Forwarded-For、X-Real-IP与IPv6均须显式配置可信网段',()=>{
  assert.equal(createAddressResolver('10.0.0.0/8','x-original-forwarded-for')(request('10.1.1.1',{'x-original-forwarded-for':'203.0.113.4'})).ip,'203.0.113.4');
  assert.equal(createAddressResolver('::1/128','x-real-ip')(request('::1',{'x-real-ip':'2001:db8::7'})).ip,'2001:db8::7');
  assert.throws(()=>createAddressResolver('0.0.0.0/99'),/无效/);assert.throws(()=>createAddressResolver('','user-supplied'),/CLIENT_IP_HEADER/);
});
async function start(){const dir=mkdtempSync(join(process.cwd(),'.qa-proxy-'));const app=createApp({dataDir:dir,storageDriver:'snapshot',clockInterval:0,adminPassword:'test-password-v3',trustedProxyCidrs:'127.0.0.1/32'});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));return{dir,app,origin:'http://127.0.0.1:'+app.server.address().port};}
function client(origin){const cookies=new Map();return async(path,body,extra={})=>{const response=await fetch(origin+path,{method:body?'POST':'GET',headers:{...extra,...(cookies.size?{cookie:[...cookies].map(([k,v])=>k+'='+v).join('; ')}:{}),...(body?{origin,'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});for(const line of response.headers.getSetCookie()){const [k,v]=line.split(';')[0].split('=');if(v)cookies.set(k,v);else cookies.delete(k);}return response;};}

test('同一网关下一个浏览器8次登录失败只限制自身，其他浏览器及房间正常', {timeout:15000},async()=>{
  const s=await start();try {
    const attacker=client(s.origin),other=client(s.origin);
    for(let i=0;i<8;i++)assert.equal((await attacker('/api/admin/login',{password:'wrong'})).status,401);
    assert.equal((await attacker('/api/admin/login',{password:'wrong'})).status,429);
    assert.equal((await other('/api/admin/login',{password:'test-password-v3'})).status,200);
    const guest=client(s.origin);const joined=await guest('/api/rooms/wolf-1/actions',{action:'join',data:{name:'玩家',avatar:'cat'}});assert.equal(joined.status,200);const view=await joined.json();assert.equal(view.seats[0].avatar,'cat');
    assert.equal((await other('/api/admin/overview')).status,200);
  }finally{await s.app.close();rmSync(s.dir,{recursive:true,force:true});}
});

test('不同浏览器超过原全站30次阈值仍各自计数；伪造IP不能重置同一会话桶', {timeout:15000},async()=>{
  const s=await start();try {
    for(let i=0;i<32;i++){const c=client(s.origin);assert.equal((await c('/api/admin/login',{password:'wrong'})).status,401);}
    const one=client(s.origin);for(let i=0;i<8;i++)assert.equal((await one('/api/admin/login',{password:'wrong'},{'x-forwarded-for':'192.0.2.'+(i+1)})).status,401);
    assert.equal((await one('/api/admin/login',{password:'wrong'},{'x-forwarded-for':'203.0.113.250'})).status,429);
    const valid=client(s.origin);assert.equal((await valid('/api/admin/login',{password:'test-password-v3'})).status,200);
  }finally{await s.app.close();rmSync(s.dir,{recursive:true,force:true});}
});
