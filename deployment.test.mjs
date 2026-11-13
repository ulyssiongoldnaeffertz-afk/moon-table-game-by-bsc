import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createApp } from './server.mjs';
import { openSnapshotStorage } from './snapshot-storage.mjs';
import { persistentMountFor } from './check-mount.mjs';
const temp=()=>mkdtempSync(join(process.cwd(),'.qa-deploy-'));
const waitChild=child=>new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
async function listen(options){const app=createApp(options);await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));return{app,origin:'http://127.0.0.1:'+app.server.address().port};}

test('CloudBase快照重启可恢复房间、座位映射和有权限的历史，外人无法读取',()=>{
  const dir=temp();try {
    const store=openSnapshotStorage(dir);const room={id:'wolf-1',seats:[{id:'p1',device:'device-a'}],game:{id:'g1',phase:'night_two'}};
    const record={id:'g1',room:'wolf-1',type:'wolf',startedAt:1,endedAt:3,outcome:{winner:'good'},players:[{id:'p1',role:'villager'}]};
    store.save(room,record);store.close();const after=openSnapshotStorage(dir);
    assert.deepEqual(after.load(room.id),room);assert.deepEqual(after.match('g1','device-a',false),record);
    assert.equal(after.match('g1','outsider',false),null);assert.equal(after.list('outsider',false,0).rows.length,0);
    assert.equal(after.list('device-a',false,0).rows[0].winner,'good');assert.deepEqual(after.match('g1',null,true),record);
    after.health();after.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('损坏快照拒绝启动，绝不悄悄清空玩家数据',()=>{
  const dir=temp();try {writeFileSync(join(dir,'moon-table.snapshot.json'),'{broken');assert.throws(()=>openSnapshotStorage(dir));}finally{rmSync(dir,{recursive:true,force:true});}
});

test('生产反向代理只允许显式公开源；Secure Cookie和健康检查适配',async()=>{
  const dir=temp();const publicOrigin='https://moon.example.com';const shared=await listen({dataDir:dir,storageDriver:'snapshot',secure:true,publicOrigin,adminPassword:'test-password-2026',clockInterval:0});
  try {
    const response=await fetch(shared.origin+'/');assert.match(response.headers.get('set-cookie'),/HttpOnly.*Secure/);assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/);
    const cookie=response.headers.get('set-cookie').split(';')[0];
    const joinRoom=origin=>fetch(shared.origin+'/api/rooms/wolf-1/actions',{method:'POST',headers:{origin,'content-type':'application/json',cookie},body:JSON.stringify({action:'join',data:{name:'月下玩家'}})});
    assert.equal((await joinRoom('https://evil.example')).status,403);
    assert.equal((await joinRoom(shared.origin)).status,403);
    assert.equal((await joinRoom(publicOrigin)).status,200);
    const lobby=await (await fetch(shared.origin+'/api/lobby',{headers:{cookie}})).json();assert.equal(lobby.rooms.find(r=>r.id==='wolf-1').joined,true);
    const other=await (await fetch(shared.origin+'/api/lobby')).json();assert.ok(other.rooms.every(r=>!r.joined));
    assert.equal((await fetch(shared.origin+'/healthz')).status,200);
    for(const path of ['/favicon.svg','/manifest.webmanifest','/assets/wolf.webp','/assets/knight.webp','/assets/mooncat.webp','/learning.mjs','/learning-data.mjs'])assert.equal((await fetch(shared.origin+path)).status,200,path);
    for(const path of ['/data/moon-table.snapshot.json','/.env','/snapshot-storage.mjs','/rules.mjs'])assert.equal((await fetch(shared.origin+path)).status,404,path);
  } finally {await shared.app.close();rmSync(dir,{recursive:true,force:true});}
});

test('挂载校验拒绝容器根盘、tmpfs、COS挂载及伪装路径，只接受实际持久挂载',()=>{
  const mounts='1 0 0:1 / / rw - overlay overlay rw\n2 1 0:2 / /tmp rw - tmpfs tmpfs rw\n3 1 0:3 / /mnt rw - nfs4 cfs:/ rw\n4 3 0:4 / /mnt/temp rw - tmpfs tmpfs rw\n5 1 0:5 / /cos rw - fuse.cosfs cos rw\n';
  assert.equal(persistentMountFor('/app/data',mounts),null);assert.equal(persistentMountFor('/tmp/data',mounts),null);
  assert.equal(persistentMountFor('/mnt-other/data',mounts),null);assert.equal(persistentMountFor('/cos/data',mounts),null);
  assert.equal(persistentMountFor('/mnt/temp/data',mounts),null);assert.equal(persistentMountFor('/mnt/moon-table',mounts).type,'nfs4');
  assert.equal(persistentMountFor('/mnt/moon-table',mounts.replace('nfs4 cfs:/ rw','nfs4 cfs:/ rw,nolock')),null);
});

test('flock阻止第二个写入进程，旧进程被杀后锁自动释放', {timeout:5000},async()=>{
  const dir=temp();const lock=join(dir,'writer.lock');let holder;
  try {
    holder=spawn('flock',['--no-fork','--exclusive',lock,'node','-e','process.stdout.write("locked\\n");setTimeout(()=>{},30000)']);
    await new Promise((resolve,reject)=>{holder.stdout.once('data',resolve);holder.once('error',reject);});
    const denied=spawn('flock',['-n','-E','75',lock,'node','-e','process.exit(0)']);assert.equal((await waitChild(denied)).code,75);
    // --no-fork makes Node the lock-owning process and receives SIGTERM directly.
    holder.kill('SIGTERM');await waitChild(holder);
    const resumed=spawn('flock',['-n','-E','75',lock,'node','-e','process.exit(0)']);assert.equal((await waitChild(resumed)).code,0);
  } finally {if(holder && holder.exitCode===null)holder.kill('SIGKILL');rmSync(dir,{recursive:true,force:true});}
});

test('拒绝错误公开源格式和未知存储驱动',()=>{
  assert.throws(()=>createApp({publicOrigin:'https://example.com/path'}),/PUBLIC_ORIGIN/);
  assert.throws(()=>createApp({storageDriver:'unknown'}),/STORAGE_DRIVER/);
});
