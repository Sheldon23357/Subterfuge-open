export interface HallLinkTarget {origin:string;nonce:string}
export interface HallLinkRoom {code:string;name:string;players:number;capacity:number;status:string;own:boolean;ownSeat?:number;ownBot?:string}
export function hallTransportOrigin(origin:string){
 const url=new URL(origin);
 if(url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname)){url.protocol='https:';if(url.port==='80')url.port='';}
 return url.origin;
}
export function hallLinkTarget(hash:string):HallLinkTarget|null {
 const values=new URLSearchParams(hash.replace(/^#/,''));
 const origin=values.get('console'),nonce=values.get('nonce');
 if(!origin||!nonce||!/^[a-f0-9]{48}$/.test(nonce))return null;
 try{const url=new URL(origin);if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!url.port||url.origin!==origin)return null;return {origin,nonce};}catch{return null;}
}
export function savedHallToken(code:string,persistent:Pick<Storage,'getItem'>,session:Pick<Storage,'getItem'>):string|null{
 try{
  const stored=JSON.parse(persistent.getItem('subterfuge-hall-identity-'+code)??'null');
  if(stored?.code===code&&typeof stored.playerToken==='string'&&/^[a-f0-9]{64}$/.test(stored.playerToken))return stored.playerToken;
  if(session.getItem('subterfuge-room-code')===code){const token=session.getItem('subterfuge-player-code');if(token&&/^[a-f0-9]{64}$/.test(token))return token;}
  const active=JSON.parse(persistent.getItem('subterfuge-hall-active')??'null');
  if(Array.isArray(active)&&active[1]===code&&typeof active[0]==='string'&&/^[a-f0-9]{64}$/.test(active[0]))return active[0];
 }catch{}
 return null;
}
