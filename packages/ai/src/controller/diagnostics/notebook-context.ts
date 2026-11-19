import type {CommanderThread,PlayerObservation} from '../../../../contracts/src/index.js';
import type {ReceiptEvidenceReader} from '../storage/store-interfaces.js';
import type {ReceiptObservationState} from '../execution/receipt-observation.js';
import {pendingExecutionEvidence} from '../execution/execution-evidence.js';
import type {MiningPhaseHistory} from '../analysis/mining-phase.js';

/** Read existing seat-scoped material only. Never query the server or acknowledge evidence. */
export function notebookContextMemory(store:Pick<ReceiptEvidenceReader,'latest'|'pendingWriteEvidence'|'pendingManualFacts'>,room:string,seat:number,observation:PlayerObservation|undefined,cached:Record<string,unknown>|null,localPlan:unknown=null){
 const thread=cached?.commander as CommanderThread|undefined;
 const commander=thread&&thread.roomId===room&&thread.player===observation?.view.player?structuredClone(thread):null;
 const receipts=store.latest<ReceiptObservationState>(room,seat,'receipt-observation-state');
 const valid=receipts?.roomId===room?receipts:undefined;
 const mining=store.latest<MiningPhaseHistory>(room,seat,'mining-phase-observed');
 return {observedTick:observation?.view.tick??null,commander,localPlan,
  mining:mining?.roomId===room&&mining.player===observation?.view.player&&mining.observedTick<=observation.view.tick?mining:null,
  manual:observation?.manualCommands??null,pendingManual:store.pendingManualFacts(room,seat),
  execution:valid?{pending:store.pendingWriteEvidence(room,seat,valid.pendingWrites),observations:valid.records.filter(r=>r.player===observation?.view.player&&r.state!=='confirmedFact'),notices:pendingExecutionEvidence(valid).notices}:null};
}
