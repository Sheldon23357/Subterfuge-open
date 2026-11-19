import {notebookDependencies,type NotebookDependencySummary} from './notebook-dependencies.js';
import type {AiSnapshot,MemoryRecord,NotebookEntry} from '../contracts/types.js';

export const RECORD_STATUSES={
  relation:['unknown','neutral','negotiating','cooperating','ceasefire','hostile'],
  agreement:['proposed','active','fulfilled','expired','rejected','revoked','breached'],
  plan:['candidate','active','blocked','completed','abandoned','superseded'],
} as const;
const CLOSED=new Set(['fulfilled','expired','rejected','revoked','breached','completed','abandoned','superseded']);
export const isClosedMemoryStatus=(status:unknown)=>typeof status==='string'&&CLOSED.has(status);
export const isActiveNote=(n:NotebookEntry,now:number)=>(n.expiresAt===null||n.expiresAt>now)&&!isClosedMemoryStatus(n.record?.status);
const obj=(v:unknown):Record<string,unknown>=>{
  if(!v||typeof v!=='object'||Array.isArray(v))throw Error('Invalid memory record');return v as Record<string,unknown>;
};
const strings=(v:unknown,max:number,length:number)=>Array.isArray(v)&&v.length<=max&&new Set(v).size===v.length&&v.every(s=>typeof s==='string'&&s.trim()&&s.length<=length);
export const MEMORY_RECORD_LIMITS={summary:360,entities:16,entityLength:100,links:16,linkLength:89,evidence:8,evidenceLength:160};

export function validateRecord(raw:unknown,note:{id:string;kind:string;expiresAt:unknown},snapshot:AiSnapshot):MemoryRecord{
  const r=obj(raw),required=['type','status','summary','players','entities','links','evidence','reviewAt'];
  if(required.some(k=>!(k in r))||Object.keys(r).some(k=>![...required,'scores'].includes(k)))throw Error(JSON.stringify({code:'INVALID_RECORD_FIELDS',message:'Invalid record fields',path:`notebook[${note.id}].record`,missingFields:required.filter(k=>!Object.hasOwn(r,k)),unknownFields:Object.keys(r).filter(k=>![...required,'scores'].includes(k)),correction:'Supply the required record structure; evidence is never fabricated and inherited fields are not new confirmation; no changes saved'}));
  if(!Object.hasOwn(RECORD_STATUSES,String(r.type))||!(RECORD_STATUSES[r.type as keyof typeof RECORD_STATUSES] as readonly unknown[]).includes(r.status))throw Error('Invalid record lifecycle');
  const path=`notebook[${note.id}].record`;
  if(typeof r.summary!=='string'||!r.summary.trim()||r.summary.length>MEMORY_RECORD_LIMITS.summary)throw Error(`Invalid record summary: ${path}.summary must be nonblank, maximum ${MEMORY_RECORD_LIMITS.summary} characters; received ${typeof r.summary==='string'?r.summary.length:typeof r.summary}. No changes saved.`);
  for(const [field,max,length] of [['entities',MEMORY_RECORD_LIMITS.entities,MEMORY_RECORD_LIMITS.entityLength],['links',MEMORY_RECORD_LIMITS.links,MEMORY_RECORD_LIMITS.linkLength],['evidence',MEMORY_RECORD_LIMITS.evidence,MEMORY_RECORD_LIMITS.evidenceLength]] as const)
    if(!strings(r[field],max,length))throw Error(`Invalid record references: ${path}.${field} requires unique nonblank strings, maximum ${max} items and ${length} characters/item; received ${Array.isArray(r[field])?r[field].length:typeof r[field]}. No changes saved.`);
  const players=new Set(snapshot.roster?.map(p=>p.gamePlayer)??[snapshot.observation.view.player,...snapshot.observation.view.outposts.flatMap(p=>p.owner==null?[]:[p.owner])]);
  if(!Array.isArray(r.players)||r.players.length>32||new Set(r.players).size!==r.players.length||r.players.some(p=>!Number.isSafeInteger(p)||!players.has(p)))throw Error('Unknown record player');
  if(r.reviewAt!==null&&(!Number.isSafeInteger(r.reviewAt)||Number(r.reviewAt)<0))throw Error('Invalid record review time');
  if(r.type==='agreement'&&note.kind!=='agreement'||r.type==='plan'&&note.kind!=='plan'||r.type==='relation'&&note.kind!=='note')throw Error('Record kind mismatch');
  if(r.type==='relation'){
    if(r.players.length!==1||r.players[0]===snapshot.observation.view.player||note.id!==`relation:${r.players[0]}`||note.expiresAt!==null)throw Error('Use one permanent relation:<gamePlayer> record per opponent');
    const scores=obj(r.scores),names=['trust','hostility','threat','cooperation','confidence'];
    if(Object.keys(scores).length!==5||names.some(k=>!(k in scores)||!(k!=='confidence'&&scores[k]===null)&&(!Number.isInteger(scores[k])||Number(scores[k])<0||Number(scores[k])>100)))throw Error('Invalid relation scores');
  }else if(r.scores!==undefined)throw Error('Scores belong only to relations');
  if((r.status!=='unknown'||r.type!=='relation')&&!(r.evidence as string[]).length)throw Error('Record decisions require evidence references');
  return r as unknown as MemoryRecord;
}

/** Conservative selection: unknown, stale, global, and binding material stays full.
 * Only explicitly summarized, scoped plans/relations can lose their detail text. */
export function notebookContext(snapshot:AiSnapshot){
  const now=snapshot.observation.view.tick*600+snapshot.observation.secondsSinceLastTick;
  const notes=(snapshot.notebook??[]).filter(n=>isActiveNote(n,now)),task=snapshot.task;
  const full=!task||task.fullContext||task.notebookReview||task.category!=='diplomacy'&&task.scope!=='local';
  const resolver=notebookDependencies(snapshot);
  const summaries=(selected:Set<string>)=>{
    const found=new Map<string,NotebookDependencySummary>();
    const campaigns=new Set<string>();
    for(const n of notes)if(selected.has(n.id))for(const link of n.record?.links??[]){const target=resolver.resolve(link);if(target?.summary)found.set(target.id,target.summary);if(target?.active&&target.id.startsWith('campaign:'))campaigns.add(target.id.slice(9));}
    return {...found.size?{notebookDependencySummaries:[...found.values()]}:{},...campaigns.size?{notebookDependencyCampaigns:(snapshot.campaigns??[]).filter(c=>campaigns.has(c.id))}:{}};
  };
  if(full)return {notebook:notes,...summaries(new Set(notes.map(n=>n.id)))};
  const entities=new Set(task.entities),players=new Set<number>();
  for(const m of snapshot.chat){const p=snapshot.roster?.find(p=>p.chatPlayer===m.from)?.gamePlayer;if(p!==undefined)players.add(p);}
  for(const p of snapshot.observation.view.outposts)if(entities.has(p.id)&&p.owner!=null)players.add(p.owner);
  for(const f of snapshot.observation.view.fleets)if(entities.has(f.id)){
    if(f.owner!=null)players.add(f.owner);
    if(f.source)entities.add(f.source);if(f.destination)entities.add(f.destination.id);
  }
  for(const reminder of snapshot.reminders??[])if(reminder.atSeconds<=now)for(const e of reminder.entities??[])entities.add(e);
  const selected=new Set(notes.filter(n=>{
    const r=n.record;
    return !r||n.kind==='agreement'&&r.status==='active'||n.id==='diplomacy-brief'||r.reviewAt!==null&&r.reviewAt<=now||now-n.updatedAt>=21600||
      !r.players.length&&!r.entities.length||entities.has(n.id)||r.entities.some(id=>entities.has(id))||r.players.some(p=>players.has(p));
  }).map(n=>n.id));
  // Include both prerequisites and dependents, transitively, without truncation.
  const closure=new Set([...selected].map(id=>`note:${id}`));
  let changed=true;while(changed){changed=false;for(const n of notes)for(const link of n.record?.links??[]){
    const target=resolver.resolve(link);if(!target?.active)continue;
    const source=`note:${n.id}`,id=target.id;
    if(closure.has(source)||closure.has(id)){if(!closure.has(source)||!closure.has(id))changed=true;closure.add(source);closure.add(id);}
  }}
  for(const id of closure)if(id.startsWith('note:'))selected.add(id.slice(5));
  const omitted=notes.filter(n=>!selected.has(n.id));
  // If an index is larger than the body, keep the body; indexing must earn its cost.
  for(const n of omitted)if(JSON.stringify(recordIndex(n)).length>=JSON.stringify(n).length)selected.add(n.id);
  const index=notes.filter(n=>!selected.has(n.id)).map(recordIndex);
  const unknown=notes.filter(n=>selected.has(n.id)).flatMap(n=>(n.record?.links??[]).filter(id=>!resolver.resolve(id)).map(id=>({record:n.id,id,status:'unknown',read:'notebook {query:{ids:[exact raw ID],archive:true}} or campaigns {}',instruction:'Unresolved or ambiguous dependency; do not assume completed or absent'})));
  return {notebook:notes.filter(n=>selected.has(n.id)),...summaries(selected),...(unknown.length?{unresolvedRecordDependencies:unknown}:{}),...(index.length?{notebookIndex:index,notebookSelection:{mode:'related',omitted:index.length,read:'notebook {query:{ids:[...]}}; notebook {} reads all active records; observe {scope:"full"} expands strategic context',instruction:'摘要不是全文；其他机会仍在目录。新方向、重大投入、背约、矛盾或缺少依据时读取原文/展开，不依据省略猜测。'}}:{})};
}
function recordIndex(n:NotebookEntry){return {id:n.id,kind:n.kind,updatedAt:n.updatedAt,expiresAt:n.expiresAt,...(n.basis!==undefined?{basis:n.basis}:{}),...(n.basisTick!==undefined?{basisTick:n.basisTick}:{}),...(n.manualIntent?{manualIntent:n.manualIntent}:{}),...n.record,detailOmitted:true};}

export interface NotebookQuery {ids?:string[];players?:number[];entities?:string[];statuses?:string[];text?:string;before?:number;limit?:number;archive?:boolean}
export function validateNotebookQuery(raw:unknown):NotebookQuery{
  const q=obj(raw);
  if(Object.keys(q).some(k=>!['ids','players','entities','statuses','text','before','limit','archive'].includes(k))||
    ['ids','entities','statuses'].some(k=>q[k]!==undefined&&!strings(q[k],32,160))||
    q.players!==undefined&&(!Array.isArray(q.players)||q.players.some(p=>!Number.isSafeInteger(p)||p<0))||
    q.text!==undefined&&(typeof q.text!=='string'||q.text.length>200)||
    q.before!==undefined&&(!Number.isSafeInteger(q.before)||Number(q.before)<1)||
    q.limit!==undefined&&(!Number.isSafeInteger(q.limit)||Number(q.limit)<1||Number(q.limit)>32)||
    q.archive!==undefined&&typeof q.archive!=='boolean')throw Error('Invalid notebook query');
  return q as NotebookQuery;
}
export function matchesNote(n:NotebookEntry,q:NotebookQuery){return (!q.ids?.length||q.ids.includes(n.id))&&(!q.players?.length||q.players.some(p=>n.record?.players.includes(p)))&&(!q.entities?.length||q.entities.some(e=>n.record?.entities.includes(e)))&&(!q.statuses?.length||q.statuses.includes(n.record?.status??'unstructured'))&&(!q.text||JSON.stringify(n).includes(q.text));}

export const MEMORY_RECORD_POLICY=`记忆各有职责：strategy只留胜利路径、优先目标与转向条件；行动细节只放plan或现有campaign，协议放agreement，关系用id:"relation:<gamePlayer>"的note。旧记忆核对并完整转存后才删重复片段，不自动改写。
每条一事：状态时点、依据与未知、约束与下一步，必要时写复核节点，不抄整轮战报。fact留情报来源；外交brief留合作上限、禁区和等待事项；relation留合作范围、事件依据与风险；deceptions区分对外说法、真实意图/行动、未验证后果。可选basis:"observed|reported|predicted|inferred|decision"分别指亲见/转述/条件推演/推断/决定，basisTick为依据tick≤当前tick，非预测终点；混合来源在正文分列，旧记录不必补字段。
notebook.set可附record:{type:"relation|agreement|plan",status:"状态",summary:"关键约束/目标与下一步，最多360字符",players:[游戏席位],entities:[据点/舰队/战役ID],links:["note:记录ID / campaign:战役ID"],evidence:["chat:消息ID / tool:回执ID / note:已保存记录ID / observation:revision@tick"],reviewAt:绝对规则秒或null}。关系另带scores:{trust:0到100或null,hostility:0到100或null,threat:0到100或null,cooperation:0到100或null,confidence:0到100}，未知用null，评分不机械决定攻击。
已有notebook条目按补丁更新：省略kind/text/expiresAt/basis/basisTick或record字段保留原值；record可只给变更字段，scores可局部更新。显式空数组/允许的null表示修改，不等于省略。回执inheritedFields列出沿用字段，沿用旧状态或证据不代表重新确认；正文改变约束、状态或依据时须同时更新对应结构字段。新建记录仍需完整信息；关闭/过期/移除的记录恢复活跃须显式record.status，不能靠漏字段重开。
关系状态unknown/neutral/negotiating/cooperating/ceasefire/hostile；协议proposed/active/fulfilled/expired/rejected/revoked/breached；计划candidate/active/blocked/completed/abandoned/superseded。关系players仅一个对手，不含自己，永久且每对手唯一，不占32条普通容量；协议kind为agreement，计划为plan。关闭/移除后ID仍不能改record类型或删结构元数据。
evidence最多${MEMORY_RECORD_LIMITS.evidence}个唯一引用、每个${MEMORY_RECORD_LIMITS.evidenceLength}字符；entities最多${MEMORY_RECORD_LIMITS.entities}项，links最多${MEMORY_RECORD_LIMITS.links}项。保留支持判断的依据而非累计流水账；超限整批拒绝，修正后重交，不截断。同批未保存note不能互证，优先引用原始依据。本人成功say的message.id可作chat证据，无需重读；意图/失败不能作chat证据。tool:可精确引用本人失败回执或batch子回执，evidenceOutcomes区分accepted/rejected/unconfirmed/partial/read；失败只证明该请求被拒绝，未知不等于失败且不得盲重试，batch子项只证明自身。accepted表示该请求被接受，不保证预约已执行、计划完成或对方接受协议；read推演仍有条件。自己说过不证明对方接受或行动完成。
text留事实、条款与依据；summary先写约束与下一步，非战报。协议必须保留双方义务、资产归属、禁区/例外、接受依据与未完成事项，包括不救援等限制。提议不等于联盟，履约/违约/完成/放弃需核验，不能凭年龄或自述判定；背约后果写关系依据，不抹承诺。关闭项仍可查历史，旧记录用typed ID引用。裸ID仅在唯一匹配时兼容；同名记录/战役须写前缀。notebookDependencySummaries仅说明历史生命周期，不是活跃计划或执行成功证据；removed不等于完成，必要时查归档。lastContentUpdatedAt是最后正文的绝对规则秒，不是关闭/删除时刻；查询notebook.query.ids使用原始记录ID（去掉一层note:前缀），战役用campaigns读取。
仅状态、依据或下一步变化时更新同ID；同证据不反复计分，不因寒暄刷新所有关系。reviewAt不唤醒，行动节点另设reminders。
notebook {query:{ids:["ID"],players:[席位],entities:["实体"],statuses:["active"],text:"关键字",archive:true,before:游标,limit:16}}查本人本局；多条件交集、同字段并集。archive:true查旧版本及移除事件，nextCursor可翻页；历史非当前事实。notebook {}读全部活跃正文；无结果须扩大查询，不推断事实不存在。`;
