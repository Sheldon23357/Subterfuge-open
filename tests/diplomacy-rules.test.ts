import {catchUpRealtime,startRealtime,TICK_MILLISECONDS} from '../packages/server/src/realtime.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createDiplomacyState,submitDiplomacy,advanceDiplomacy,recordDiplomacyBattle,projectDiplomacy,projectGlobalDiplomacy,diplomacyRelation,diplomacyCompetition,parseDiplomacyAction,diplomacyReceiptPage,type DiplomacyWorld,type AgreementTerms} from '../packages/engine/src/diplomacy.js';
import {createFleetScenario,submitFleetOrder,advanceFleetScenario,saveFleetSnapshot,restoreFleetSnapshot,type FleetSetup} from '../packages/engine/src/index.js';

function world():DiplomacyWorld{return {size:{width:40,height:40},ended:false,
  players:Array.from({length:4},()=>({active:true,neptunium:100,drillers:100})),
  outposts:Array.from({length:8},(_,i)=>({id:String(i),owner:i%4,destroyed:false,type:i===2?'mine':'generator',position:{x:i*4-16,y:0}}))};}
const offer=(terms:AgreementTerms,peer=1)=>({kind:'propose-agreement' as const,peer,terms,subsidy:null,counterTo:null});
const response=(agreementId:string,response:'accept'|'reject'|'withdraw'='accept')=>({kind:'respond-agreement' as const,agreementId,response});
test('unsigned proposals expire exactly 50 ticks after creation for both agreement types',()=>{
 for(const terms of [{kind:'ceasefire',outposts:['0','1']},{kind:'joint-attack',enemy:2}] as AgreementTerms[]){
  const {state:s,world:w}=submitDiplomacy(createDiplomacyState(4,0),world(),0,'unsigned',offer(terms),.25);
  assert.equal(s.agreements[0]!.deadline,50.25);
  advanceDiplomacy(s,w,50.249);
  assert.equal(s.agreements[0]!.status,'proposed');
  assert.equal(submitDiplomacy(s,w,1,'last-moment',response('unsigned'),50.249).state.agreements[0]!.status,'active');
  assert.throws(()=>submitDiplomacy(s,w,1,'too-late',response('unsigned'),50.25),/No actionable proposal/);
  advanceDiplomacy(s,w,50.25);
  assert.equal(s.agreements[0]!.status,'expired');
  assert.equal(s.agreements[0]!.endedAt,50.25);
  for(const player of [0,1]){
   const view=projectDiplomacy(s,w,player);
   assert.equal(view.agreements.filter(a=>a.status==='proposed'||a.status==='active').length,0);
   assert.ok(view.receipts.some(r=>r.kind==='agreement-ended'&&r.details.reason==='proposal-expired'));
  }
  assert.deepEqual(w.players.map(p=>p.neptunium),[100,100,100,100]);
 }
});

test('counteroffers receive their own 50 tick signing window',()=>{
 let {state:s,world:w}=submitDiplomacy(createDiplomacyState(4,0),world(),0,'original',offer({kind:'joint-attack',enemy:2}),0);
 ({state:s,world:w}=submitDiplomacy(s,w,1,'counter',{...offer({kind:'joint-attack',enemy:2},0),counterTo:'original'},40));
 assert.equal(s.agreements[0]!.status,'superseded');
 assert.equal(s.agreements[1]!.deadline,90);
 advanceDiplomacy(s,w,50);assert.equal(s.agreements[1]!.status,'proposed');
 advanceDiplomacy(s,w,90);assert.equal(s.agreements[1]!.status,'expired');
});

test('unsigned proposals expire through tick advancement and survive strict snapshot replay',()=>{
 let state=createFleetScenario(setup());
 state=submitFleetOrder(state,{id:'unsigned',player:0,action:offer({kind:'ceasefire',outposts:['a','b']})}).state;
 state=advanceFleetScenario(state,49);
 assert.equal(state.diplomacy.agreements[0]!.status,'proposed');
 state=advanceFleetScenario(state,50);
 assert.equal(state.diplomacy.agreements[0]!.status,'expired');
 assert.equal(state.diplomacy.agreements[0]!.endedAt,50);
 assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(state)),state);
});
test('active type limits check both parties atomically, preserve old contracts and release on expiry',()=>{
 let w=world(),s=createDiplomacyState(4,0),clock=0;
 const sign=(id:string,peer:number,terms:AgreementTerms)=>{({state:s,world:w}=submitDiplomacy(s,w,0,id,offer(terms,peer),clock));({state:s,world:w}=submitDiplomacy(s,w,peer,'accept-'+id,response(id),clock));};
 sign('t1',1,{kind:'ceasefire',outposts:['0','1']});sign('t2',2,{kind:'ceasefire',outposts:['0','2']});
 ({state:s,world:w}=submitDiplomacy(s,w,3,'t3',{...offer({kind:'ceasefire',outposts:['0','3']},0),subsidy:{payer:3,amount:5}},0));
 const balances=w.players.map(p=>p.neptunium);
 ({state:s,world:w}=submitDiplomacy(s,w,0,'blocked',response('t3'),0));
 assert.equal(s.agreements.find(a=>a.id==='t3')!.status,'proposed');assert.deepEqual(w.players.map(p=>p.neptunium),balances);
 assert.match(String(s.receipts.at(-1)!.details.reason),/limit/);assert.deepEqual(s.receipts.at(-1)!.players,[3,0]);
 sign('j1',1,{kind:'joint-attack',enemy:2});
 sign('j2',2,{kind:'joint-attack',enemy:1});
 sign('j3',3,{kind:'joint-attack',enemy:1});
 assert.equal(s.agreements.find(a=>a.id==='j3')!.status,'proposed');
 s.agreements.find(a=>a.id==='j1')!.fulfilled[0]=true;
 sign('j4',1,{kind:'joint-attack',enemy:3});
 assert.equal(s.agreements.find(a=>a.id==='j4')!.status,'proposed','personal completion still occupies a slot');
 advanceDiplomacy(s,w,200);
 clock=200;
 sign('t4',3,{kind:'ceasefire',outposts:['0','3']});
 assert.equal(s.agreements.find(a=>a.id==='t4')!.status,'active');
});
function signed(terms:AgreementTerms,time=0){let w=world(),s=createDiplomacyState(4,0);({state:s,world:w}=submitDiplomacy(s,w,0,'contract',offer(terms),time));({state:s,world:w}=submitDiplomacy(s,w,1,'accept',response('contract'),time));return {s,w};}

test('fixed durations start at actual acceptance; strict terms cannot override deadline',()=>{
  let w=world(),s=createDiplomacyState(4,0);
  ({state:s,world:w}=submitDiplomacy(s,w,0,'truce',offer({kind:'ceasefire',outposts:['0','1']}),.25));
  assert.equal(s.relations[0]!.value,0,'proposal alone has no effect');
  ({state:s,world:w}=submitDiplomacy(s,w,1,'accept',response('truce'),10.5));
  assert.equal(s.agreements[0]!.deadline,110.5);
  assert.equal(s.agreements[0]!.startedAt,10.5);
  assert.equal(signed({kind:'joint-attack',enemy:2},5.25).s.agreements[0]!.deadline,205.25);
  assert.throws(()=>parseDiplomacyAction({...offer({kind:'ceasefire',outposts:['0']}),duration:50}));
  assert.throws(()=>parseDiplomacyAction(offer({kind:'ceasefire',outposts:['0'],deadline:10} as AgreementTerms)));
});

test('signature and subsidy are atomic; only recipient can accept; counteroffer invalidates old version',()=>{
  const original=world(),initial=createDiplomacyState(4,0);
  const action={...offer({kind:'ceasefire',outposts:['0','1']}),subsidy:{payer:0,amount:101}};
  let {state:s,world:w}=submitDiplomacy(initial,original,0,'old',action,0);
  assert.throws(()=>submitDiplomacy(s,w,0,'self',response('old'),1));
  const failed=submitDiplomacy(s,w,1,'insufficient',response('old'),1);
  assert.equal(failed.state.agreements[0]!.status,'proposed');
  for(const player of [0,1])assert.ok(projectDiplomacy(failed.state,failed.world,player).receipts.some(r=>r.kind==='agreement-acceptance-failed'));
  assert.equal(failed.world.players[0]!.neptunium,100);
  assert.equal(w.players[0]!.neptunium,100);assert.equal(s.agreements[0]!.status,'proposed');
  ({state:s,world:w}=submitDiplomacy(s,w,1,'counter',{...offer({kind:'ceasefire',outposts:['0','1']},0),counterTo:'old',subsidy:{payer:0,amount:15}},2));
  assert.equal(s.agreements[0]!.status,'superseded');
  assert.throws(()=>submitDiplomacy(s,w,1,'stale',response('old'),3));
  ({state:s,world:w}=submitDiplomacy(s,w,0,'accept',response('counter'),3));
  assert.equal(w.players[0]!.neptunium,85);assert.equal(w.players[1]!.neptunium,115);
  assert.equal(original.players[0]!.neptunium,100);assert.equal(initial.agreements.length,0);
  assert.throws(()=>submitDiplomacy(s,w,0,'repeat',response('counter'),3));
});

test('only an actual enemy outpost capture fulfils a party; ordinary and mine goals are identical',()=>{
 const {s,w}=signed({kind:'joint-attack',enemy:2});
 const battle={id:'loss',time:1,attacker:0,defender:2,attackerLoss:1,defenderLoss:500,outpost:null,captured:false,mine:false};
 recordDiplomacyBattle(s,w,battle);
 recordDiplomacyBattle(s,w,{...battle,id:'failed-assault',time:2,outpost:'2'});
 recordDiplomacyBattle(s,w,{...battle,id:'defence',time:3,attacker:2,defender:0});
 recordDiplomacyBattle(s,w,{...battle,id:'other-enemy',time:4,defender:3,outpost:'3',captured:true});
 assert.deepEqual(s.agreements[0]!.progress,[0,0]);
 const capture={...battle,id:'capture',time:5,defenderLoss:0,outpost:'2',captured:true,mine:true};
 recordDiplomacyBattle(s,w,capture);recordDiplomacyBattle(s,w,capture);
 recordDiplomacyBattle(s,w,{...capture,id:'extra',time:6,outpost:'6',mine:false});
 assert.deepEqual(s.agreements[0]!.progress,[1,0]);assert.deepEqual(s.agreements[0]!.fulfilled,[true,false]);
 assert.equal(s.relations.find(r=>r.from===1&&r.to===0)!.value,12);
 assert.equal(s.agreements[0]!.status,'active');
 recordDiplomacyBattle(s,w,{...capture,id:'partner',time:7,attacker:1,mine:false});
 assert.equal(s.agreements[0]!.status,'completed');assert.deepEqual(s.agreements[0]!.progress,[1,1]);
 assert.equal(s.relations.find(r=>r.from===0&&r.to===1)!.value,12);
 assert.equal(s.receipts.filter(r=>r.kind==='agreement-personal-fulfilled').length,2);
 assert.deepEqual(s.receipts.filter(r=>r.kind==='agreement-progress').map(r=>r.details),[{capturedOutposts:1,total:1},{capturedOutposts:1,total:1}]);
});

test('fixed unfulfilled penalty applies only to the party without a capture; exact deadline is excluded',()=>{
 const {s,w}=signed({kind:'joint-attack',enemy:2});
 const b={id:'capture',time:1,attacker:0,defender:2,attackerLoss:0,defenderLoss:0,outpost:'2',captured:true,mine:false};
 recordDiplomacyBattle(s,w,b);
 recordDiplomacyBattle(s,w,{...b,id:'late',time:200,attacker:1,outpost:'6'});
 assert.equal(s.agreements[0]!.status,'unfulfilled');assert.deepEqual(s.agreements[0]!.progress,[1,0]);
 assert.equal(s.relations.find(r=>r.from===0&&r.to===1)!.value,-8);
 assert.equal(s.relations.find(r=>r.from===1&&r.to===0)!.value,12);
 advanceDiplomacy(s,w,200);
 assert.equal(s.receipts.filter(r=>r.details.reason==='joint-attack-shortfall').length,1);
});

test('both unfulfilled parties have a fixed penalty even after very high damage',()=>{
 const {s,w}=signed({kind:'joint-attack',enemy:2});
 for(const attacker of [0,1])recordDiplomacyBattle(s,w,{id:'damage-'+attacker,time:1,attacker,defender:2,attackerLoss:0,defenderLoss:1000,outpost:null,captured:false,mine:false});
 advanceDiplomacy(s,w,199);assert.equal(s.agreements[0]!.status,'active');
 advanceDiplomacy(s,w,200);advanceDiplomacy(s,w,200);
 assert.deepEqual(s.receipts.filter(r=>r.details.reason==='joint-attack-shortfall').map(r=>[r.details.from,r.details.to,r.details.requested]),[[1,0,-10],[0,1,-10]]);
});

test('joint terms reject obsolete damage quotas and pre-signature captures never count',()=>{
 assert.throws(()=>parseDiplomacyAction(offer({kind:'joint-attack',enemy:2,commitments:[1,1]} as unknown as AgreementTerms)),/fields/);
 const w=world();let s=createDiplomacyState(4,0);
 recordDiplomacyBattle(s,w,{id:'old',time:1,attacker:0,defender:2,attackerLoss:0,defenderLoss:0,outpost:'2',captured:true,mine:false});
 ({state:s}=submitDiplomacy(s,w,0,'joint',offer({kind:'joint-attack',enemy:2}),2));
 ({state:s}=submitDiplomacy(s,w,1,'accept',response('joint'),2));
 assert.deepEqual(s.agreements[0]!.progress,[0,0]);
});

test('truce is violated by actual battle, not proposal; overlapping truces apply one betrayal penalty',()=>{
  let {s,w}=signed({kind:'ceasefire',outposts:['0','1']});
  ({state:s,world:w}=submitDiplomacy(s,w,0,'second',offer({kind:'ceasefire',outposts:['0','1']}),1));
  ({state:s,world:w}=submitDiplomacy(s,w,1,'answer',response('second'),1));
  const before=diplomacyRelation(s,w,1,0).trust;
  recordDiplomacyBattle(s,w,{id:'betrayal',time:2,attacker:0,defender:1,attackerLoss:0,defenderLoss:20,outpost:'1',captured:true,mine:false});
  assert.equal(s.agreements.filter(a=>a.status==='violated').length,2);
  assert.equal(s.relations.find(r=>r.from===1&&r.to===0)!.value,2-6-4-Math.round((30+Math.max(0,before)/2)*4)/4);
  assert.equal(s.relations.find(r=>r.from===0&&r.to===1)!.value,2);
});

test('expiry releases protection, has no automatic refunds, and external elimination is not shortfall',()=>{
  const {s,w}=signed({kind:'ceasefire',outposts:['0','1']});
  advanceDiplomacy(s,w,100);assert.equal(s.agreements[0]!.status,'completed');
  assert.equal(s.relations.find(r=>r.from===0&&r.to===1)!.value,8);
  const joint=signed({kind:'joint-attack',enemy:2});joint.w.players[2]!.active=false;
  advanceDiplomacy(joint.s,joint.w,10);assert.equal(joint.s.agreements[0]!.status,'terminated');
  assert.equal(joint.s.relations.find(r=>r.from===0&&r.to===1)!.value,2);
});

test('economic ties, directionality and private projection use only authorized relationships',()=>{
  const w=world(),s=createDiplomacyState(4,0);
  assert.ok(diplomacyCompetition(w).every(p=>p.score===.5&&p.rank===2.5));
  assert.equal(diplomacyRelation(s,w,0,1).competitionPressure,0);
  w.players[0]!.neptunium=200;w.players[0]!.drillers=200;
  assert.ok(diplomacyRelation(s,w,1,0).competitionPressure>diplomacyRelation(s,w,0,1).competitionPressure);
  const {state,world:next}=submitDiplomacy(s,w,0,'secret',offer({kind:'ceasefire',outposts:['0','1']}),0);
  const view=projectDiplomacy(state,next,2);
  assert.equal(view.agreements.length,0);assert.equal(view.receipts.length,0);
  assert.ok(view.relations.every(r=>r.from===2||r.to===2));
  view.relations[0]!.history=100;assert.equal(state.relations.find(r=>r.from===2)!.value,0);
});

test('peace recovery starts at 96 ticks, excludes rank and border, and is resumable',()=>{
  const {s,w}=signed({kind:'ceasefire',outposts:['0','1']});
  recordDiplomacyBattle(s,w,{id:'attack',time:1,attacker:0,defender:1,attackerLoss:0,defenderLoss:1,outpost:'1',captured:false,mine:false});
  const r=s.relations.find(r=>r.from===1&&r.to===0)!,before=r.value;
  advanceDiplomacy(s,w,96);assert.equal(r.value,before);
  const restored=JSON.parse(JSON.stringify(s)) as typeof s;
  advanceDiplomacy(s,w,97);advanceDiplomacy(restored,w,97);
  assert.equal(r.value,before+1);assert.deepEqual(restored,s);
});

function setup():FleetSetup{return {size:{width:80,height:80},positions:{a:{x:0,y:0},b:{x:2,y:0},c:{x:4,y:0}},
  economy:{initialTick:0,teamSize:0,players:Array.from({length:3},()=>({active:true,neptunium:100,minesCreated:0})),
    outposts:['a','b','c'].map((id,owner)=>({id,owner,type:'generator',drillers:100,shield:0,shieldMax:0,shieldsEnabled:true,productionProgress:0,miningProgress:0,shieldProgress:0,minePending:false,shieldDisablePending:false}))}};}

test('two real enemy captures complete the joint agreement and survive strict snapshot replay',()=>{
 const cfg=setup();cfg.positions.d={x:6,y:0};
 cfg.economy.outposts[2]!.drillers=1;
 cfg.economy.outposts.push({...cfg.economy.outposts[2]!,id:'d',type:'mine'});
 let s=createFleetScenario(cfg);
 s=submitFleetOrder(s,{id:'joint',player:0,action:offer({kind:'joint-attack',enemy:2})}).state;
 s=submitFleetOrder(s,{id:'accept',player:1,action:response('joint')}).state;
 for(const [player,source,destination] of [[0,'a','c'],[1,'b','d']] as const)s=submitFleetOrder(s,{id:'capture-'+player,player,action:{kind:'launch',source,destination,drillers:40}}).state;
 s=advanceFleetScenario(s,70);
 assert.deepEqual(s.diplomacy.agreements[0]!.progress,[1,1]);
 assert.equal(s.diplomacy.agreements[0]!.status,'completed');
 assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(s)),s);
});

test('authority commands persist signature, atomic subsidy and actual betrayal through strict replay',()=>{
  let s=createFleetScenario(setup());
  const propose={id:'truce',player:0,action:{...offer({kind:'ceasefire',outposts:['a','b']}),subsidy:{payer:0,amount:15}}};
  s=submitFleetOrder(s,propose,.25*600).state;
  s=submitFleetOrder(s,{id:'accept',player:1,action:response('truce')},.5*600).state;
  assert.equal(s.diplomacy.agreements[0]!.deadline,100.5);
  assert.equal(s.economy.players[1]!.neptunium,115);
  const repeat=submitFleetOrder(s,{id:'accept',player:1,action:response('truce')},.5*600);
  assert.equal(repeat.duplicate,true);assert.equal(repeat.state.economy.players[1]!.neptunium,115);
  s=submitFleetOrder(s,{id:'attack',player:0,action:{kind:'launch',source:'a',destination:'b',drillers:20}},.5*600).state;
  s=advanceFleetScenario(s,40);
  assert.equal(s.diplomacy.agreements[0]!.status,'violated');
  assert.ok(s.events.some(e=>e.kind==='battle'),'contract does not block actual attack');
  assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(s)),s);
  const corrupt=JSON.parse(saveFleetSnapshot(s));corrupt.expected.diplomacy.relations[0].value=99;
  assert.throws(()=>restoreFleetSnapshot(JSON.stringify(corrupt)),/disagree/);
  const old=JSON.parse(saveFleetSnapshot(s));old.format='fleet-snapshot/4';
  assert.throws(()=>restoreFleetSnapshot(JSON.stringify(old)),/Unsupported snapshot/);
});

test('failed real assault does not fulfil capture goal and remains exact through replay',()=>{
  let s=createFleetScenario(setup());
  s=submitFleetOrder(s,{id:'joint',player:0,action:offer({kind:'joint-attack',enemy:2})}).state;
  s=submitFleetOrder(s,{id:'accept',player:1,action:response('joint')}).state;
  s=submitFleetOrder(s,{id:'attack',player:0,action:{kind:'launch',source:'a',destination:'c',drillers:40}}).state;
  s=advanceFleetScenario(s,70);
  assert.equal(s.diplomacy.agreements[0]!.progress[0],0);
  assert.equal(s.diplomacy.agreements[0]!.fulfilled[0],false);
  assert.equal(s.diplomacy.relations.find(r=>r.from===1&&r.to===0)!.value,2);
  const restored=restoreFleetSnapshot(saveFleetSnapshot(s));
  assert.deepEqual(restored.diplomacy,s.diplomacy);
  assert.equal(restored.diplomacy.agreements[0]!.status,'active','partner still owes own quota');
});


test('day-internal signatures settle prior battles first and never retroactively punish pre-signature attacks',()=>{
  const cfg=setup();cfg.positions.b={x:.02,y:0};
  let state=createFleetScenario(cfg);
  state=submitFleetOrder(state,{id:'offer',player:0,action:offer({kind:'ceasefire',outposts:['a','b']})}).state;
  state=submitFleetOrder(state,{id:'attack',player:0,action:{kind:'launch',source:'a',destination:'b',drillers:10}}).state;
  const ordinary=advanceFleetScenario(state,1),battle=ordinary.events.find(e=>e.kind==='battle')!;
  assert.ok(battle.fraction>0&&battle.fraction<.75);
  state=submitFleetOrder(state,{id:'accept',player:1,action:response('offer')},450).state;
  assert.equal(state.events.filter(e=>e.kind==='battle').length,1,'past battle already authoritative at acceptance');
  assert.equal(state.diplomacy.agreements[0]!.status,'active');
  assert.ok(state.diplomacy.receipts.find(r=>r.kind==='trust-changed'&&r.details.reason==='hostile-battle')!.time<.75);
  assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(state)),state,'partial settlement survives strict replay');
  state=advanceFleetScenario(state,1);
  assert.equal(state.events.filter(e=>e.kind==='battle').length,1,'tick does not duplicate prior combat');
  assert.equal(state.diplomacy.agreements[0]!.status,'active');
  assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(state)),state);
});

test('day-internal launch arrival uses absolute time after departure; post-signature attack still violates',()=>{
  const cfg=setup();cfg.positions.b={x:.02,y:0};
  let state=createFleetScenario(cfg);
  state=submitFleetOrder(state,{id:'offer',player:0,action:offer({kind:'ceasefire',outposts:['a','b']})}).state;
  state=submitFleetOrder(state,{id:'accept',player:1,action:response('offer')},150).state;
  state=submitFleetOrder(state,{id:'attack',player:0,action:{kind:'launch',source:'a',destination:'b',drillers:10}},300).state;
  state=submitFleetOrder(state,{id:'later',player:0,action:{kind:'set-shields',outpostId:'a',enabled:false}},570).state;
  const b=state.events.find(e=>e.kind==='battle')!;
  assert.ok(b.fraction>=.5&&b.fraction<.95);
  assert.equal(state.diplomacy.agreements[0]!.status,'violated');
  state=advanceFleetScenario(state,1);
  assert.equal(state.events.filter(e=>e.kind==='battle').length,1);
  assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(state)),state);
});


test('observation keeps current contracts and bounded history while paged receipts recover complete authorized results',()=>{
  let s=createDiplomacyState(4,0),w=world();
  for(let i=0;i<40;i++){
    ({state:s,world:w}=submitDiplomacy(s,w,0,'offer-'+i,offer({kind:'ceasefire',outposts:['0','1']}),i));
    ({state:s,world:w}=submitDiplomacy(s,w,1,'reject-'+i,response('offer-'+i,'reject'),i));
  }
  const o=projectDiplomacy(s,w,0);assert.equal(o.agreements.length,8);assert.equal(o.agreementCount,40);assert.equal(o.receipts.length,64);assert.equal(o.receiptCount,80);
  let cursor=0;const got:number[]=[];
  while(cursor<80){const page=diplomacyReceiptPage(s,0,cursor,80,7);got.push(...page.receipts.map(r=>r.id));assert.ok(page.agreements.every(a=>a.players.includes(0)));cursor=Number(page.nextCursor);}
  assert.equal(new Set(got).size,80);assert.deepEqual(diplomacyReceiptPage(s,2,0,undefined).receipts,[]);
  assert.throws(()=>diplomacyReceiptPage(s,2,1,undefined));
});

test('lost protected borders stop continuous truce credit without retroactive history pressure',()=>{
  const {s,w}=signed({kind:'ceasefire',outposts:['0','1']});
  advanceDiplomacy(s,w,75);w.outposts[1]!.owner=2;advanceDiplomacy(s,w,76);
  advanceDiplomacy(s,w,100);
  assert.equal(s.agreements[0]!.status,'completed');assert.equal(s.relations.find(r=>r.from===0&&r.to===1)!.value,2);
});


test('realtime expiry settles fractional deadline without requiring a command or rounding to the next day',async()=>{
 let state=createFleetScenario(setup());
 state=submitFleetOrder(state,{id:'offer',player:0,action:offer({kind:'ceasefire',outposts:['a','b']})},150).state;
 state=submitFleetOrder(state,{id:'accept',player:1,action:response('offer')},150).state;
 let room=startRealtime({state,scheduled:[]},10000);
 room=await catchUpRealtime(room,10000+100*TICK_MILLISECONDS+5000);
 assert.equal(room.state.economy.tick,100);assert.equal(room.state.diplomacy.agreements[0]!.status,'completed');
 assert.equal(room.state.diplomacy.agreements[0]!.endedAt,100.25);
 assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(room.state)),room.state);
});

test('pre-signature mine loss changes the actual subsidy balance before atomic acceptance',()=>{
 const cfg=setup();cfg.positions.b={x:.02,y:0};cfg.economy.outposts[0]!.drillers=200;cfg.economy.outposts[1]!.type='mine';cfg.economy.outposts[1]!.drillers=1;
 let state=createFleetScenario(cfg);
 state=submitFleetOrder(state,{id:'offer',player:0,action:{...offer({kind:'ceasefire',outposts:['a','b']}),subsidy:{payer:1,amount:90}}}).state;
 state=submitFleetOrder(state,{id:'attack',player:0,action:{kind:'launch',source:'a',destination:'b',drillers:150}}).state;
 state=submitFleetOrder(state,{id:'accept',player:1,action:response('offer')},450).state;
 assert.equal(state.economy.players[1]!.neptunium,80);assert.equal(state.economy.players[0]!.neptunium,100);
 assert.equal(state.diplomacy.agreements[0]!.status,'proposed');assert.ok(state.diplomacy.receipts.some(r=>r.kind==='agreement-acceptance-failed'));
 assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(state)),state);
});

test('global lab projection exposes all directions while player projections remain scoped',()=>{
 const w=world(),s=createDiplomacyState(4,0),before=structuredClone(s);
 const global=projectGlobalDiplomacy(s,w),own=projectDiplomacy(s,w,0);
 assert.equal(global.relations.length,12);assert.equal(own.relations.length,6);
 assert.ok(global.relations.some(r=>r.from===1&&r.to===2));assert.ok(own.relations.every(r=>r.from===0||r.to===0));
 assert.deepEqual(s,before);assert.throws(()=>projectDiplomacy(s,w,-1));
});
