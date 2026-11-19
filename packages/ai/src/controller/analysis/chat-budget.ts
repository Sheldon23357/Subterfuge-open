export const CHAT_LIMIT_PER_TARGET=5;
export function chatTarget(to:number|number[]|null){
 if(to===null)return 'public';
 const recipients=[...new Set(Array.isArray(to)?to:[to])].sort((a,b)=>a-b);
 return recipients.length===1?`player:${recipients[0]}`:`group:${recipients.join(',')}`;
}
export function diplomacyCooldown(now:number,lastSpoke:number|null,spoken:number,chat:{from:number;to:number|number[]|null}[],player:number){
 const incoming=chat.filter(m=>m.from!==player),next=lastSpoke===null?now:Math.max(now,lastSpoke+300);
 return {nowSeconds:now,nextUnsolicitedAtSeconds:spoken>0?now:next,remainingSeconds:spoken>0?0:Math.max(0,next-now),
  replyAllowedTargets:[...new Set(incoming.map(m=>m.from))].sort((a,b)=>a-b),publicReplyAllowed:incoming.some(m=>m.to===null),
  rule:'首次主动发言冷却300规则秒；回复仅对当前来信发送者豁免，群聊须每个接收者都有来信；目标配额仍生效，不新增唤醒。'};
}
export function chatBudget(sent:Record<string,number>,total:number,context?:{now:number;lastSpoke:number|null;chat:{from:number;to:number|number[]|null}[];player:number}){
 return {limitPerTarget:CHAT_LIMIT_PER_TARGET,sentTotal:total,defaultRemaining:CHAT_LIMIT_PER_TARGET,targets:Object.fromEntries(Object.entries(sent).map(([target,count])=>[target,{sent:count,remaining:Math.max(0,CHAT_LIMIT_PER_TARGET-count)}])),
  ...(context?{cooldown:diplomacyCooldown(context.now,context.lastSpoke,total,context.chat,context.player)}:{})};
}
