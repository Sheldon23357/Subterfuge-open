import type {ManualCommandReceipt,ManualCommandView,PlayerObservation,QueuedOrderView} from '../../contracts/src/index.js';
type ManualActionKind=Exclude<ManualCommandReceipt['kind'],'release-protection'>;
const labels:Record<string,string>={launch:'派遣舰队','set-shields':'调整护盾','toggle-mine':'改建矿场','return-fleet':'舰队返航','cancel-launch':'取消派遣','check-in':'报到','cancel-inactivity-warning':'取消不活跃提醒'};
export function manualActionSummary(action:ManualCommandReceipt['action'],names:Record<string,string>):string {
  if(!action)return '取消预约';
  const name=(id:unknown)=>typeof id==='string'?names[id]??'据点':'据点';
  if(action.kind==='launch')return `${name(action.source)} → ${name(action.destination)}`;
  if(typeof action.outpostId==='string')return `${name(action.outpostId)} · ${labels[action.kind]??'据点指令'}`;
  return labels[action.kind]??'手动指令';
}
/** Only a matching committed receipt can replace the ordinary success text. */
export function manualCommandNotice(view:ManualCommandView|undefined,id:string,kind:ManualActionKind,names:Record<string,string>):string|null {
  const receipt=view?.receipts.slice().reverse().find(row=>row.kind===kind&&(row.id===id||row.orderId===id||row.scheduleId===id));
  if(!receipt)return null;
  const action=manualActionSummary(receipt.action,names),result=receipt.outcome==='scheduled'?'已预约':receipt.outcome==='cancelled'?'已取消':'已执行';
  const protectedAction=view!.protections.some(row=>row.receiptId===receipt.id);
  const collateral=receipt.cancelledScheduleIds.filter(id=>receipt.kind!=='cancel-schedule'||id!==receipt.scheduleId);
  return `${action}：${result}。${collateral.length?`同时取消了 ${collateral.length} 条关联预约。`:''}${protectedAction?'手动安排优先，AI 不会直接覆盖。':''}`;
}

/** V1 hashes client order IDs at the player boundary; schedule cancellation already uses that canonical ID.
 * Display enrichment is optional: unavailable WebCrypto must never turn a committed order into a UI failure. */
export async function playerManualCommandNotice(
  observation:PlayerObservation,
  command:{id:string;kind:'order'|'cancel';issueTick?:number},
  cryptoProvider?:Pick<SubtleCrypto,'digest'>|null,
):Promise<string|null> {
  try {
    if(!observation.manualCommands)return null;
    const player=observation.view.player;
    if(!Number.isSafeInteger(player)||player<0||player>9)return null;
    let id=command.id;
    if(command.kind==='order'){
      const subtle=cryptoProvider===undefined?globalThis.crypto?.subtle:cryptoProvider;
      if(!subtle)return null;
      const hash=new Uint8Array(await subtle.digest('SHA-256',new TextEncoder().encode(id)));
      if(hash.length!==32)return null;
      id=`p${player}-`+Array.from(hash,byte=>byte.toString(16).padStart(2,'0')).join('');
    }
    return manualCommandNotice({...observation.manualCommands,receipts:observation.manualCommands.receipts.filter(row=>row.player===player)},id,command.kind==='cancel'?'cancel-schedule':command.issueTick===undefined?'order':'schedule',observation.outpostNames??{});
  }catch{return null;}
}

export function manualCommandError(code:unknown,status:number):string|null {
  if(code==='MANUAL_COMMAND_CONFLICT')return '这条指令与受保护的手动安排冲突，尚未执行。请先查看并调整相关安排。';
  if(code==='manual-replan-required'||code==='MANUAL_INTENT_CHANGED')return '手动安排已更新，请查看最新局势后重新下令。';
  return status===403&&code==='SCOPE_DENIED'?'当前连接没有执行这项操作的权限。':null;
}
export function collateralScheduleIds(value:unknown):string[]|null {
  if(!Array.isArray(value)||!value.length||value.length>1000||value.some(id=>typeof id!=='string'||!id||id.length>256)||new Set(value).size!==value.length)return null;
  return value as string[];
}
export function manualCancellationQuestion(ids:string[],scheduled:QueuedOrderView[],names:Record<string,string>):string {
  const rows=ids.map(id=>{const row=scheduled.find(item=>item.id===id);const action=row?.action;const resources=action?.kind==='launch'?`${typeof action.drillers==='number'?` · ${action.drillers} 舰`:''}`:action?.kind==='set-shields'?` · ${action.enabled===true?'开启':'关闭'}`:'';return row?`${manualActionSummary(row.action,names)}${resources}（第 ${row.issueTick} 天）`:'另一条手动预约（当前未能显示详情）';});
  return `取消这条预约还会同时取消 ${ids.length} 条手动安排：\n${rows.map(text=>'• '+text).join('\n')}\n\n确认一起取消？`;
}
export class ManualCommandConflictError extends Error {
  constructor(readonly cancelledScheduleIds:string[]|null,readonly cancellationToken:string|null,readonly cancelledSchedules:QueuedOrderView[]|null){super(manualCommandError('MANUAL_COMMAND_CONFLICT',409)!);}
}
export function manualRequestIdentity(path:string,input:unknown):{id:string;player:number;kind:ManualActionKind}|null {
  if(!input||typeof input!=='object')return null;
  const data=input as Record<string,unknown>,order=path==='order'||path==='cancel-schedule'?data:data.order;
  if(!order||typeof order!=='object'||!['order','schedule-order','schedule','cancel-schedule'].includes(path))return null;
  const row=order as Record<string,unknown>;
  if(typeof row.id!=='string'||!Number.isSafeInteger(row.player))return null;
  return {id:row.id,player:row.player as number,kind:path==='cancel-schedule'?'cancel-schedule':path==='order'?'order':'schedule'};
}

export function cancellationToken(value:unknown):string|null {return typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)?value:null;}
/** The confirmation must display the same server snapshot that produced its content-bound token. */
export function collateralSchedules(value:unknown,ids:string[]|null):QueuedOrderView[]|null {
  if(!ids||!Array.isArray(value)||value.length!==ids.length)return null;
  const seen=new Set<string>();
  for(const raw of value){
    if(!raw||typeof raw!=='object')return null;
    const row=raw as Record<string,unknown>,action=row.action;
    if(typeof row.id!=='string'||!ids.includes(row.id)||seen.has(row.id)||!Number.isSafeInteger(row.player)||(row.player as number)<0||(row.player as number)>9||!Number.isSafeInteger(row.issueTick)||(row.issueTick as number)<0||!action||typeof action!=='object'||typeof (action as Record<string,unknown>).kind!=='string')return null;
    seen.add(row.id);
  }
  return structuredClone(value) as QueuedOrderView[];
}
