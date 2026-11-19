import type {FleetScenario,FleetEvent} from './fleet-scenario.js';
import {fleetVisibility} from './visibility.js';
import {appendActivity,type ActivityEvent} from './notification-journal.js';

const kinds=new Set(['launch-ordered','launch-cancelled','departed','fleet-arrived','fleet-recalled','battle','outpost-captured','mine-ordered','mine-cancelled','mine-created','shield-order','shield-disabled']);
// Movement fractions are measured from the beginning of the tick interval;
// the economy tick has already advanced to its end when these events fire.
const movementKinds=new Set(['departed','fleet-arrived','battle','outpost-captured','fleet-recovered','fleet-transferred']);
/** Capture only event-time sonar knowledge. This archive is independent of
 * today's visibility, the time machine, and original alert recipients. */
export function captureActivity(s:FleetScenario,kind:string,subject:string,details:FleetEvent['details']={},fraction=(s.secondsSinceLastTick??0)/600,clockTick?:number){
  if(s.forecastPlayer!==undefined||!kinds.has(kind)&&!['fleet-recovered','fleet-removed','fleet-transferred'].includes(kind))return;
  const fleet=s.fleets.find(f=>f.id===subject&&f.used);
  const post=fleet?undefined:s.economy.outposts.find(o=>o.id===subject);
  if(!fleet&&!post)return;
  const actor=kind==='outpost-captured'?Number(details.owner):fleet?.owner??post?.owner??null;
  for(let player=-1;player<s.economy.players.length;player++){
    const visible=player===-1?null:fleetVisibility(s,player);
    if(visible&&(fleet?visible.fleets[subject]:visible.outposts[subject])!==2&&!(kind==='fleet-transferred'&&player===details.owner))continue;
    const known=(id:string)=>!visible||visible.fleets[id]===2||visible.outposts[id]===2;
    const destination=fleet?{kind:'outpost',id:fleet.destination}:null;
    const event:ActivityEvent={
      id:s.events.length,kind,tick:clockTick??s.economy.tick-(movementKinds.has(kind)?1:0),seconds:Math.round(fraction*600),actor,subject,
      source:fleet?.source&&(!visible||visible.outposts[fleet.source]===2)?fleet.source:null,
      destination,
      drillers:fleet?.drillers??null,
      enabled:kind==='shield-order'?details.amount===1:null,
    };
    if(kind==='fleet-transferred'&&typeof details.beforeOwner==='number'&&typeof details.owner==='number')event.transfer={from:details.beforeOwner,to:details.owner,reason:details.reason==='gift'?'gift':'capture'};
    if(kind==='fleet-recovered'||kind==='fleet-removed'){
      event.termination={outcome:kind==='fleet-recovered'?'recovered':'removed',outpost:typeof details.outpost==='string'?details.outpost:null,drillers:typeof details.drillers==='number'?details.drillers:fleet?.drillers??0};
      // Recovery has an actual destination; an empty removal has no confirmed
      // arrival. Retain its route separately without claiming it completed.
      if(event.termination.outpost)event.destination={kind:'outpost',id:event.termination.outpost};
    }
    if(kind==='fleet-arrived'&&typeof details.outpost==='string'){
      event.destination={kind:'outpost',id:details.outpost};
      event.drillers=typeof details.drillers==='number'?details.drillers:null;
      event.arrival={outpost:details.outpost,outcome:details.outcome==='delivered'?'delivered':'defeated',drillers:event.drillers};
    }
    if(kind==='battle')event.destination=typeof details.target==='string'&&known(details.target)?{kind:s.economy.outposts.some(o=>o.id===details.target)?'outpost':'fleet',id:details.target}:null;
    if(kind==='battle'&&event.destination&&typeof details.attackerBefore==='number'&&typeof details.defenderBefore==='number'&&typeof details.attacker==='number'&&typeof details.defender==='number'){
      event.battle={
        attacker:{player:typeof details.attackerOwner==='number'?details.attackerOwner:null,loss:Math.max(0,details.attackerBefore-details.attacker)},
        defender:{player:typeof details.defenderOwner==='number'?details.defenderOwner:null,loss:Math.max(0,details.defenderBefore-details.defender)},
      };
    }
    appendActivity(s,player,event);
  }
}
