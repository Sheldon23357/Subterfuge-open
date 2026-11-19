import {protocolInteger,protocolObject,protocolString,type ManualCommandView} from '../../contracts/src/protocol-index.js';
// Keep runtime validation exhaustive when the shared protection contract grows.
const protectionKinds:Record<ManualCommandView['protections'][number]['kind'],true>={fleet:true,schedule:true,route:true,outpost:true,resources:true,funding:true};
/** Parse server-authored command facts without inferring strategy or granting human authority. */
export function parseManualCommandView(value:unknown,expectedPlayer?:number):ManualCommandView {
  const view=protocolObject(value),version=protocolInteger(view.version,0,Number.MAX_SAFE_INTEGER);
  const from=protocolInteger(view.receiptsFromVersion,0,Number.MAX_SAFE_INTEGER);
  if(from>version+1||typeof view.hasEarlierReceipts!=='boolean'||!Array.isArray(view.receipts)||!Array.isArray(view.protections))throw Error('Invalid manual command view');
  let last=-1;const ids=new Set<string>();
  const strings=(raw:unknown)=>{if(!Array.isArray(raw)||raw.some(v=>typeof v!=='string'||!v||v.length>1024))throw Error('Invalid manual command targets');};
  for(const raw of view.receipts){
    const row=protocolObject(raw);protocolString(row.id,1024);if(ids.has(row.id as string))throw Error('Duplicate manual command receipt');ids.add(row.id as string);
    const current=protocolInteger(row.version,1,version);if(current<=last||current<from)throw Error('Invalid manual command receipt sequence');last=current;
    const player=protocolInteger(row.player,0,9);if(expectedPlayer!==undefined&&player!==expectedPlayer)throw Error('Manual command identity mismatch');
    protocolInteger(row.tick,0,Number.MAX_SAFE_INTEGER);if(typeof row.seconds!=='number'||!Number.isFinite(row.seconds)||row.seconds<0)throw Error('Invalid manual command time');
    if(!['order','schedule','cancel-schedule','release-protection'].includes(String(row.kind))||row.outcome!==({order:'applied',schedule:'scheduled','cancel-schedule':'cancelled','release-protection':'released'} as Record<string,string>)[String(row.kind)])throw Error('Invalid manual command outcome');
    for(const key of ['orderId','scheduleId'])if(row[key]!==undefined)protocolString(row[key],1024);
    if(row.action!==undefined)protocolString(protocolObject(row.action).kind,128);
    strings(row.affectedFleetIds);strings(row.cancelledScheduleIds);
    // Read-only compatibility with archived receipts; there is no release operation.
    if(row.kind==='release-protection'){
      protocolString(row.operationId,200);strings(row.releasedReceiptIds);strings(row.releasedScopes);
      if(!(row.releasedReceiptIds as string[]).length||(row.releasedReceiptIds as string[]).length>100||new Set(row.releasedReceiptIds as string[]).size!==(row.releasedReceiptIds as string[]).length||!(row.releasedScopes as string[]).length||new Set(row.releasedScopes as string[]).size!==(row.releasedScopes as string[]).length||row.action!==undefined||row.orderId!==undefined||row.scheduleId!==undefined||(row.affectedFleetIds as string[]).length||(row.cancelledScheduleIds as string[]).length)throw Error('Invalid manual release fact');
    }else if(row.operationId!==undefined||row.releasedReceiptIds!==undefined||row.releasedScopes!==undefined)throw Error('Unexpected manual release fact');
  }
  for(const raw of view.protections){const row=protocolObject(raw);protocolString(row.receiptId,1024);if(!Object.hasOwn(protectionKinds,String(row.kind)))throw Error('Invalid manual command protection');strings(row.scope);if(!(row.scope as string[]).length)throw Error('Empty manual command protection');if(row.expiresAtTick!==undefined)protocolInteger(row.expiresAtTick,0,Number.MAX_SAFE_INTEGER);}
  return structuredClone(view) as unknown as ManualCommandView;
}
export interface ManualCommandReceiptPage {version:number;receipts:ManualCommandView['receipts'];nextCursor:number;hasMore:boolean}
export function parseManualCommandReceiptPage(value:unknown,expectedPlayer?:number):ManualCommandReceiptPage {
  const page=protocolObject(value),version=protocolInteger(page.version,0,Number.MAX_SAFE_INTEGER),nextCursor=protocolInteger(page.nextCursor,0,version);
  if(typeof page.hasMore!=='boolean'||!Array.isArray(page.receipts)||page.hasMore&&!page.receipts.length)throw Error('Invalid manual command receipt page');
  const from=page.receipts.length?protocolObject(page.receipts[0]).version:0;
  const parsed=parseManualCommandView({version,receipts:page.receipts,protections:[],receiptsFromVersion:from,hasEarlierReceipts:false},expectedPlayer);
  if(parsed.receipts.some(row=>row.version>nextCursor))throw Error('Invalid manual command receipt cursor');
  return {version,receipts:parsed.receipts,nextCursor,hasMore:page.hasMore};
}
