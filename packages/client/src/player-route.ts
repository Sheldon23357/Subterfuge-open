import {savedHallToken} from './hall-link-protocol.js';
export interface PlayerRoute {code:string;seat:number}
export function playerHref(code:string,seat:number){
 if(!/^[A-Z0-9]{6}$/.test(code)||!Number.isInteger(seat)||seat<0||seat>9)throw Error('房间或席位无效。');
 return `/player.html?room=${code}&seat=${seat+1}`;
}
export function playerRoute(search:string):PlayerRoute|null{
 const query=new URLSearchParams(search);if(!query.has('room')&&!query.has('seat'))return null;
 const code=query.get('room')??'',seat=query.get('seat')??'';
 if(query.getAll('room').length!==1||query.getAll('seat').length!==1||!/^[A-Z0-9]{6}$/.test(code)||!/^(?:[1-9]|10)$/.test(seat))throw Error('链接中的房间或席位无效，请从大厅重新进入。');
 return {code,seat:Number(seat)-1};
}
export const seatIdentityKey=(code:string,seat:number)=>`subterfuge-hall-identity-${code}-seat-${seat}`;
export function rememberPlayerSeat(storage:Pick<Storage,'setItem'>,value:PlayerRoute&{roomId:string;playerToken:string}){storage.setItem(seatIdentityKey(value.code,value.seat),JSON.stringify(value));}
export async function resolvePlayerRoute(target:PlayerRoute,session:Pick<Storage,'getItem'>,storage:Pick<Storage,'getItem'>&Partial<Pick<Storage,'length'|'key'>>,verify:(code:string,token:string)=>Promise<{roomId:string;seat:number}>){
 const tokens=new Set<string>();
 const stored=storage.getItem(seatIdentityKey(target.code,target.seat));
 if(stored){try{const row=JSON.parse(stored);if(row.code===target.code&&row.seat===target.seat)tokens.add(row.playerToken);}catch{}}
 const legacy=savedHallToken(target.code,storage,session);if(legacy)tokens.add(legacy);
 // Existing bot slots can have independent owner credentials for the same room.
 for(let i=0;i<(storage.length??0);i++){const key=storage.key?.(i);if(key?.startsWith(`subterfuge-ai-identity-${target.code}-`)){const token=storage.getItem(key);if(token)tokens.add(token);}}
 for(const token of tokens){if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))continue;
  try{const identity=await verify(target.code,token);if(identity.seat===target.seat&&typeof identity.roomId==='string'&&identity.roomId)return {...target,roomId:identity.roomId,playerToken:token};}
  catch(error){if((error as {status?:number}).status!==401)throw error;}
 }
 throw Error('本浏览器没有该席位的有效身份，请从大厅或绑定该席位的 AI 控制台进入。');
}
