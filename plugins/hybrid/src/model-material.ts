import type {SituationBrief} from './contracts.js';
import {isDeepStrictEqual} from 'node:util';
import {presentModelNumbers} from './model-numbers.js';

/** Semantics shared by all three data sections, not extra per-entity metadata. */
export const MODEL_MATERIAL_RULES=`输入的!model-data/1是可读流式记录：中文键与显式列头，宽表小样本用表[{字段:值}]逐项具名；?=null、是=true、否=false；[]、空字符串、0与未知不同，未给字段不补值。输出仍用响应Schema的英文键及合法引用。全局玩家概况常驻，己方重复数值以本方玩家行、建矿费以本方概况为准；未列详情不代表不存在，摘要不算已完整提供，未提供字段仍保持未知。
事实、估算、建议和实际回执分别判断。周期矿收入按time.publicIncomePeriodWorldDays计，静态获胜时间假设收入和领土不变；优先用已算剩余获胜天比较航程，不把收入周期当作获胜倒计时。扣预约后可用兵不等于安全可调兵。attackAssessment只包含本轮相关目标的程序初筛结论，未完成联合战术验证，也不表示已选择或执行；无此字段不代表无法进攻。舰队列表不表示空闲、可调或可重复承诺，列表消失不推断抵达或毁灭。
战术方案按建议排序，均非已执行；动作日默认actionWorldDay，增减相对selected，共有后果及风险仅用于已评估方案；未给缺口即未计算，goals仅为历史方向。任务静态成本不含未来生产、在途兵与敌方命令；已有活跃任务不重复输出；长期pending/blocked、兵力上限低于静态成本或初筛估算、航程超期时比较调投入、换目标、集结、取消，不能仅刷新期限或写成等抵达；关联操作只覆盖当前保留记录，null不证明历史未行动。一个占领目标不是一兵的投入上限，自动履约目标不等于额外任务或实际出发。
任务authority=model表示模型发布，authority=commander才是指挥官发布；executionRules是合并后的执行限制，不能据此把模型守备任务说成指挥官要求。战略轮可编辑其权限内的模型任务，不能改指挥官任务。外交轮只编辑当前合同给定任务/目标，独立战略、指挥官及其他合同任务只读，不复制为履约任务；无可编辑合同则tasks/cancel为空，唯一已签合同可省关联，多份必须准确选择。
合同current中proposed待签、active才是义务；history/otherHistory已终止，不复活。仅当前会话共享合同可作为双方已知事实，其他会话用于内部预算不自动披露。仅实际占领合同敌人据点才履约，本方达标不再增攻。对手合同数仅可见下界，实际剩余未知，零不代表无占用；签署由服务器复核。双方各自占领共同敌人任意一个据点；不折算兵损，不增加接触或签约频率门槛，初筛和来源安全检查不保证实际占领。
运输须确认执行窗口内的真实友方交付，离港或接受不是交付；两端已授权且144世界日内未达表示超窗口，不是等补资料。目标归属/兵力/来袭、来源可调量、合同/任务约束改变，或执行失败、真实结算偏离条件预测时复查。
回执仅覆盖授权窗口中本职责/会话尚未成功交付部分，窗口外缺口不还原历史，空列表不等于全历史无事。历史只覆盖授权合同列表。未提供字段保持未知，不通过追加查询调用补齐资料。会话双方以fixedConversation.identities为准，本方由basis.player与身份表确定，末条发言从消息原文按发送者读取；newIncomingIds才表示未处理来信。没有新来信仍可完整思考，也可不发消息。`;

// Exact producer-owned descriptions, represented once by MODEL_MATERIAL_RULES.
// Unknown/new explanations remain in the input; this is never blanket text pruning.
const sharedDescriptions=new Set([
  "intel.npPerDay是144世界日的静态收入；下列ETA假设收入与领土持续不变，不保证实际胜利",
  "available只扣已接受预约，不等于安全可调兵量；null为未知。支付兵力可集结但航程、防守与持续持有由战术程序验证",
  "其他授权舰队为数量与已知兵力汇总，不表示空闲、可调或可重复承诺；未从列表变化推断抵达/毁灭",
  "候选、可调兵量、投入与航程是程序估算和建议，尚未完成联合推演；未知不补零，无候选不等于无法进攻。AI选择少量目标，程序继续验证来源安全、资源与交付。",
  "兵力估算引用estimates.forceSources同名来源的availableEstimate；每条路线另列航程",
  "条件方案按建议排序，未表示已执行。动作按actionColumns读列，null为不适用，执行日默认actionWorldDay；差异相对selected。evaluatedDefaults/sharedRisks只用于已评估方案。缺口未给出即未计算，goals仅历史方向；条件结果非保证。",
  "current中proposed是待签条款，active才是当前义务；history与otherHistory均已终止，不可复活或计入当前义务；历史结果仅覆盖当前授权合同列表",
  "对手仅列授权可见下界；实际完整占用与剩余名额未知，零不代表无占用；签署由服务器复核",
  "双方各自占领共同敌人任意一个据点。这里只整理当前责任和名额，不将兵力折算为额度，不增加提案或签约频率门槛；来源安全、进攻期限和指挥官要求仍须评估。",
  "仅列未在本职责/会话成功发布时交付的可用回执；窗口外单事件未展开，不保证完整历史。当前信任、义务与历史结果另由当前授权状态提供，不能把空清单当作全历史无事件",
  "taskTargets只提供现有任务的目标状态，不含位置与生产明细；未展开据点仍在全局目录与候选中，不代表已提供完整资料",
  "只编辑所列当前会话合同的任务及目标；多份合同时显式选择精确fulfillAgreementId，无合同时tasks与cancel必须为空",
  "独立战略、指挥官及其他会话或合同任务仅作当前背景，不提供可编辑任务身份；不得在本外交轮修改、取消或复制为履约任务",
  "归属、签署和进度是程序事实；己方任务不表示已执行。只有当前会话双方共享的合同可作为双方已知合同；其他会话用于内部预算，不自动对外披露。没有新来信不等于禁止思考，也不要求再次发言。",
  "静态最低突破兵力只按当前驻军+护盾+1计算，不含航行期间生产、在途兵和未来命令；不是已完成战斗模拟。上限不足、任务pending/blocked或没有新出发时，不能写成已在推进或等抵达；比较提高可承担上限、换同敌目标、集结与止损，不将一个占领目标误作一兵投入上限。先核对目标属于合同敌人；本方已达标不再为该合同新增进攻。",
  "程序已绑定唯一合同，fulfillAgreementId可省略；只编辑该合同列出的任务及目标",
  "仅实际占领该enemy的据点才履约；其他敌人的占领不能补缺口。自动履约目标独立存在，extra任务有无不等于自动目标或真实行动有无。"
]);

type Row=Record<string,any>;
export interface ModelMaterialExclusion {path:string;reason:'outside-role'|'empty-role-placeholder'|'program-audit'}
const rows=(t:any):Row[]=>Array.isArray(t)?t:t?.columns&&t.rows?t.rows.map((r:any[])=>Object.fromEntries(t.columns.map((k:string,i:number)=>[k,r[i]]))):[];
const tasks=(t:any):Row[]=>t?.byKind?Object.values(t.byKind).flatMap(rows):rows(t);
const hashId=/^p(\d+)-([a-f0-9]{64})$/i;
// These event subjects are actual fleet identities at event time, even after
// arrival/removal takes the unit out of the current authorized fleet list.
const fleetActivityKinds=new Set(['launch-ordered','launch-cancelled','departed','fleet-arrived','fleet-recalled','battle','fleet-recovered','fleet-removed','fleet-transferred']);
const proseKeys=new Set(['text','summary','internalIntent','reason','reasons','reviewOn','meaning','interpretation','limitations','limits','unknowns']);
const executionDescriptions=new Set([
 '仅当前保留的关联操作；null不推断完整历史无行动，出发不表示交付或占领',
 '静态成本不含未来生产、在途兵与敌方命令；初筛是估算。低上限、超期或长期无对应行动时比较调整投入、改目标、集结或取消，不能仅续期。',
 '来源安全可调和航程是程序初筛；接收点有来袭仍可生成增援候选，联合预测必须确认实际友方交付，不能以离港算成功。',
]);
const standardReview=['关联目标归属、兵力或来袭变化','来源可调量或合同/任务约束变化','真实执行失败或结算与条件预测不一致'];

/** Remove capabilities the current role cannot use, not the obligations or
 * estimates needed to choose strategy. The caller retains the complete guard. */
function projectRoleFields(brief:SituationBrief):ModelMaterialExclusion[]{
 if(brief.kind!=='strategy'&&brief.kind!=='diplomacy')return [];
 const g=brief.global as Row,h=brief.guidance as Row,excluded:ModelMaterialExclusion[]=[];
 const omit=(owner:Row|undefined,key:string,path:string,reason:ModelMaterialExclusion['reason'])=>{
  if(owner&&Object.hasOwn(owner,key)){delete owner[key];excluded.push({path,reason});}
 };
 const column=(value:any,key:string,path:string,reason:ModelMaterialExclusion['reason'],onlyNull=false)=>{
  if(Array.isArray(value)){
   if(onlyNull&&value.some(r=>Object.hasOwn(r,key)&&r[key]!==null))return;
   if(value.some(r=>Object.hasOwn(r,key))){for(const r of value)delete r[key];excluded.push({path:path+'.'+key,reason});}
  }else if(Array.isArray(value?.columns)&&Array.isArray(value.rows)){
   const index=value.columns.indexOf(key);if(index<0)return;
   // A missing value is not null. Unknown or newly meaningful assessments stay.
   if(onlyNull&&value.rows.some((r:any[])=>r[index]!==null))return;
   value.columns.splice(index,1);for(const r of value.rows)r.splice(index,1);
   excluded.push({path:path+'.'+key,reason});
  }
 };
 omit(h.receiptCoverage,'previousPublicationSourceCount','guidance.receiptCoverage.previousPublicationSourceCount','program-audit');
 for(const kind of ['ceasefire','jointAttack']){
  const value=h.serverAgreements?.current?.[kind],path='guidance.serverAgreements.current.'+kind;
  if(brief.kind==='strategy')for(const key of ['ownProposalRole','allowedActions','inConversation','edits'])column(value,key,path,'outside-role');
  for(const key of ['edits','feasibility','taskFeasibility'])column(value,key,path,'empty-role-placeholder',true);
 }
 // Chat and game identities are not interchangeable. Keep the mapping whenever
 // this strategic call actually carries messages or conversation identities.
 if(brief.kind==='strategy'&&!(brief.evidence as Row).messages?.length&&!h.communicationFacts&&
  !(h.fixedConversation?.identities?.length)&&!(h.fixedConversation?.chatPlayers?.length)){
  column(g.roster,'chatPlayer','global.roster','outside-role');
 }
 return excluded;
}

/** Frozen request-local namespace, also used for the response Schema. No ordinal
 * IDs: references survive subsequent rounds. Ambiguity retains the exact ID. */
function referenceMap(brief:SituationBrief,schema:unknown):Record<string,string>{
 const identities=new Map<string,Set<string>>(),protectedIds=new Set<string>(),literalIds=new Set<string>();
 const fleetIdentity=(value:unknown)=>{
  if(typeof value!=='string')return;
  if(!hashId.test(value)){literalIds.add(value.toUpperCase());return;}
  const kinds=identities.get(value)??new Set<string>();kinds.add('F');identities.set(value,kinds);
 };
 for(const event of rows((brief.changes as Row|undefined)?.activity)){
  if(fleetActivityKinds.has(event.kind))fleetIdentity(event.subject);
  if(event.destination?.kind==='fleet')fleetIdentity(event.destination.id);
 }
 const mark=(v:unknown,path:string,key='')=>{
  if(typeof v==='string'){
   for(const m of v.matchAll(/\bp\d+-[a-f0-9]{64}\b/gi)){
    const id=m[0];if(v!==id||proseKeys.has(key)||path.startsWith('evidence'))protectedIds.add(id);
    const kinds=identities.get(id)??new Set<string>();
    if(/serverAgreements|agreementId|AgreementId|counterTo|betrayAgreements/.test(path))kinds.add('A');
    else if(/fleet|Fleet|hostileApproaches/.test(path))kinds.add('F');
    identities.set(id,kinds);
   }
   if(['id','name'].includes(key)&&!hashId.test(v))literalIds.add(v.toUpperCase());
   return;
  }
  if(Array.isArray(v)){for(const x of v)mark(x,path,key);return;}
  if(v&&typeof v==='object'){
   const record=v as Row;
   if(record.kind==='fleet')fleetIdentity(record.id);
   for(const [k,x]of Object.entries(record)){
    if(k==='rows'&&Array.isArray(record.columns)&&Array.isArray(x))for(const row of x)for(let i=0;i<record.columns.length;i++)mark(row[i],path+'.'+record.columns[i],record.columns[i]);
    else mark(x,path+'.'+k,k);
   }
  }
 };
 for(const [key,value]of Object.entries(brief))mark(value,key,key);mark(schema,'schema');
 const candidates=new Map<string,string>(),groups=new Map<string,string[]>();
 for(const [id,kinds]of identities){if(protectedIds.has(id)||kinds.size!==1)continue;const m=hashId.exec(id)!;const alias=[...kinds][0]+String(Number(m[1])+1)+'-'+m[2]!.slice(0,8).toUpperCase();if(literalIds.has(alias))continue;candidates.set(id,alias);groups.set(alias,[...(groups.get(alias)??[]),id]);}
 return Object.fromEntries([...candidates].filter(([,alias])=>groups.get(alias)!.length===1).map(([id,alias])=>[alias,id]));
}

/** Reference projection is also used by commander translation, without applying
 * strategic deduplication or role filtering to its confirmed instructions. */
export function prepareModelReferences<T>(brief:SituationBrief,schema:T){
 const references=referenceMap(brief,schema),toShort=new Map(Object.entries(references).map(([short,full])=>[full,short]));
 return {brief:projectReferences(brief,toShort,true),responseSchema:projectReferences(schema,toShort),references};
}

/** Only exact reference-valued strings are mapped. Original prose is untouched. */
function projectReferences<T>(input:T,mapping:ReadonlyMap<string,string>,protectedRoot=false):T{
 const visit=(v:any,key=''):any=>{
  if(typeof v==='string')return proseKeys.has(key)?v:mapping.get(v)??v;
  if(Array.isArray(v))return v.map(x=>visit(x,key));
  if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,k==='evidence'&&protectedRoot?structuredClone(x):visit(x,k)]));
  return v;
 };
 return visit(input);
}

/** Strategic facts, candidates, receipts and numerical estimates survive;
 * irrelevant role capabilities and program audit counters remain in the guard. */
export function prepareModelMaterial<T>(input:SituationBrief,schema:T){
 const brief=structuredClone(input),g=brief.global as Row,h=brief.guidance as Row,f=brief.facts as Row;
 const excluded=projectRoleFields(brief);
 const deduplicated:string[]=[];
 const same=(owner:Row|undefined,key:string,value:unknown,path:string)=>{if(owner&&Object.hasOwn(owner,key)&&value!==undefined&&isDeepStrictEqual(owner[key],value)){delete owner[key];deduplicated.push(path);}};
 const self=rows(g.players).find(p=>p.player===brief.basis.player);
 for(const [key,col]of [['active','active'],['drillers','drillers'],['neptunium','neptunium'],['outpostCount','numOutposts']])same(g.self,key!,self?.[col!],'global.self.'+key);
 same(g,'ownOutposts',self?.numOutposts,'global.ownOutposts');
 for(const [key,col]of [['balance','neptunium'],['oneLossCost','currentLossIfMineCaptured'],['staticVictoryWorldDays','staticVictoryWorldDays']])same(g.mining,key!,self?.[col!],'global.mining.'+key);
 same(g.economy?.mineCreation,'amount',g.self?.mineCreationCost,'global.economy.mineCreation.amount');
 same(g.relations,'observedAt',g.time?.worldDay,'global.relations.observedAt');
 same(h.relationAdvice,'observedForce',self?.drillers,'guidance.relationAdvice.observedForce');
 same(h.fixedConversation,'scope',brief.scope,'guidance.fixedConversation.scope');
 same(f.coverage,'scope',brief.scope,'facts.coverage.scope');
 same(f.coverage,'total',g.identities?.rows?.length,'facts.coverage.total');
 same(h.intentCoverage,'active',tasks(h.intentTasks).length+tasks(h.readOnlyIntentTasks).length,'guidance.intentCoverage.active');
 same(h.intentCoverage,'terminalListed',rows(h.recentResults).length,'guidance.intentCoverage.terminalListed');
 if(h.contractResults!==undefined)same(h.receiptCoverage,'new',rows(h.contractResults).length,'guidance.receiptCoverage.new');
 if(brief.kind==='diplomacy'&&h.communicationFacts){
  const c=h.communicationFacts,selfChat=rows(g.roster).find(p=>p.gamePlayer===brief.basis.player)?.chatPlayer;
  same(c,'self',brief.basis.player,'guidance.communicationFacts.self');
  same(c,'selfChat',selfChat,'guidance.communicationFacts.selfChat');
  if(h.fixedConversation?.identities)same(c,'peers',h.fixedConversation.identities.map((p:Row)=>p.gamePlayer),'guidance.communicationFacts.peers');
  const messages=(brief.evidence as Row).messages??[];
  if(selfChat!==undefined){same(c,'lastOwnMessageId',messages.filter((m:Row)=>m.from===selfChat).at(-1)?.id??null,'guidance.communicationFacts.lastOwnMessageId');same(c,'lastPeerMessageId',messages.filter((m:Row)=>m.from!==selfChat).at(-1)?.id??null,'guidance.communicationFacts.lastPeerMessageId');}
 }
 const feedback=g.feedback;
 if(feedback?.conditionalAlternatives&&feedback.selected?.actions)feedback.conditionalAlternatives=feedback.conditionalAlternatives.filter((p:Row)=>{
  const delta=p.differenceFromSelected;if(!delta||!Array.isArray(delta.add)||!Array.isArray(delta.remove)||Object.keys(delta).sort().join(',')!=='add,remove'||delta.add.length||delta.remove.length)return true;
  const reconstructed:Row={...p,actions:feedback.selected.actions};delete reconstructed.differenceFromSelected;
  if(!isDeepStrictEqual(reconstructed,feedback.selected))return true;
  deduplicated.push('global.feedback.conditionalAlternatives:selected-copy');return false;
 });
 const consolidate=(v:any,scope=''):any=>{
  if(Array.isArray(v))return v.map(x=>consolidate(x,scope));
  if(!v||typeof v!=='object')return v;
  return Object.fromEntries(Object.entries(v).filter(([key,x])=>{
   if(['meaning','interpretation','detailCoverage','fulfillmentInterpretation','launchSourceMeaning'].includes(key)&&typeof x==='string'&&sharedDescriptions.has(x)){deduplicated.push('shared-semantics:'+key);return false;}return true;
  }).filter(([key,x])=>{
   if(scope==='executionFeasibilityMeaning'&&typeof x==='string'&&executionDescriptions.has(x)||scope==='feedback'&&key==='reviewWhen'&&isDeepStrictEqual(x,standardReview)){deduplicated.push('shared-semantics:'+scope+'.'+key);return false;}return true;
  }).map(([k,x])=>[k,consolidate(x,k)]));
 };
 for(const k of ['global','guidance','facts'] as const)brief[k]=consolidate(brief[k]);
 const projected=prepareModelReferences(brief,schema),numbers=presentModelNumbers(projected.brief);
 return {...projected,brief:numbers.value,deduplicated,excluded,numericPresentation:numbers.changes};
}

/** Expansion cannot add permission: later canonical identity, ownership,
 * freshness and source/contract checks still run against captured/current facts. */
export function expandModelReferences(value:unknown,references:Readonly<Record<string,string>>):unknown{
 const fields=new Set(['fleetId','agreementId','fulfillAgreementId','counterTo','betrayAgreements']);
 const visit=(v:any,key=''):any=>{
  if(typeof v==='string')return fields.has(key)&&Object.hasOwn(references,v)?references[v]:v;
  if(Array.isArray(v))return v.map(x=>visit(x,key));
  if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,visit(x,k)]));return v;
 };
 return visit(value);
}
