import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {readPromptMaterial} from '../dist/packages/contracts/src/index.js';
const out=resolve(process.argv[2]??'outputs/ai-context-audit-20261030'),capture=JSON.parse(await readFile(join(out,'capture.json'))),calls=JSON.parse(await readFile(join(out,'per-call.json')));
const roles={},details=[];
const tableRows=t=>t?.columns&&t.rows?t.rows.map(row=>Object.fromEntries(t.columns.map((c,i)=>[c,row[i]]))):[];
const size=m=>['global','guidance','facts'].reduce((n,k)=>n+JSON.stringify({[k]:m[k]}).length,0);
function objectTables(value){
 if(Array.isArray(value))return value.map(objectTables);
 if(!value||typeof value!=='object')return value;
 const columns=value.columns,rowKey=Array.isArray(value.rows)?'rows':Array.isArray(value.ownPosts)?'ownPosts':null;
 if(Array.isArray(columns)&&rowKey&&columns.every(c=>typeof c==='string')&&value[rowKey].every(r=>Array.isArray(r)&&r.length===columns.length)){
  const records=value[rowKey].map(row=>Object.fromEntries(columns.map((c,i)=>[c,objectTables(row[i])]))),rest=Object.fromEntries(Object.entries(value).filter(([k])=>k!=='columns'&&k!==rowKey).map(([k,v])=>[k,objectTables(v)]));
  return Object.keys(rest).length?{...rest,[rowKey]:records}:records;
 }
 return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,objectTables(v)]));
}
for(const sample of capture.samples){
 const call=calls.find(c=>c.key===sample.key),material=readPromptMaterial(await readFile(join(out,sample.file),'utf8')),g=material.global,h=material.guidance,f=material.facts;
 const r=roles[sample.kind]??={calls:0,bodyChars:0,sourceMetadataCharacters:0,sourceMetadataFields:0,uneditableCalls:0,uneditableSelectorCharacters:0,contractRows:0,terminalContractRows:0,terminalRowCharacters:0,contractCells:0,nullContractCells:0,receipts:0,peerUnrelatedReceipts:0,peerUnrelatedReceiptCharacters:0,duplicateQueryableTaskRefs:0,duplicateQueryableTaskCharacters:0,taskKinds:{},taskRowsMissingTransferDetails:0,requestableCalls:0,requestableEntries:0,hiddenCapacityRows:0,hiddenCapacityCharacters:0,capacityUnknownNullMembers:0,capacityUnknownMemberCharacters:0,capacityMeaningRepeatedCharacters:0,sourceWorldDayDuplicate:0,ownFleetRows:0,ownFleetRowsWithEta:0,foreignFleetRows:0,foreignFleetRowsWithEta:0,criticalIncomingRows:0,criticalIncomingRowsWithEta:0,allTablesToObjectsDelta:0};
 r.calls++;r.bodyChars+=call.bodyChars;
 const fields=Object.values(call.sections).flatMap(s=>s.fields),metadata=fields.filter(f=>['$.global.planning.basisRevision','$.global.planning.worldDay','$.global.commanderVersion'].includes(f.path));
 r.sourceMetadataCharacters+=metadata.reduce((n,f)=>n+f.memberCharacters,0);r.sourceMetadataFields+=metadata.length;
 if(g.time.worldDay===g.planning.worldDay)r.sourceWorldDayDuplicate++;
 const contracts=tableRows(h.serverAgreements),terminal=contracts.filter(c=>!['active','proposed'].includes(c.status));
 r.contractRows+=contracts.length;r.terminalContractRows+=terminal.length;
 r.terminalRowCharacters+=h.serverAgreements.rows.filter((row,i)=>terminal.includes(contracts[i])).reduce((n,row)=>n+JSON.stringify(row).length,0);
 r.contractCells+=h.serverAgreements.rows.reduce((n,row)=>n+row.length,0);r.nullContractCells+=h.serverAgreements.rows.reduce((n,row)=>n+row.filter(v=>v===null).length,0);
 const receipts=tableRows(h.contractResults);r.receipts+=receipts.length;
 const peers=h.fixedConversation.identities.map(p=>p.gamePlayer).filter(p=>p!==null);
 if(sample.kind==='diplomacy'){
  const currentIds=new Set(contracts.filter(c=>peers.includes(c.peer)).map(c=>c.id));
  for(let i=0;i<receipts.length;i++){const row=receipts[i],v=row.result??{};const related=currentIds.has(row.agreementId)||peers.includes(row.actor)||peers.includes(v.from)||peers.includes(v.to);if(!related){r.peerUnrelatedReceipts++;r.peerUnrelatedReceiptCharacters+=JSON.stringify(h.contractResults.rows[i]).length;}}
 }
 if(h.editPolicy?.militaryEditsAllowed===false){r.uneditableCalls++;r.uneditableSelectorCharacters+=fields.filter(f=>['$.guidance.editPolicy.friendlyTargets','$.guidance.editPolicy.returnFleetIds'].includes(f.path)).reduce((n,f)=>n+f.memberCharacters,0);}
 const tasks=[...tableRows(h.intentTasks),...tableRows(h.readOnlyIntentTasks)];
 for(const task of tasks){r.taskKinds[task.kind]=(r.taskKinds[task.kind]??0)+1;if(task.kind==='transfer'&&(!Object.hasOwn(task,'source')||!Object.hasOwn(task,'drillers')))r.taskRowsMissingTransferDetails++;}
 const detailedIds=new Set(tasks.filter(t=>['capture','configure','avoid','return-fleet'].includes(t.kind)).map(t=>t.id));
 for(const ref of f.requestableInformation??[])if(detailedIds.has(ref)){r.duplicateQueryableTaskRefs++;r.duplicateQueryableTaskCharacters+=JSON.stringify(ref).length+1;}
 if(f.requestableInformation?.length)r.requestableCalls++;r.requestableEntries+=f.requestableInformation?.length??0;
 const capacity=h.relationAdvice?.agreementCapacity??[];
 for(const p of capacity.filter(p=>p.complete===false)){
  r.hiddenCapacityRows++;r.hiddenCapacityCharacters+=JSON.stringify(p).length;
  for(const k of ['actualCeasefires','actualJointAttacks','remainingCeasefires','remainingJointAttacks'])if(p[k]===null){r.capacityUnknownNullMembers++;r.capacityUnknownMemberCharacters+=JSON.stringify(k).length+1+4+1;}
 }
 if(capacity.filter(p=>p.meaning).length>1)r.capacityMeaningRepeatedCharacters+=(capacity.filter(p=>p.meaning).length-1)*(JSON.stringify(capacity.find(p=>p.meaning).meaning).length+'"meaning":'.length+1);
 const hasEta=keys=>keys.some(k=>/arrival|eta|travel|remaining.*(?:day|tick)/i.test(k));
 const own=tableRows(g.ownFleets),foreign=tableRows(f.fleets),incoming=g.criticalAssets.hostileApproaches;
 r.ownFleetRows+=own.length;r.ownFleetRowsWithEta+=own.filter(p=>hasEta(Object.keys(p))).length;
 r.foreignFleetRows+=foreign.length;r.foreignFleetRowsWithEta+=foreign.filter(p=>hasEta(Object.keys(p))).length;
 r.criticalIncomingRows+=incoming.length;r.criticalIncomingRowsWithEta+=incoming.filter(p=>hasEta(Object.keys(p))).length;
 const objectSize=size(objectTables(material));r.allTablesToObjectsDelta+=objectSize-call.bodyChars;
 details.push({key:sample.key,kind:sample.kind,uneditable:h.editPolicy?.militaryEditsAllowed===false,terminalContracts:terminal.length,contracts:contracts.length,sourceMetadataCharacters:metadata.reduce((n,f)=>n+f.memberCharacters,0),objectTableDelta:objectSize-call.bodyChars});
}
await writeFile(join(out,'semantic-metrics.json'),JSON.stringify({roles,details},null,2));
console.log(JSON.stringify(roles));
