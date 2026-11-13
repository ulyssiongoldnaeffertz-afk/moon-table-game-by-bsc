import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
export function decodeMountPath(value) { return value.replace(/\\([0-7]{3})/g, (_,n)=>String.fromCharCode(parseInt(n,8))); }
export function persistentMountFor(path, mountinfo) {
  const target=resolve(path);
  const matches=mountinfo.trim().split('\n').map(line=>{
    const [head,tail]=line.split(' - ');
    if(!tail)return null;
    return {path:decodeMountPath(head.split(' ')[4]),type:tail.split(' ')[0],options:head.split(' ')[5]+','+tail.split(' ').slice(2).join(',')};
  }).filter(m=>m && m.path!=='/' && (target===m.path || target.startsWith(m.path+'/'))).sort((a,b)=>b.path.length-a.path.length);
  const mount=matches[0];
  // CloudBase CFS is NFS. Temporary/overlay/COS FUSE filesystems are deliberately rejected.
  if (!mount || !['nfs','nfs4','ext4','xfs','btrfs','zfs'].includes(mount.type)) return null;
  if (['nfs','nfs4'].includes(mount.type) && /(?:^|,)(?:nolock|local_lock=(?:all|flock))(?:,|$)/.test(mount.options)) return null;
  return mount;
}
if(process.argv[1] && resolve(process.argv[1])===new URL(import.meta.url).pathname) {
  const mount=persistentMountFor(process.env.DATA_DIR || '/mnt/moon-table',readFileSync('/proc/self/mountinfo','utf8'));
  if(!mount) {console.error('DATA_DIR 未位于已挂载的持久文件系统。请先在云托管挂载 CFS；禁止用容器临时磁盘保存游戏。');process.exitCode=1;}
}
