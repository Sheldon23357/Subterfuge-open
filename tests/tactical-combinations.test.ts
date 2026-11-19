import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {attackRoutes,forecastKnownPath} from '../packages/prediction/src/index.js';
import {planBot,planBotAsync,botWeightedEvaluation} from '../packages/ai/src/controller/analysis/tactical-planner.js';
import {executeBotForecast} from '../packages/ai/src/controller/analysis/tactical-forecast.js';
import {combineBotCandidates,botCombinationCandidates} from '../packages/ai/src/controller/analysis/tactical-combinations.js';
import type {BotCandidate} from '../packages/ai/src/controller/analysis/tactical-candidates.js';
import {botSearchBranch} from '../packages/ai/src/controller/analysis/tactical-progress.js';

function fixture(){
 const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 setup.size={width:80,height:80};setup.match={mode:'mining',neptuniumGoal:200};
 setup.economy.initialTick=0;
 const template=setup.economy.outposts[0]!;
 const posts=[...Array.from({length:4},(_,i)=>({id:'home'+i,owner:0,drillers:30,x:i*.01})),{id:'target',owner:1,drillers:100,x:.2}];
 setup.positions=Object.fromEntries(posts.map(p=>[p.id,{x:p.x,y:0}]));
 setup.economy.outposts=posts.map(p=>({...template,id:p.id,owner:p.owner,drillers:p.drillers,type:p.owner===1?'mine':'generator',shield:0,shieldMax:0,productionProgress:0,miningProgress:0}));
 return observation({state:createFleetScenario(setup),scheduled:[]},0,'joint-search');
}
const launch=(id:string,source:string,target:string,n:number):BotCandidate=>({id,kind:'attack',objective:'capture:'+target,targets:[target],captureTargets:[target],priority:1,reasons:[],drafts:[{id:id+':0',issueTick:0,action:{kind:'launch',source,destination:target,drillers:n}}]});

test('search telemetry includes non-launch actions and rationale, projecting only display fields',()=>{
 const candidate:BotCandidate={...launch('mine','home0','target',1),kind:'economy',reasons:['比较开矿投入'],drafts:[{id:'mine',issueTick:7,action:{kind:'toggle-mine',outpostId:'home0',privateField:'excluded'}},{id:'shield',issueTick:7,action:{kind:'set-shields',outpostId:'home1',enabled:false}},{id:'fleet',issueTick:7,action:{kind:'return-fleet',fleetId:'F1-12345678'}}]};
 const before=structuredClone(candidate),result=botSearchBranch(candidate,'evaluated',12);
 assert.deepEqual(result.actions,[{issueTick:7,action:{kind:'toggle-mine',outpostId:'home0'}},{issueTick:7,action:{kind:'set-shields',outpostId:'home1',enabled:false}},{issueTick:7,action:{kind:'return-fleet',fleetId:'F1-12345678'}}]);
 assert.deepEqual(result.reasons,candidate.reasons);assert.deepEqual(result.routes,[]);assert.deepEqual(candidate,before);
});

test('joint candidates reject duplicate edits and double-spending but allow same-target different sources',()=>{
 const o=fixture(),a=launch('a','home0','target',20),b=launch('b','home1','target',20);
 const joint=combineBotCandidates(o,[a,b])!;
 assert.deepEqual(joint.components?.map(p=>p.id),['a','b']);
 const telemetry=botSearchBranch(joint,'evaluated',123);
 assert.deepEqual(telemetry.components?.map(p=>p.id),['a','b']);
 assert.deepEqual(telemetry.components?.[0]?.routes,[{source:'home0',target:'target',drillers:20}]);
 assert.ok(telemetry.components?.every(p=>!('utility' in p)&&!('status' in p)));
 assert.equal(combineBotCandidates(o,[a,{...a,id:'alternative',drafts:a.drafts.map(d=>({...d,id:'alternative:0',action:{...d.action,drillers:10}}))}]),null);
 assert.equal(combineBotCandidates(o,[a,launch('overspend','home0','home1',20)]),null);
 const returnA:BotCandidate={...a,id:'return-a',kind:'fleet',objective:'return:fleet',drafts:[{id:'return-a:0',issueTick:0,action:{kind:'return-fleet',fleetId:'fleet'}}]};
 assert.equal(combineBotCandidates(o,[returnA,{...returnA,id:'return-b'}]),null);
 assert.ok(botCombinationCandidates(o,[a,b],[a,b]).some(c=>c.drafts.length===2));
});

test('four individually losing sources can form a freshly validated joint capture within 80 simulations',async()=>{
 const o=fixture(),routes=attackRoutes(o),before=structuredClone(o);
 const sources=Array.from({length:4},(_,i)=>launch('source'+i,'home'+i,'target',30));
 for(const c of sources){const result=forecastKnownPath(o,{targetTick:144,drafts:c.drafts});assert.equal(result.forecast.status,'conditional');if(result.forecast.status==='conditional')assert.equal(result.forecast.result.outposts.find(p=>p.id==='target')!.owner,1);}
 const full=combineBotCandidates(o,sources)!;
 const result=forecastKnownPath(o,{targetTick:144,drafts:full.drafts});
 assert.equal(result.forecast.status,'conditional');if(result.forecast.status==='conditional')assert.equal(result.forecast.result.outposts.find(p=>p.id==='target')!.owner,0);
 const limits={maxSimulations:80,maxElapsedMs:8000,internalTransfers:false};
 const d=planBot(o,routes,limits);
 assert.ok(d.assessments.some(a=>a.candidate.kind==='combined'&&a.candidate.drafts.length===4&&a.score),'joint assault must actually reach the engine, not just the generator');
 assert.equal(d.selected.kind,'combined');assert.equal(d.selected.drafts.length,4);
 assert.ok(d.coverage.stages!.combination>0&&d.coverage.simulations<=80);
 const chosen=d.assessments.find(a=>a.candidate.id===d.selected.id)!;
 assert.ok(chosen.stress&&chosen.stressCases?.every(c=>c.status==='evaluated'));
 const parallel=await planBotAsync(o,routes,{...limits,parallelism:5},async requests=>requests.map(r=>executeBotForecast(o,r)));
 assert.deepEqual(parallel,d);assert.deepEqual(o,before);
});

test('cross-objective triples are formed as one transaction and stay within the eight-command limit',()=>{
 const o=fixture(),parts=[launch('a','home0','target',5),launch('b','home1','home2',5),launch('c','home2','home3',5)];
 const result=botCombinationCandidates(o,parts,[]);
 assert.ok(result.some(c=>c.drafts.length===3&&c.targets.includes('target')&&c.targets.includes('home3')));
 assert.ok(result.every(c=>c.drafts.length<=8));
});

test('force alternatives for one objective remain available to cross-objective combinations',()=>{
 const o=fixture(),a=launch('buffered','home0','target',20),smaller=launch('smaller','home0','target',10),support=launch('support','home1','home3',5);
 const result=botCombinationCandidates(o,[a,smaller,support],[a,smaller,support]);
 assert.ok(result.some(c=>c.drafts.some(d=>d.id==='buffered:0')&&c.drafts.some(d=>d.id==='support:0')));
 assert.ok(result.some(c=>c.drafts.some(d=>d.id==='smaller:0')&&c.drafts.some(d=>d.id==='support:0')));
});

test('weighted ordinary and pressure gains outrank a marginal worst-case advantage',async()=>{
 const o=fixture(),routes=attackRoutes(o);
 const a={...launch('higher-ordinary','home0','home1',20),kind:'logistics' as const,objective:'reinforce:home1',captureTargets:[]};
 const b={...launch('better-worst','home0','home1',21),kind:'logistics' as const,objective:'reinforce:home1',captureTargets:[]};
 const d=await planBotAsync(o,routes,{preludeCandidates:[a,b],preludeOnly:true,maxSimulations:80,maxElapsedMs:8000,horizonTicks:10,
  scoreFrame:(frame,s)=>({...s,utility:frame.self.neptunium,components:{controlledScore:frame.self.neptunium}})},async requests=>requests.map(request=>{
   const result=executeBotForecast(o,request);
   if(result.kind==='result'&&result.result.forecast.status==='conditional'){
    // Controlled utilities isolate comparison policy; real engine paths and
    // resources still have to pass for both legal transport alternatives.
    const force=Number(request.drafts?.[0]?.action.drillers??0),reaction=!!request.enemyLaunches?.length||!!request.enemyWaiting?.length;
    result.result.forecast.result.self.neptunium=force===0?1000:reaction?(force===20?1100:1101):(force===20?1200:1190);
   }
   return result;
  }));
 const left=d.assessments.find(x=>x.candidate.id===a.id)!,right=d.assessments.find(x=>x.candidate.id===b.id)!;
 assert.ok(left.score&&left.stress&&right.score&&right.stress);
 assert.ok(left.score.utility>right.score.utility);
 assert.ok(right.stress.utility>left.stress.utility&&right.stress.utility-left.stress.utility<d.parameters.minActionGain);
 assert.ok(botWeightedEvaluation(left.score,left.stress).utility>botWeightedEvaluation(right.score,right.stress).utility);
 assert.equal(d.selected.id,a.id);
});
