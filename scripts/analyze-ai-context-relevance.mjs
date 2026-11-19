import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {readPromptMaterial} from '../dist/packages/contracts/src/index.js';
const out=resolve(process.argv[2]??'outputs/ai-context-audit-20261030');
const capture=JSON.parse(await readFile(join(out,'capture.json'),'utf8'));
const sum=xs=>xs.reduce((n,x)=>n+x,0),size=v=>JSON.stringify(v).length;
const bodySize=m=>sum(['global','guidance','facts'].map(k=>size({[k]:m[k]})));
const rows=t=>Array.isArray(t)?t:t?.columns&&t.rows?t.rows.map(row=>Object.fromEntries(t.columns.map((k,i)=>[k,row[i]]))):[];
const table=(columns,values)=>({columns,rows:values.map(row=>columns.map(k=>row[k]??null))});
const terminal=a=>!['active','proposed'].includes(a.status);
const destinationOf=f=>typeof f.destination==='string'?f.destination:f.destination?.name??f.destination?.id??f.destinationId;
const totals={},details=[],ledger=[];let verifiedScenarioCases=0;
const add=(o,k,n=1)=>o[k]=(o[k]??0)+n;
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const word=(text,name)=>new RegExp('(?<![A-Za-z0-9_])'+name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?![A-Za-z0-9_])').test(text);
const idRE=/\b(?:p\d+-)?[a-f0-9]{64}\b|\b(?:[A-Za-z][A-Za-z0-9._-]{0,35}-)?[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/gi;
function abbreviator(m){const map=new Map();JSON.stringify(m).replace(idRE,id=>{if(!map.has(id))map.set(id,'@I'+(map.size+1));return id;});return value=>JSON.stringify(value).replace(idRE,id=>map.get(id)??id);}
function anchors(m){
 const g=m.global,h=m.guidance,peers=new Set((h.fixedConversation?.identities??[]).map(p=>p.gamePlayer)),names=g.identities.map(row=>row[0]);
 const contracts=rows(h.serverAgreements).filter(a=>!terminal(a)&&(m.kind!=='diplomacy'||peers.has(a.peer)));
 const text=JSON.stringify([m.evidence?.messages,h.diplomacyPurpose,h.commander,h.strategic,h.executionRules,rows(h.intentTasks),rows(h.readOnlyIntentTasks),contracts,g.criticalAssets]);
 const named=new Set(names.filter(name=>word(text,name)));
 const players=new Set([...peers,...(h.diplomacyPurpose?.needs??[]).flatMap(n=>n.opponents??[]),...contracts.flatMap(c=>[c.peer,c.enemy]).filter(x=>x!==null&&x!==undefined)]);
 for(const p of rows(g.roster))if(word(text,p.name))players.add(p.gamePlayer);
 return {names:named,players,peers};
}
// Stage-only history: preserve the terminal outcome and terms of offers which
// can explain past negotiation. Remove expired-action calculations, not audit.
function historyView(m){
 const h=m.guidance,active=rows(h.serverAgreements).filter(a=>!terminal(a)),closed=rows(h.serverAgreements).filter(terminal);
 if(!closed.length)return;
 h.serverAgreements=table(h.serverAgreements.columns,active);
 h.closedAgreementHistory=table(['id','peer','kind','status','deadline','enemy','outposts','ownQuota','peerQuota','ownProgress','peerProgress','reason'],closed);
}
// Fuse exact copies by contract identity; preserve every non-identical value.
// The output is a hypothetical canonical input, not an executable wire shape.
function canonicalContracts(m){
 const h=m.guidance,contracts=new Map(rows(h.serverAgreements).map(c=>[c.id,c]));
 if(h.closedAgreementHistory)for(const c of rows(h.closedAgreementHistory))contracts.set(c.id,c);
 if(h.communicationFacts?.scopeContracts){
  const extras=[];
  for(const v of h.communicationFacts.scopeContracts){const c=contracts.get(v.id);if(!c){extras.push(v);continue;}
   const extra=Object.fromEntries(Object.entries(v).filter(([k,x])=>k!=='id'&&!(terminal(c)&&['ownRemaining','peerRemaining','allowedActions'].includes(k))&&(!Object.hasOwn(c,k)||JSON.stringify(c[k])!==JSON.stringify(x))));
   if(Object.keys(extra).length)extras.push({id:v.id,...extra});
  }
  h.currentConversationAgreementIds=h.communicationFacts.scopeContracts.map(c=>c.id);
  if(extras.length)h.communicationFacts.scopeContracts=extras;else delete h.communicationFacts.scopeContracts;
 }
 for(const [list,idKey] of [[h.relationAdvice?.obligations,'agreementId'],[h.editPolicy?.contracts,'agreementId'],[h.contractFeasibility,'agreementId']])for(const v of list??[]){
  const c=contracts.get(v[idKey]);if(!c)continue;
  for(const k of Object.keys(v)){const target=k==='remaining'?'ownRemaining':k;if(k!==idKey&&Object.hasOwn(c,target)&&JSON.stringify(v[k])===JSON.stringify(c[target]))delete v[k];}
 }
}
function groupedKnowledge(m){
 const h=m.guidance,capacity=h.relationAdvice?.agreementCapacity;
 if(Array.isArray(capacity)){
  const own=capacity.filter(p=>p.complete),unknown=capacity.filter(p=>!p.complete);
  h.relationAdvice.agreementCapacity={complete:own,unknownPeers:table(['player','visibleCeasefiresLowerBound','visibleJointAttacksLowerBound'],unknown.map(p=>({player:p.player,visibleCeasefiresLowerBound:p.visibleCeasefiresLowerBound??p.ceasefires,visibleJointAttacksLowerBound:p.visibleJointAttacksLowerBound??p.jointAttacks}))),unknownFields:['actualCeasefires','actualJointAttacks','remainingCeasefires','remainingJointAttacks'],meaning:'对方完整合同与实际剩余名额未知；表中仅列可见下界，零不代表零占用，签署由服务器复核'};
 }
 const c=h.communicationFacts;
 if(c?.ownOutposts&&c?.peerOutposts&&c?.eligibleCeasefireOutposts){
  const groups=[{player:c.self,outposts:c.ownOutposts},...c.peerOutposts];
  const expected=new Set(groups.flatMap(g=>g.outposts));assert.deepEqual([...expected].sort(),[...new Set(c.eligibleCeasefireOutposts)].sort());
  c.ceasefireOutpostsByOwner=groups;delete c.ownOutposts;delete c.peerOutposts;delete c.eligibleCeasefireOutposts;
 }
}
function stageHistory(m){
 historyView(m);
 // Proposed/rejected terms remain available; terminal contribution is historical.
 if(m.guidance.closedAgreementHistory)m.guidance.closedAgreementHistory.meaning='历史条款与实际进度，不是当前义务或可执行提案；失效条款不得复活';
}
function candidateRules(m){
 const t=m.global.planning?.candidates;if(!t?.columns)return;
 const col=t.columns.indexOf('reasons');if(col<0)return;
 const counts=new Map();for(const row of t.rows)for(const s of row[col]??[])counts.set(s,(counts.get(s)??0)+1);
 const common=[...counts].filter(([s,n])=>n===t.rows.length&&n>1&&s.length>12).map(([s])=>s);
 if(!common.length)return;
 m.global.planning.sharedCandidateConditions=common;for(const row of t.rows)row[col]=row[col].filter(s=>!common.includes(s));
}
function irrelevantSelectors(m){const p=m.guidance.editPolicy;if(p?.militaryEditsAllowed===false){delete p.friendlyTargets;delete p.returnFleetIds;}}
function scopedReceipts(m){
 const h=m.guidance,all=rows(h.contractResults),contracts=new Map(rows(h.serverAgreements).map(a=>[a.id,a]));
 const peers=new Set((h.fixedConversation?.identities??[]).map(p=>p.gamePlayer));
 const current=new Set([...contracts.values()].filter(a=>!terminal(a)).map(a=>a.id));
 const keep=r=>current.has(r.agreementId)||m.kind==='diplomacy'&&(peers.has(r.actor)||peers.has(r.result?.from)||peers.has(r.result?.to)||peers.has(contracts.get(r.agreementId)?.peer));
 const preserved=all.filter(keep),other=all.filter(r=>!keep(r));if(!other.length)return;
 const groups=new Map();
 for(const r of other){
  const context=contracts.get(r.agreementId),peer=context?.peer??(r.result?.from===m.basis.player?r.result?.to:r.result?.to===m.basis.player?r.result?.from:null);
  const key=JSON.stringify([peer,r.kind,r.result?.reason??null,r.result?.status??null,r.result?.from??null,r.result?.to??null,r.actor]);
  const row=groups.get(key)??{peer,kind:r.kind,reason:r.result?.reason??null,status:r.result?.status??null,from:r.result?.from??null,to:r.result?.to??null,actor:r.actor,count:0,firstListedTime:r.time,lastListedTime:r.time,listedTrustDelta:0,listedContribution:0};
  row.count++;row.firstListedTime=Math.min(row.firstListedTime,r.time);row.lastListedTime=Math.max(row.lastListedTime,r.time);
  if(r.kind==='trust-changed'&&typeof r.result?.before==='number'&&typeof r.result?.after==='number')row.listedTrustDelta+=r.result.after-r.result.before;
  if(r.kind==='agreement-progress'&&typeof r.result?.total==='number')row.listedContribution+=r.result.total;
  groups.set(key,row);
 }
 h.contractResults=table(h.contractResults.columns,preserved);
 h.otherListedReceiptSummary={columns:['peer','kind','reason','status','from','to','actor','count','firstListedTime','lastListedTime','listedTrustDelta','listedContribution'],rows:[...groups.values()].map(r=>[r.peer??null,r.kind,r.reason,r.status,r.from,r.to,r.actor??null,r.count,r.firstListedTime,r.lastListedTime,r.listedTrustDelta,r.listedContribution]),meaning:'仅汇总本次已列回执，非完整历史或当前义务；当前信任/进度以当前状态为准，合计不能重复加到账上。缺少单事件前后值及审计身份，原始回执留程序'};
}
function scopedHistory(m){
 const h=m.guidance,all=rows(h.serverAgreements),peers=new Set((h.fixedConversation?.identities??[]).map(p=>p.gamePlayer));
 const kept=all.filter(a=>!terminal(a)||m.kind==='diplomacy'&&peers.has(a.peer));
 const older=all.filter(a=>!kept.includes(a));if(!older.length)return;
 const groups=new Map();
 for(const a of older){
  const key=JSON.stringify([a.peer,a.kind,a.status,a.reason,a.ownFulfilled,a.peerFulfilled]);
  const row=groups.get(key)??{peer:a.peer,kind:a.kind,status:a.status,reason:a.reason,ownFulfilled:a.ownFulfilled,peerFulfilled:a.peerFulfilled,count:0,listedOwnProgress:0,listedPeerProgress:0};
  row.count++;row.listedOwnProgress+=a.ownProgress??0;row.listedPeerProgress+=a.peerProgress??0;groups.set(key,row);
 }
 h.serverAgreements=table(h.serverAgreements.columns,kept);
 h.closedOtherAgreementSummary={columns:['peer','kind','status','reason','ownFulfilled','peerFulfilled','count','listedOwnProgress','listedPeerProgress'],rows:[...groups.values()].map(r=>[r.peer,r.kind,r.status,r.reason,r.ownFulfilled??null,r.peerFulfilled??null,r.count,r.listedOwnProgress,r.listedPeerProgress]),meaning:'已终止合同的历史结果汇总，不是当前义务；同一实际贡献可计入多合同，历史合计不可当独立战损。当前会话旧条款仍保留；其他原条款与身份在程序审计中'};
 // If an unchanged raw receipt needs a closed contract's identity, retain a
 // minimal context map. The combined experiment summarizes those receipts first.
 const referenced=new Set(rows(h.contractResults).map(r=>r.agreementId).filter(Boolean));
 const needed=older.filter(a=>referenced.has(a.id));
 if(needed.length)h.receiptContractContexts=table(['id','peer','kind','status','reason'],needed);
}
function militaryDigest(m){
 if(m.kind!=='diplomacy')return;
 const {global:g,guidance:h,facts:f}=m,root=anchors(m),candidates=rows(g.planning.candidates),core=candidates.filter(c=>root.names.has(c.target));
 const urgentFleetIds=new Set((g.criticalAssets?.hostileApproaches??[]).map(v=>v.id));
 const explicitFleetIds=new Set([...rows(h.intentTasks),...rows(h.readOnlyIntentTasks)].map(t=>t.fleetId).filter(Boolean));
 if(h.editPolicy?.militaryEditsAllowed)for(const id of h.editPolicy.returnFleetIds??[])explicitFleetIds.add(id);
 const relatedFleet=f=>explicitFleetIds.has(f.id)||urgentFleetIds.has(f.id)||root.names.has(f.source)||root.names.has(destinationOf(f));
 function fleetView(t,own){
  const all=rows(t),detail=all.filter(relatedFleet),other=all.filter(f=>!relatedFleet(f));
  if(!other.length)return t;
  const groups=new Map();for(const f of other){const key=JSON.stringify([own?m.basis.player:f.owner,f.state]);const x=groups.get(key)??{owner:own?m.basis.player:f.owner,state:f.state,fleets:0,drillers:0,canReturn:0};x.fleets++;x.drillers+=f.drillers??0;x.canReturn+=f.canReturn===true?1:0;groups.set(key,x);}
  return {related:table(t.columns,detail),otherAuthorizedFleets:[...groups.values()],coverage:{total:all.length,detailed:detail.length},meaning:'其他授权舰队仅列数量与兵力汇总，未断言它们空闲、可调遣或可以重复承诺；全量事实保留在程序'};
 }
 g.ownFleets=fleetView(g.ownFleets,true);f.fleets=fleetView(f.fleets,false);
 // Preserve the entire common shortlist, costs, timing, source overlap and warnings.
 // Unanchored choices become negotiation options, not invisible/discarded choices.
 if(core.length<candidates.length){
  const others=candidates.filter(c=>!root.names.has(c.target));
  const compact=others.map(c=>({target:c.target,owner:c.owner,classification:c.classification,score:c.score,attackWorldDays:c.attackWorldDays,suggestedUntil:c.suggestedUntil,additionalForceEstimate:c.additionalForceEstimate,newForceForScreenedAttackEstimate:c.newForceForScreenedAttackEstimate,launchSources:c.launchSources,reasons:c.reasons.filter(s=>/第三方|其他阵营|在途|重复|未知|协防|复核|不能|未/.test(s)&&!/多路直攻按最晚抵达同步/.test(s))}));
  g.planning.candidates=table(g.planning.candidates.columns,core);
  g.planning.otherNegotiationAttackOptions=table(['target','owner','classification','score','attackWorldDays','suggestedUntil','additionalForceEstimate','newForceForScreenedAttackEstimate','launchSources','reasons'],compact);
  g.planning.detailScope='当前直接提及的候选保留细节；其他候选保留成本、航程、来源和风险，用于比较谈判方向，完整攻防分解留程序';
 }
 // Each source's reserves and available-force estimates remain untouched.
 // Suppress non-focus economic construction detail only for no-edit calls.
 if(h.editPolicy?.militaryEditsAllowed===false){
  const posts=g.economy.ownPosts,cols=g.economy.columns,ii=cols.includes('name')?cols.indexOf('name'):cols.indexOf('id'),ti=cols.indexOf('type');assert.ok(ii>=0);
  const kept=posts.filter(p=>root.names.has(p[ii])||p[ti]==='mine');
  if(kept.length<posts.length){g.economy.ownPosts=kept;g.economy.coverage={...g.economy.coverage,listed:kept.length};g.economy.otherOwnedOutposts=posts.length-kept.length;}
 }
 // No changes to raw messages, directives, hard constraints, global victory
 // state, critical assets, all names, permissions or existing precomputations.
}
const scenarios={canonicalContracts,groupedKnowledge,stageHistory,candidateRules,irrelevantSelectors,militaryDigest,scopedHistory,scopedReceipts};
const corpusRows={contracts:new Map(),receipts:new Map()},cohorts={};
for(const sample of capture.samples){
 const prompt=await readFile(join(out,sample.file),'utf8');assert.equal(createHash('sha256').update(prompt).digest('hex'),sample.sha256);
 const m=readPromptMaterial(prompt);
 const root=anchors(m),g=m.global,h=m.guidance,f=m.facts,contracts=rows(h.serverAgreements),candidateRows=rows(g.planning.candidates),noEdit=h.editPolicy?.militaryEditsAllowed===false;
 const before=bodySize(m),short=abbreviator({global:g,guidance:h,facts:f}),shortSize=v=>sum(['global','guidance','facts'].map(k=>short({[k]:v[k]}).length));
 const role=totals[m.kind]??={calls:0,bodyChars:0,candidates:0,candidateChars:0,notDirectlyAnchoredCandidates:0,notDirectlyAnchoredCandidateChars:0,outsideTopicCandidates:0,outsideTopicCandidateChars:0,terminalRows:0,terminalPositiveTimeRows:0,terminalPositiveRemainingRows:0,terminalPotentialRewardRows:0,terminalCrossPeerRows:0,terminalCrossPeerRowChars:0,terminalAgeTotal:0,terminalPastDeadlineRows:0,receipts:0,receiptRowsOlderThan24:0,receiptCharsOlderThan24:0,receiptRowsOlderThan72:0,receiptCharsOlderThan72:0,ownFleetRows:0,notAnchoredOwnFleetRows:0,notAnchoredOwnFleetChars:0,foreignFleetRows:0,notAnchoredForeignFleetRows:0,notAnchoredForeignFleetChars:0,scenarios:{}};
 role.calls++;role.bodyChars+=before;
 const loose=candidateRows.filter(c=>!root.names.has(c.target)),looseTargets=new Set(loose.map(c=>c.target));
 const looseSources=new Set(loose.flatMap(c=>rows(c.launchSources).map(r=>r.source))),coreSources=new Set(candidateRows.filter(c=>root.names.has(c.target)).flatMap(c=>rows(c.launchSources).map(r=>r.source)));
 const extraPosts=rows(f.outposts).filter(p=>looseTargets.has(p.name??p.id)&&!root.names.has(p.name??p.id));
 add(role,'unanchoredTargetDetailRows',extraPosts.length);add(role,'unanchoredTargetDetailChars',sum(extraPosts.map(size)));
 const sourceColumn=g.economy.columns.includes('name')?g.economy.columns.indexOf('name'):g.economy.columns.indexOf('id');
 const extraSources=g.economy.ownPosts.filter(row=>looseSources.has(row[sourceColumn])&&!root.names.has(row[sourceColumn])&&!coreSources.has(row[sourceColumn]));
 add(role,'unanchoredExclusiveSourceRows',extraSources.length);add(role,'unanchoredExclusiveSourceChars',sum(extraSources.map(size)));
 const extraFleets=rows(f.fleets).filter(row=>!root.names.has(row.source)&&!root.names.has(row.destinationId)&&(looseTargets.has(row.source)||looseTargets.has(row.destinationId))&&!g.criticalAssets.hostileApproaches.some(f=>f.id===row.id));
 add(role,'unanchoredCandidateFleetRows',extraFleets.length);add(role,'unanchoredCandidateFleetChars',sum(extraFleets.map(row=>size(f.fleets.rows[rows(f.fleets).findIndex(f=>f.id===row.id)]))));
 for(let i=0;i<candidateRows.length;i++){
  const c=candidateRows[i],chars=size(g.planning.candidates.rows[i]);role.candidates++;role.candidateChars+=chars;
  if(!root.names.has(c.target)){role.notDirectlyAnchoredCandidates++;role.notDirectlyAnchoredCandidateChars+=chars;}
  if(!root.names.has(c.target)&&!root.players.has(c.owner)){role.outsideTopicCandidates++;role.outsideTopicCandidateChars+=chars;}
 }
 for(let i=0;i<contracts.length;i++){
  const c=contracts[i];if(!terminal(c))continue;
  role.terminalRows++;if(c.ticksLeft>0)role.terminalPositiveTimeRows++;
  if(c.ownRemaining>0)role.terminalPositiveRemainingRows++;
  if(c.ownTrustReward>0)role.terminalPotentialRewardRows++;
  if(m.kind==='diplomacy'&&!root.peers.has(c.peer)){role.terminalCrossPeerRows++;role.terminalCrossPeerRowChars+=size(h.serverAgreements.rows[i]);}
  if(g.time.worldDay>c.deadline){role.terminalPastDeadlineRows++;role.terminalAgeTotal+=g.time.worldDay-c.deadline;}
  const key=sample.seat+':'+hash(h.serverAgreements.rows[i]);const item=corpusRows.contracts.get(key)??{seat:sample.seat,repetitions:0,characters:size(h.serverAgreements.rows[i]),key:sample.key};item.repetitions++;corpusRows.contracts.set(key,item);
 }
 role.receipts+=h.contractResults.rows.length;
 const rr=rows(h.contractResults);for(let i=0;i<rr.length;i++){
  const age=g.time.worldDay-rr[i].time,chars=size(h.contractResults.rows[i]);
  if(age>24){role.receiptRowsOlderThan24++;role.receiptCharsOlderThan24+=chars;}
  if(age>72){role.receiptRowsOlderThan72++;role.receiptCharsOlderThan72+=chars;}
  const key=sample.seat+':'+hash(h.contractResults.rows[i]),item=corpusRows.receipts.get(key)??{seat:sample.seat,repetitions:0,characters:chars,key:sample.key};item.repetitions++;corpusRows.receipts.set(key,item);
 }
 for(const [kind,t]of [['own',g.ownFleets],['foreign',f.fleets]])for(const [i,fleet]of rows(t).entries()){
  add(role,kind+'FleetRows');
  const destination=destinationOf(fleet);
  const anchored=root.names.has(fleet.source)||root.names.has(destination)||(g.criticalAssets.hostileApproaches??[]).some(x=>x.id===fleet.id)||[...rows(h.intentTasks),...rows(h.readOnlyIntentTasks)].some(t=>t.fleetId===fleet.id);
  if(!anchored){add(role,'notAnchored'+(kind==='own'?'Own':'Foreign')+'FleetRows');add(role,'notAnchored'+(kind==='own'?'Own':'Foreign')+'FleetChars',size(t.rows[i]));}
 }
 const result={sample:sample.key,role:m.kind,noEdit,before,shortBefore:shortSize(m),anchors:[...root.names],scenarios:{}};
 function record(name,changed){
  const after=bodySize(changed),saving=before-after,normalizedSaving=shortSize(m)-shortSize(changed);
  result.scenarios[name]={after,saving,normalizedSaving};
  const s=role.scenarios[name]??={calls:0,before:0,after:0,saving:0,normalizedBefore:0,normalizedSaving:0,positive:0,negative:0};
  s.calls++;s.before+=before;s.after+=after;s.saving+=saving;s.normalizedBefore+=shortSize(m);s.normalizedSaving+=normalizedSaving;if(saving>0)s.positive++;if(saving<0)s.negative++;
  for(const section of ['global','guidance','facts'])for(const key of new Set([...Object.keys(m[section]),...Object.keys(changed[section])])){
   const b=Object.hasOwn(m[section],key)?size({[key]:m[section][key]})-1:0,a=Object.hasOwn(changed[section],key)?size({[key]:changed[section][key]})-1:0;
   if(a!==b)ledger.push({sample:sample.key,role:m.kind,scenario:name,path:section+'.'+key,before:b,after:a,saving:b-a});
  }
  // Invariants for all counterfactuals: no new facts, no messaging/constraint changes.
  for(const path of ['evidence','changes'])assert.deepEqual(changed[path],m[path]);
  for(const key of ['commander','executionRules','diplomacyPurpose','strategic'])assert.deepEqual(changed.guidance[key],m.guidance[key]);
  assert.deepEqual(changed.global.criticalAssets,m.global.criticalAssets);
  assert.deepEqual(changed.global.players,m.global.players);
  assert.deepEqual(changed.global.planning.estimates,m.global.planning.estimates);
  assert.deepEqual(changed.global.identities,m.global.identities);
  if(changed.global.ownFleets.related){
   const detailed=rows(changed.global.ownFleets.related),protectedIds=new Set(h.editPolicy?.militaryEditsAllowed?h.editPolicy.returnFleetIds:[]);
   for(const f of rows(g.ownFleets))if(root.names.has(f.source)||root.names.has(destinationOf(f))||protectedIds.has(f.id))assert.deepEqual(detailed.find(x=>x.id===f.id),f,'Keep current-target reinforcements and every legally editable return fleet');
  }
  const revisedContracts=rows(changed.guidance.serverAgreements);
  for(const a of contracts.filter(a=>!terminal(a)))assert.deepEqual(revisedContracts.find(c=>c.id===a.id),a,'Keep every active/proposed contract');
  if(changed.guidance.relationAdvice.agreementCapacity?.unknownPeers){
   const newCapacity=changed.guidance.relationAdvice.agreementCapacity;
   for(const p of m.guidance.relationAdvice.agreementCapacity){
    if(p.complete)assert.deepEqual(newCapacity.complete.find(c=>c.player===p.player),p);
    else{const row=rows(newCapacity.unknownPeers).find(c=>c.player===p.player);assert.ok(row);assert.equal(row.visibleCeasefiresLowerBound,p.visibleCeasefiresLowerBound??p.ceasefires);assert.equal(row.visibleJointAttacksLowerBound,p.visibleJointAttacksLowerBound??p.jointAttacks);}
   }
  }
  assert.deepEqual(changed.guidance.editPolicy?.contracts,m.guidance.editPolicy?.contracts?.map(c=>{
   const v=structuredClone(c);
   // Canonical variants move equal scalars to their contract, not permissions.
   if(['canonicalContracts','combined','focusedCombined'].includes(name)){
    const a=rows(m.guidance.serverAgreements).find(a=>a.id===c.agreementId);
    for(const k of Object.keys(v))if(k!=='agreementId'&&Object.hasOwn(a??{},k)&&JSON.stringify(v[k])===JSON.stringify(a[k]))delete v[k];
   }
   return v;
  }));
  const afterCandidates=[...rows(changed.global.planning.candidates),...rows(changed.global.planning.otherNegotiationAttackOptions)];
  assert.equal(afterCandidates.length,candidateRows.length);
  for(const c of candidateRows){const revised=afterCandidates.find(x=>x.target===c.target);assert.ok(revised);for(const k of ['owner','classification','score','attackWorldDays','suggestedUntil','additionalForceEstimate','newForceForScreenedAttackEstimate','launchSources'])assert.deepEqual(revised[k],c[k]);}
  const lines=ledger.filter(l=>l.sample===sample.key&&l.scenario===name);assert.equal(sum(lines.map(l=>l.saving)),saving,'Disjoint top-level deltas must equal exact full-body delta');
  verifiedScenarioCases++;
 }
 for(const [name,fn]of Object.entries(scenarios)){const x=structuredClone(m);fn(x);record(name,x);}
 const combined=structuredClone(m);stageHistory(combined);canonicalContracts(combined);groupedKnowledge(combined);candidateRules(combined);irrelevantSelectors(combined);militaryDigest(combined);record('combined',combined);
 const focused=structuredClone(m);scopedReceipts(focused);scopedHistory(focused);canonicalContracts(focused);if(m.kind==='diplomacy')groupedKnowledge(focused);candidateRules(focused);irrelevantSelectors(focused);militaryDigest(focused);record('focusedCombined',focused);
 const cohort=m.kind==='diplomacy'?(noEdit?'noEditDiplomacyFocused':'editableDiplomacyFocused'):'strategyFocused';
 const cohortResult=cohorts[cohort]??={calls:0,before:0,saving:0,normalizedBefore:0,normalizedSaving:0};cohortResult.calls++;cohortResult.before+=before;cohortResult.saving+=result.scenarios.focusedCombined.saving;cohortResult.normalizedBefore+=result.shortBefore;cohortResult.normalizedSaving+=result.scenarios.focusedCombined.normalizedSaving;
 if(details.length===0||m.kind==='strategy'&&!details.some(d=>d.role==='strategy')){
  await writeFile(join(out,'relevance-example-'+m.kind+'.json'),JSON.stringify({sample:sample.key,original:m,proposed:focused},null,2));
 }
 if(noEdit){const x=cohorts.noEditDiplomacy??={calls:0,before:0,saving:0,normalizedBefore:0,normalizedSaving:0};x.calls++;x.before+=before;x.saving+=result.scenarios.combined.saving;x.normalizedBefore+=result.shortBefore;x.normalizedSaving+=result.scenarios.combined.normalizedSaving;}
 details.push(result);
}
const repeat=Object.fromEntries(Object.entries(corpusRows).map(([key,map])=>[key,{occurrences:sum([...map.values()].map(x=>x.repetitions)),distinctSeatRows:map.size,repeatedCharacters:sum([...map.values()].map(x=>(x.repetitions-1)*x.characters)),mostRepeated:[...map.values()].sort((a,b)=>b.repetitions-a.repetitions).slice(0,8)}]));
const report={at:new Date().toISOString(),capture:capture.startedAt,scope:'same frozen 159 calls; raw UTF-16 body sizes; counterfactual views only, no production modifications',totals,cohorts,temporalRepetition:repeat,details,limitations:['Not directly named is a structural signal, not proof of irrelevance.','Counterfactual history/candidate/fleet summaries omit detail; they are conditional design experiments, not lossless compression or quality-validated input.','All legal source facts remain in program audit; this script does not change the actual prompt.','Repeated rows across stateless calls cannot simply be removed without a replacement current summary.','Short-ID normalization uses a common original-call mapping to isolate composition savings from spelling savings.']};
await writeFile(join(out,'relevance-analysis.json'),JSON.stringify(report,null,2));
await writeFile(join(out,'relevance-verification.json'),JSON.stringify({passed:true,at:new Date().toISOString(),sourceFiles:capture.samples.length,scenarioCases:verifiedScenarioCases,checks:['Frozen source SHA-256','Whole-body before/after sizes','Disjoint top-level delta ledger sums','Raw messages and actual changes unchanged','Commander text, strategic notes, purpose, and hard constraints unchanged','Critical assets, global player state and all names unchanged','All candidate costs, sources, timing, score and classification preserved','All force-source reserve/available estimates unchanged','Every active and proposed contract preserved','Knowledge lower bounds and complete own-capacity record preserved','Editable task and target scopes unchanged except equal scalars moved to canonical contracts'],limitations:'Checks cover these specific invariants only. Historical grouping and military digests omit some details; no claim of semantic equivalence, executable wire validity, or model-quality validation.'},null,2));
const csv=s=>'"'+String(s).replaceAll('"','""')+'"';
await writeFile(join(out,'relevance-transformations.csv'),'sample,role,scenario,path,before,after,saving\n'+ledger.map(row=>Object.values(row).map(csv).join(',')).join('\n'));
console.log(JSON.stringify({totals,cohorts,temporalRepetition:repeat}));
