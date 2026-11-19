import fs from 'node:fs';
import ts from 'typescript';
import {readReference} from './reference-functions.mjs';
const ref=readReference();
const node=name=>ref.tree.statements.find(n=>n.name?.text===name);
const method=name=>node('Pc').members.find(n=>n.name?.getText(ref.tree)===name);
let scan;
function visit(n){if(ts.isForStatement(n)&&n.getText(ref.tree).startsWith('for (let i = 0; i < Ml.info.maxPlayerCount;'))scan=n.statement;ts.forEachChild(n,visit);}
visit(method('generatePushNotifications'));
if(!scan)throw Error('Original sonar transition loop missing');
const code=`// @ts-nocheck
// Exact APK12075 Pc.handleEvent, sonar per-player block and FOe. SHA256 ${ref.sha}
// Regenerate with node scripts/extract-forecast-notifications.mjs.
import {SPECIALISTS} from '../../rules/src/reference.js';
const B={Nothing:0,Sub:2},rt={Visible:2},He={WaitingForLaunch:'waiting',Moving:'moving'},ke={Ended:'ended'},yn={Normal:'normal'},K={SecondsPerTick:600};
class G{constructor(x,y){this.x=x;this.y=y;}}
class we{constructor(type,index){this.type=type;this.index=index;}}
const Z=c=>{if(!c)throw Error('Original forecast notification assertion');};
const ct={add:(a,v)=>a.push(v)};
class BoundedEvents{${node('ct').members.find(n=>n.name?.getText(ref.tree)==='add').getText(ref.tree)}}
export function originalAppendForecastEvent(queue,event){BoundedEvents.add(queue,event);}
const V={getItemPosition:(w,l)=>({...w.subs.get(l.index).pos})};
const te={getScreenName:(info,i)=>info.names[i]};
const kt=Object.fromEntries(SPECIALISTS.map(s=>[s.client_type_id,{name:s.name_en}]));
const list=values=>({count:values.length,get:i=>values[i],clone:()=>list([...values])});
const wn={compute:(a,w)=>{a.subs=list(w.nextVisibility);}};
${node('qD').getText(ref.tree)}
${node('FOe').getText(ref.tree)}
class Notifications{
 ${method('handleEvent').getText(ref.tree)}
 scan(Ml,i){this.world=Ml.world;${scan.getText(ref.tree).slice(1,-1)}}
}
/** Data adapter; callers must provide only their permitted forecast entities. */
export function originalForecastSonarNotifications(input){
 const n=new Notifications();n.gameEvents=[];n.startingTickCount=input.startTick;n.secondsSinceLastTick=input.observedSeconds;n.immediateSendingMode=false;
 n.visibility=[];n.visibility[input.player]={subs:list(input.previousVisibility)};
 const state={tickCount:input.tick,timeFactor:input.timeFactor??1,status:input.ended?'ended':'in-progress',
  info:{names:input.names},playerStates:{get:()=>({timeOfDeathInSecs:input.deathSeconds??-1})},
  world:{subs:list(input.fleets.map(f=>({...f,specialistCache:list(f.specialists)}))),specialists:list(input.specialists),nextVisibility:input.visibility}};
 n.scan(state,input.player);return n.gameEvents;
}
export function originalForecastEventMinutes(startTick,observedSeconds,tick){
 const n=new Notifications();n.gameEvents=[];n.startingTickCount=startTick;n.secondsSinceLastTick=observedSeconds;n.immediateSendingMode=false;
 n.handleEvent({tickCount:tick,timeFactor:1,status:'in-progress',playerStates:{get:()=>({timeOfDeathInSecs:-1})}},0,B.Nothing,-1,'',null,true,yn.Normal);
 return n.gameEvents[0]?.minutesBeforeSending??null;
}
`;
const path='packages/engine/src/original-forecast-notifications.generated.ts';
if(process.argv.includes('--check')){if(fs.readFileSync(path,'utf8').replace(/\r\n/g,'\n')!==code.replace(/\r\n/g,'\n'))throw Error('Forecast notification extraction differs');}
else fs.writeFileSync(path,code);
