import { BlockList, isIP } from 'node:net';
export function normalizeIP(raw='') {
  let value=String(raw).trim();
  if(value.startsWith('::ffff:') && isIP(value.slice(7))===4)value=value.slice(7);
  return isIP(value)?value:null;
}
export function createAddressResolver(cidrs='',header='x-forwarded-for') {
  const allowed=['x-forwarded-for','x-original-forwarded-for','x-real-ip'];
  if(!allowed.includes(header))throw new Error('CLIENT_IP_HEADER 必须是受支持的代理 IP 请求头。');
  const trusted=new BlockList();
  for(const entry of cidrs.split(',').map(s=>s.trim()).filter(Boolean)) {
    const [raw,bits]=entry.split('/');const ip=normalizeIP(raw);const version=ip&&isIP(ip);
    if(!ip || (bits!==undefined && (!/^\d+$/.test(bits) || Number(bits)<0 || Number(bits)>(version===4?32:128))))throw new Error('TRUSTED_PROXY_CIDRS 中存在无效地址。');
    if(bits===undefined)trusted.addAddress(ip,version===4?'ipv4':'ipv6');
    else trusted.addSubnet(ip,Number(bits),version===4?'ipv4':'ipv6');
  }
  const matches=ip=>Boolean(ip && trusted.check(ip,isIP(ip)===4?'ipv4':'ipv6'));
  return req=>{
    const peer=normalizeIP(req.socket.remoteAddress)??'unknown';
    if(!matches(peer))return {ip:peer,forwarded:false};
    const raw=req.headers[header];
    if(typeof raw!=='string' || raw.length>2048)return {ip:peer,forwarded:false};
    const chain=raw.split(',').map(normalizeIP);
    if(!chain.length || chain.length>16 || chain.some(ip=>!ip) || (header==='x-real-ip' && chain.length!==1))return {ip:peer,forwarded:false};
    chain.push(peer);
    let index=chain.length-1;
    while(index>0 && matches(chain[index]))index--;
    return {ip:chain[index],forwarded:true};
  };
}
