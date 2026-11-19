import type {SituationBrief,StrategicAssessment} from './contracts.js';
import {assertDiplomacyEdits} from './diplomacy-edit-scope.js';

/** Narrow checks for explicit assertions with program-owned answers. Strategic
 * deception is an AI choice; this is not a general natural-language truth oracle. */
export function validateDiplomacyMessage(a:StrategicAssessment,b:SituationBrief,names:Readonly<Record<string,string>>={}):void{
 if(b.kind!=='diplomacy')return;
 const h=b.guidance as any,g=b.global as any,facts=h.communicationFacts;
 if(h.editPolicy?.contracts)assertDiplomacyEdits(a,h.editPolicy,id=>names[id]??id);
 const action=a.diplomacyAction;
 if(action&&facts){
  if(action.kind==='propose-agreement'){
   if(facts.peers.length!==1||action.peer!==facts.peers[0])throw Error('正式提案对象必须是当前会话对方');
   if(action.terms.kind==='ceasefire'&&action.terms.outposts.some(id=>!facts.eligibleCeasefireOutposts.includes(names[id]??id)))throw Error('正式停战据点不属于双方；只选eligibleCeasefireOutposts，不可把中立争夺点或第三方据点写入停战');
   if(action.terms.kind==='joint-attack'&&[facts.self,...facts.peers].includes(action.terms.enemy))throw Error('联合进攻目标必须是存活第三方');
  }else{
   const target=facts.scopeContracts.find((c:any)=>c.id===action.agreementId);
   if(!target||!(target.status==='proposed'&&target.allowedActions?.split(',').includes(action.response)||target.status==='active'&&action.response==='accept'))throw Error('没有该可响应的待签提案；只使用当前会话合法提案身份，旧提案不能复活');
  }
 }
 const eligible=h.editPolicy?.eligibleAgreementIds??[];
 const source=a.fulfillAgreementId??(eligible.length===1?eligible[0]:null);
 const hasEdits=!!(a.intentEdits?.upsert.length||a.intentEdits?.cancel.length);
 if(hasEdits&&h.editPolicy&&(!h.editPolicy.militaryEditsAllowed||!source||!eligible.includes(source)))throw Error('军事履约编辑必须关联已签协议并复制当前会话唯一合法fulfillAgreementId；不得拼写或猜测合同身份，无可编辑合同时tasks与cancel应为空');
 if(a.intentEdits?.upsert.some(e=>e.task.kind==='capture')&&h.contractFeasibility?.some((c:any)=>c.agreementId===source&&c.ownFulfilled===true))throw Error('本方占领目标已达标，不再为该合同新增履约进攻；对方缺口不能由本方代替。可维护防守，独立战略进攻交战略职责决定');
 const obligation=h.contractFeasibility?.find((c:any)=>c.agreementId===source);
 if(obligation&&facts)for(const edit of a.intentEdits?.upsert??[]){
  if(edit.task.kind!=='capture')continue;
  const target=names[edit.task.target]??edit.task.target;
  const identity=(g.identities??[]).find((p:any[])=>p[0]===target);
  if(typeof identity?.[1]==='number'&&![facts.self,obligation.enemy].includes(identity[1]))throw Error(`履约目标${target}属于其他敌人，不能关联本合同；本轮只修当前会话合同的进攻，其他合同和独立战略任务保持原样`);
 }
 if(!a.message)return;
 const text=a.message;
 if(/\b(?:Schema|editPolicy|permissions|fulfillAgreementId|requestableInformation|intent-\d+)\b|固定会话|军事编辑权限/i.test(text))throw Error('外交message含内部控制术语；只对外表达立场、条件、问题或结果，内部限制写internalIntent，也可以message=null');
 if(facts&&!/披露|透露|情报交易|交换.{0,8}情报/u.test(a.agreement.internalIntent)){
  const table=h.serverAgreements,agreements=table?.columns&&table?.rows?table.rows.map((r:any[])=>Object.fromEntries(table.columns.map((k:string,i:number)=>[k,r[i]]))):[];
  const roster=g.roster?.columns&&g.roster?.rows?g.roster.rows.map((r:any[])=>Object.fromEntries(g.roster.columns.map((k:string,i:number)=>[k,r[i]]))):[];
  for(const agreement of agreements){
   if(facts.peers.includes(agreement.peer))continue;
   const name=roster.find((r:any)=>r.gamePlayer===agreement.peer)?.name;if(typeof name!=='string'||!name)continue;
   const at=text.indexOf(name);if(at<0)continue;
   const before=text.slice(Math.max(0,at-12),at),after=text.slice(at+name.length,at+name.length+30);
   if(/(?:我方|本方|我们).{0,6}与$/u.test(before)&&/合同|协议|签署|提案|履约/u.test(after))throw Error('外交message无意披露其他会话合同；其他伙伴与条款留作内部预算。若确为战略情报交易，须在internalIntent明确说明主动披露目的');
  }
 }
 if(/欺骗|虚张声势|佯攻|诈|假意|战略信号|威慑/.test(a.agreement.internalIntent))return;
 if(!facts)return;
 const clauses=text.split(/[，。；;！？!?\n]/u);
 const own=new Set(facts.ownOutposts??[]);
 const identities=Array.isArray(g.identities)?g.identities:[];
 const prior=[h.intentTasks,h.readOnlyIntentTasks].flatMap(table=>table?.columns&&table?.rows?table.rows.map((r:any[])=>Object.fromEntries(table.columns.map((k:string,i:number)=>[k,r[i]]))):[]);
 const planned=new Set([...(a.intentEdits?.upsert??[]).filter(e=>e.task.kind==='capture').map(e=>'target'in e.task?(names[e.task.target]??e.task.target):''),...prior.filter((t:any)=>t.kind==='capture'&&!['completed','cancelled','expired'].includes(t.status)).map((t:any)=>t.target)]);
 const escape=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 for(const clause of clauses){
  if(!/(?:我方|本方)(?:将|继续|集中|保持|负责|优先|已经|已|正在|持续|会|在|的|\s)*(?:防守|留守|驻守|守住)/u.test(clause))continue;
  for(const identity of identities){
   const [name,owner]=identity;if(typeof name!=='string'||owner===null||owner===undefined||own.has(name)||/将|会/u.test(clause)&&planned.has(name))continue;
   if(new RegExp('(?:防守|留守|驻守|守住)\\s*'+escape(name)+'(?![A-Za-z0-9_-])','u').test(clause))throw Error(`外交主体不符：${name}不属于本方；区分你方防守与本方行动，确有协防意图应说明协防，不能复述盟友话语为本方现状`);
  }
 }
 if(action&&clauses.some(c=>!/(?:若|如果|待|未|不|没有)/u.test(c)&&/(?:合同|协议)(?:已经|已)(?:签署|生效)/u.test(c))){
  const id=action.kind==='respond-agreement'?action.agreementId:null;
  if(!id||!facts.scopeContracts?.some((c:any)=>c.id===id&&c.status==='active'))throw Error('外交签署表述超前：本轮仅提交提案或签署请求，尚无该协议生效回执；说同意条款或提出条款，不声称已生效');
 }
 if(clauses.some(c=>!/(?:若|如果|待|未知|不确定|是否)/u.test(c)&&/双方(?:都|均)?(?:无占用|没有占用|有(?:可用|剩余)名额)/u.test(c)))throw Error('外交容量表述越界：对方完整合同容量未知，不能把零可见合同说成双方均无占用');
}
