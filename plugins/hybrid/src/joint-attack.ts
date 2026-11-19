import type {PlayerObservation} from '@subterfuge/bot-sdk/contracts';
import {botDistance} from '@subterfuge/bot-sdk/analysis/tactical-evaluation';
import type {StrategicDirective,Objective} from './contracts.js';
import {BOT_RELATION_POLICY} from './relation-policy.js';
export const JOINT_ATTACK_DEFENSE_FACTOR=0.6;
/** A strategic pressure assumption, never a modification of observed state or
 * battle rules. Proposals, failed sends and deceptive acceptances give no aid. */
export function jointAttackGuidance(o:PlayerObservation,d:StrategicDirective|null,betray:string[]=[]){
 const now=o.view.tick+o.secondsSinceLastTick/600,self=o.view.player;
 if(o.diplomacy){
  const active=o.diplomacy.agreements.filter(a=>a.status==='active'&&a.terms.kind==='joint-attack'&&a.deadline>now&&a.players.includes(self)&&!a.fulfilled[a.players.indexOf(self)]&&!betray.includes(a.id)
   &&o.view.self.active&&!a.players.includes(a.terms.enemy)&&o.intel.some(p=>a.terms.kind==='joint-attack'&&p.player===a.terms.enemy&&p.active)&&a.players.some(p=>p!==self&&o.intel.some(i=>i.player===p&&i.active)));
  const own=o.view.outposts.filter(p=>p.owner===self&&!p.destroyed);
  const counts=new Map<number,number>();
  const targets=o.view.outposts.filter(p=>p.visibility===2&&!p.destroyed&&active.some(a=>a.terms.kind==='joint-attack'&&a.terms.enemy===p.owner))
   .sort((a,b)=>Math.min(Infinity,...own.map(p=>botDistance(p.position,a.position,o.view.size)))-Math.min(Infinity,...own.map(p=>botDistance(p.position,b.position,o.view.size)))||a.id.localeCompare(b.id))
   .filter(p=>{const n=counts.get(p.owner!)??0;if(n>=BOT_RELATION_POLICY.jointTargetsPerEnemy)return false;counts.set(p.owner!,n+1);return true;}).slice(0,BOT_RELATION_POLICY.jointTargets);
  return {attackDefenseFactors:[],
   objectives:targets.map(p=>{
    const obligations=active.filter(a=>a.terms.kind==='joint-attack'&&a.terms.enemy===p.owner).map(a=>{

     return `${a.players[1]===self?'本人已接受':'本人已发起且双方已签署'}夹击；本方需实际占领该敌人的任意一个据点，截止世界日${a.deadline}`;
    });
    return {id:'server-joint:'+p.id,kind:'capture' as const,targets:[p.id],priority:90,reason:obligations.join('；')+'。主动评估进攻、集结和增兵，不等待盟友先动；是否占领由服务器实际结算，投入与来源安全仍须验证'};
   })};
 }
 const agreements=(d?.agreements??[]).filter(a=>o.view.self.active&&a.status==='confirmed'&&a.fulfillment!=='deception'&&a.jointAttack&&a.jointAttack.until>now
  &&(a.expiresWorldDay===null||a.expiresWorldDay>now)&&a.players.length>0
  &&a.players.some(p=>p!==self&&o.intel.find(i=>i.player===p)?.active===true)
  &&a.jointAttack.enemy!==self&&!a.players.includes(a.jointAttack.enemy)
  &&o.intel.find(i=>i.player===a.jointAttack!.enemy)?.active===true);
 const enemies=new Set(agreements.map(a=>a.jointAttack!.enemy));
 const own=o.view.outposts.filter(p=>p.owner===self&&!p.destroyed);
 const targets=o.view.outposts.filter(p=>p.owner!=null&&enemies.has(p.owner)&&!p.destroyed&&p.visibility===2)
  .sort((a,b)=>Math.min(Infinity,...own.map(p=>botDistance(p.position,a.position,o.view.size)))-Math.min(Infinity,...own.map(p=>botDistance(p.position,b.position,o.view.size)))||a.id.localeCompare(b.id)).slice(0,10);
 const objectives:Objective[]=targets.map(p=>({id:'joint-attack:'+p.id,kind:'capture',targets:[p.id],priority:85,reason:'已确认联合进攻：共同敌人两线受压，目标防御按60%静态估算；实际战斗与来源安全独立核验'}));
 return {attackDefenseFactors:targets.map(p=>({target:p.id,factor:JOINT_ATTACK_DEFENSE_FACTOR,until:Math.max(...agreements.filter(a=>a.jointAttack!.enemy===p.owner).map(a=>Math.min(a.jointAttack!.until,a.expiresWorldDay??Infinity)))})),objectives};
}
