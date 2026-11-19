import type {PlayerObservation} from '@subterfuge/bot-sdk/contracts';
import type {IntentSpec,IntentTask,StrategicAssessment} from './contracts.js';

export interface DiplomacyContractEdits {
 agreementId:string;deadline:number;enemy:number|null;ownFulfilled:boolean|null;
 captureTargets:string[];avoidTargets:string[];editableTaskIds:string[];
}
export interface DiplomacyEditScope {
 contracts:DiplomacyContractEdits[];friendlyTargets:string[];returnFleetIds:string[];
}
const terminal=(task:IntentTask)=>['completed','cancelled','expired'].includes(task.status);

/** Capabilities use only the current authorized observation and persisted origins. */
export function diplomacyEditScope(o:PlayerObservation,tasks:readonly IntentTask[],conversation:string,peers:readonly number[]):DiplomacyEditScope {
 const self=o.view.player,now=o.view.tick+o.secondsSinceLastTick/600;
 const posts=o.view.outposts.filter(p=>!p.destroyed);
 const contracts=(o.diplomacy?.agreements??[]).filter(a=>peers.length===1&&a.status==='active'&&a.deadline>now&&a.players.includes(self)&&a.players.includes(peers[0]!)).map(a=>{
  const index=a.players.indexOf(self),terms=a.terms,joint=terms.kind==='joint-attack',enemy=terms.kind==='joint-attack'?terms.enemy:null;
  const fulfilled=joint?a.fulfilled[index]===true:null;
  const mayCapture=terms.kind==='joint-attack'&&!fulfilled;
  return {agreementId:a.id,deadline:a.deadline,enemy,ownFulfilled:fulfilled,
   captureTargets:mayCapture?posts.filter(p=>p.owner===enemy).map(p=>p.id):[],
   avoidTargets:posts.filter(p=>p.owner===self||p.owner===peers[0]||enemy!==null&&p.owner===enemy).map(p=>p.id),
   editableTaskIds:tasks.filter(t=>t.authority==='model'&&!terminal(t)&&t.spec.until>now&&t.origin?.conversation===conversation&&t.origin.agreementId===a.id).map(t=>t.id)};
 });
 return {contracts,friendlyTargets:posts.filter(p=>p.owner===self).map(p=>p.id),returnFleetIds:o.view.fleets.filter(f=>f.owner===self&&f.canReturn===true).map(f=>f.id)};
}

export function namedDiplomacyEditScope(scope:DiplomacyEditScope,name:(id:string)=>string):DiplomacyEditScope {
 return {...scope,friendlyTargets:scope.friendlyTargets.map(name),contracts:scope.contracts.map(c=>({...c,captureTargets:c.captureTargets.map(name),avoidTargets:c.avoidTargets.map(name)}))};
}

/** The same scope constrains the permission catalog and actual publication. */
export function assertDiplomacyEdits(a:Pick<StrategicAssessment,'intentEdits'|'fulfillAgreementId'>,scope:DiplomacyEditScope,name:(id:string)=>string=id=>id):DiplomacyContractEdits|null {
 const edits=a.intentEdits;if(!edits||!edits.upsert.length&&!edits.cancel.length)return null;
 const source=a.fulfillAgreementId??(scope.contracts.length===1?scope.contracts[0]!.agreementId:null);
 const contract=scope.contracts.find(c=>c.agreementId===source);
 if(!contract)throw Error('外交军事编辑必须关联当前会话唯一已签署协议；多份合同时只选择editPolicy.contracts所列身份，不猜测或改写合同ID');
 const ids=new Set(contract.editableTaskIds);
 const editable=(id:string)=>{if(!ids.has(id))throw Error('外交轮只能编辑当前合同的editableTaskIds；独立战略、指挥官和其他会话或合同任务只读');};
 for(const id of edits.cancel)editable(id);
 for(const edit of edits.upsert){
  if(edit.id!==null)editable(edit.id);
  const task=edit.task;
  const target='target'in task?name(task.target):null;
  const allowed=(targets:string[])=>target!==null&&targets.includes(target);
  let valid=false;
  switch(task.kind){
   case 'capture':
    if(contract.ownFulfilled)throw Error('本方占领目标已达标，外交轮不再新增或修改履约进攻；独立战略任务保持只读');
    valid=allowed(contract.captureTargets);break;
   case 'configure':valid=allowed(scope.friendlyTargets);break;
   case 'transfer':valid=allowed(scope.friendlyTargets)&&scope.friendlyTargets.includes(name(task.source));break;
   case 'avoid':valid=allowed(contract.avoidTargets);break;
   case 'return-fleet':valid=scope.returnFleetIds.includes(task.fleetId);break;
  }
  if(!valid)throw Error(`外交任务${task.kind}超出当前合同允许的目标或舰队范围；只使用editPolicy给出的候选，其他战略保持只读`);
 }
 return contract;
}

export function diplomacyTaskTargets(kind:IntentSpec['kind'],scope:DiplomacyEditScope):string[]{
 if(kind==='capture')return [...new Set(scope.contracts.flatMap(c=>c.captureTargets))];
 if(kind==='avoid')return [...new Set(scope.contracts.flatMap(c=>c.avoidTargets))];
 return scope.friendlyTargets;
}
