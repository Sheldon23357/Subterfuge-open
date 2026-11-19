import {scheduledCommitments} from '../analysis/scheduled-commitments.js';
import {pendingManualReceipts} from '../execution/manual-coordination.js';
import type {AiSnapshot,NotebookEntry} from '../contracts/types.js';
import {gameSeconds} from '../contracts/types.js';
import {outpostNameIndex,presentOutpostNames} from './outpost-references.js';
import {projectModelData,projectActivityEvents,mapSpatialRelations} from './model-data-projection.js';
import {encodeModelResultRows} from './model-table.js';
import {estimateKnownArrivals} from '../../../../prediction/src/index.js';
import {isActiveNote} from '../storage/memory-records.js';
import {arrivalEstimates} from '../observation/arrival-coalescing.js';
import {labelScheduleReferences} from './fleet-labels.js';
import {investmentContext,INVESTMENT_STRATEGY_GUIDE} from './investment-context.js';
import {mineHoldingAssessment,MINE_STRATEGY_GUIDE} from '../analysis/mine-strategy.js';
import {miningPhaseContext,miningPhaseFacts} from '../analysis/mining-phase.js';
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export const ROUND_TERMINOLOGY='据点使用完整名称作为唯一思考和工具索引，程序解析内部ID；舰队、预约保留各自稳定代号。矿指据点类型mine，矿量指neptunium胜利资源，兵力指drillers；舰队不是兵力单位。世界日为统一显示时间；1世界天=1tick=600内部规则秒。eventWorldDay是程序计算的事件世界日，null表示时钟未知；tick、seconds仅原始规则时钟锚点，通知与活动的tick基准不同，不自行重复换算。column-groups/1的fields共用列名，rows首项为原数组索引，其余依列对应，按索引还原。?为字段未提供，null为明确未知／空，0及false保留真实含义。TSV单元格的换行、制表符和反斜线分别转义为\\n、\\t、\\\\。';
const cell=(v:unknown)=>v===undefined?'?':(typeof v==='string'?v:JSON.stringify(v)).replaceAll('\\','\\\\').replaceAll('\t','\\t').replaceAll('\r','\\r').replaceAll('\n','\\n');
export function table(title:string,fields:string[],rows:unknown[][]){return `[${title}]\n${fields.join('\t')}\n${rows.map(row=>row.map(cell).join('\t')).join('\n')}`;}
const arrivalCache=new Map<string,ReturnType<typeof estimateKnownArrivals>>();
function arrivals(snapshot:AiSnapshot){
 const o=snapshot.observation,key=JSON.stringify([o.roomId,o.view.player,o.revision,o.view.tick,o.secondsSinceLastTick]);
 let result=arrivalCache.get(key);
 if(!result){result=estimateKnownArrivals(o);arrivalCache.set(key,result);if(arrivalCache.size>12)arrivalCache.delete(arrivalCache.keys().next().value!);}
 return result;
}
/** Reuse the default map's calculation; never an extra query/model step. */
export function roundArrivalEstimates(snapshot:AiSnapshot){return arrivalEstimates(snapshot.observation,arrivals(snapshot));}

/** Shared authorized facts for automatic decisions and commander discussion.
 * Callers supply the same presentation renderer for fleet references. */
export function roundMapBlocks(snapshot:AiSnapshot,render:(text:string)=>string=(text)=>text){
 const o=snapshot.observation,v=o.view,now=gameSeconds(snapshot)/600;
 const index=outpostNameIndex(o),name=(id:string|null|undefined)=>id==null?id:index.byId.get(id)??id;
 const display=(value:unknown)=>labelScheduleReferences(presentOutpostNames(projectModelData(value,{currentRevision:o.revision,currentWorldDay:now}),o.outpostNames??{}),snapshot);
 const json=(value:unknown)=>render(JSON.stringify(encodeModelResultRows(display(value)))??'null');
 const eta=arrivals(snapshot),times=new Map(eta.status==='conditional'?eta.arrivals.map(row=>[row.id,row]):[]);
 const spatial=mapSpatialRelations(v as unknown as Record<string,unknown>);
 const anchors=new Map((Array.isArray(spatial?.fleetPositions)?spatial.fleetPositions:[]).filter(record).map(row=>[String(row.fleetId),row]));
 const blocks:{text:string;detail:string}[]=[];
 const add=(text:string,detail:string)=>blocks.push({text:render(text),detail});
 add(table('据点',['名称','归属','类型','可见性','兵力','护盾','护盾上限','护盾开启','已毁','转矿待执行','生产','建矿等待天','关盾待执行','关盾等待天'],v.outposts.map(p=>[name(p.id),p.owner,p.type,p.visibility,p.drillers,p.shield,p.shieldMax,p.shieldsEnabled,p.destroyed,p.minePending,p.metrics?{active:p.metrics.active,paused:p.metrics.paused,output:p.metrics.output,cycleWorldDays:p.metrics.cycleMinutes===null?null:p.metrics.cycleMinutes/10,nextWorldDays:p.metrics.nextMinutes===null?null:p.metrics.nextMinutes/10,contribution:p.metrics.contribution}:undefined,p.mineRemainingSeconds===undefined?undefined:p.mineRemainingSeconds/600,p.shieldDisablePending,p.shieldDisableRemainingSeconds===undefined?undefined:p.shieldDisableRemainingSeconds/600])),'outposts');
 add(table('舰队',['舰队','归属','兵力','状态','来源据点','目的地类型','目的地','出航等待天','预计抵达日','可撤销出航','出航已确认','当前邻近据点','邻近距离','距目的地距离','可返航','已返航'],v.fleets.map(f=>{
  const time=times.get(f.id);
  const anchor=anchors.get(f.id),nearest=Array.isArray(anchor?.nearestOutpost)?anchor.nearestOutpost.find(record):undefined;
  return [f.id,f.owner,f.drillers,f.state,name(f.source),f.destination?.kind,f.destination?.kind==='outpost'?name(f.destination.id):f.destination?.id,f.launchRemainingSeconds===undefined?undefined:f.launchRemainingSeconds/600,time?.arrivalMinutes==null?null:now+time.arrivalMinutes/10,f.canCancelLaunch,f.departureCommitted,name(nearest?.target as string|undefined),nearest?.distance,anchor?.distanceToDestination,f.canReturn,f.returned];
 })),'fleets');
 add(`[抵达估计状态]\n${json({status:eta.status,...eta.status==='unsupported'?{reasons:eta.reasons}:{}})}`,'fleets');
 add('[资源与胜利]\n'+json({self:v.self,match:v.match,intel:o.intel}),'economyAndVictory');
 const phase=miningPhaseContext(o,snapshot.miningPhase?.history);
 if(phase)add('[游戏阶段与当前进度]\n'+json(miningPhaseFacts(phase)),'gamePhase');
 const holding=mineHoldingAssessment(o);
 if(holding)add('[矿点持有]\n'+json(holding)+'\n'+MINE_STRATEGY_GUIDE,'economyAndVictory');
 const investment=investmentContext(o);
 if(investment)add('[开矿资金线索]\n'+json(investment)+'\n'+INVESTMENT_STRATEGY_GUIDE,'economyAndVictory');
 const nearest=Array.isArray(spatial?.nearest)?spatial.nearest:[];
 const own=new Set(v.outposts.filter(p=>p.owner===v.player).map(p=>p.id));
 const links=nearest.filter(record).filter(row=>own.has(String(row.source))).flatMap(row=>Array.isArray(row.neighbors)?row.neighbors.filter(record).map(n=>[name(String(row.source)),name(String(n.target)),n.distance]):[]);
 add(table('己方据点邻近关联',['据点','邻近据点','环绕地图距离'],links)+'\n每个己方据点列最近3个已知据点，每支舰队列最近1个。距离四舍五入至0.001地图单位，不是航程或安全证明；未列出不等于不可达。','spatialRelations');
 add('[关键变化changes]\n'+json(snapshot.changes??{baselineAvailable:false,changes:[]}),'changes');
 add('[实际结算]\n'+json(projectActivityEvents(o.activity??[])),'settlements');
 add('[预约与玩家操作]\n'+json({scheduled:o.scheduled,resourceCommitments:scheduledCommitments(o),commitmentMeaning:"预约占用是未来承诺，未物理扣兵；unknownSchedules成本需在执行时状态下推演，不按零处理。已执行预约不重复扣除当前地图兵力。",manualCommands:o.manualCommands,...o.manualCommands?{manualReview:{version:o.manualCommands.version,pendingReceiptIds:pendingManualReceipts(snapshot).map(r=>r.id),historyComplete:!o.manualCommands.hasEarlierReceipts}}:{},executionLedger:snapshot.executionLedger}),'executionEvidence');
 return blocks;
}

export function activeNotesTable(notes:NotebookEntry[],nowSeconds:number){
 return table('有效笔记',['ID','类型','状态','正文更新时间','等级','正文'],notes.filter(n=>isActiveNote(n,nowSeconds)).map(n=>[n.id,n.kind,n.record?.status??'active',n.updatedAt/600,n.priority??'medium',n.text]));
}
