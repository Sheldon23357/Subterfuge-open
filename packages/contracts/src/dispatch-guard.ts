import type {PlayerObservation} from './index.js';

export const DISPATCH_LOCK_MESSAGE='该据点本日已修改过调度；下一世界日才能新增出兵计划（含预约）或调整兵力，仍可撤销。';
/** Reject only sources already locked by the current authoritative observation.
 * Hypothetical successes/failures do not create authority in this preflight. */
export function dispatchDraftsAllowed(observation:Pick<PlayerObservation,'view'|'dispatchGuard'>,drafts:readonly {action:Record<string,unknown>}[]):boolean{
 const guard=observation.dispatchGuard;
 if(!guard||guard.tick!==observation.view.tick)return true;
 return !drafts.some(d=>d.action.kind==='launch'&&typeof d.action.source==='string'&&guard.lockedSources.includes(d.action.source));
}
