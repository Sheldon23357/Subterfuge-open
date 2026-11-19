import type { PlayerObservation, PlayerForecastResponse, QueuedOrderView } from '../../contracts/src/index.js';
export {attackRoutes} from './attack-routes.js';
export {basicRouteTicks,previewKnownRoute} from './route-timing.js';
import { dispatchDraftsAllowed, DISPATCH_LOCK_MESSAGE, publicPlayerError, observationRuleSeconds } from '../../contracts/src/index.js';
import {
  createFleetScenario, advanceOwnedFleetScenario, submitFleetOrder, parseFleetOrder, fleetForecastStopped,
  projectPlayerView, projectForecastResult, inheritFleetJournals,
  factoryPeriodTicks, minePeriodTicks, applyOriginalFutureQueue,
  type FleetScenario, type FleetOrder, type Fleet,
} from '../../engine/src/index.js';
import { unknownFleetArrival, type FleetArrivalEstimate } from './fleet-arrival.js';
export { labFleetArrivalSteps, type FleetArrivalEstimate } from './fleet-arrival.js';
import { projectKnownPathEvidence, validateKnownPathPredicates, type KnownPathEvidence, type KnownPathPredicate } from './path-evidence.js';
export { validateKnownPathPredicates } from './path-evidence.js';
export type { KnownPathEvidence, KnownPathPredicate, KnownPathEvent, KnownPathPredicateResult, KnownPredicateTruth } from './path-evidence.js';
import { RULES } from '../../rules/src/index.js';
import {validateEnemyHypotheses,type KnownEnemyLaunch} from './enemy-hypotheses.js';
import {knownForceRouteEstimator} from './force-routes.js';
export type {KnownEnemyLaunch} from './enemy-hypotheses.js';
export { replayLabHistory, createLabHistory, type LabHistoryInput, type LabHistoryFrame } from './lab-history.js';

type Plan = FleetOrder & { issueTick: number; status: QueuedOrderView['status']|'skipped-terminal'; reason?: string; failed?: boolean; slot: number; fleetId?: string;knownSourceLost?:boolean };
export interface KnownResourceFrame {
 tick:number;draftIds:string[];
 /** Uncertainty captured at this queue boundary, before later path events. */
 coverage?:'queue-time/1';
 pathUnknownReasons?:string[];

 sources:{source:string;owner:number|null;drillers:number|null}[];
 pendingSchedules:{id:string;issueTick:number;action:unknown}[];
 unknownReasons:string[];
}
interface Branch { state: FleetScenario; plans: Plan[];resourceFrames?:KnownResourceFrame[] }
const unavailableReason=(branch:Branch)=>branch.plans.some(p=>p.reason==='Unknown forecast activity')?'scheduled-activity-unknown':null;
export type KnownForecastResponse = PlayerForecastResponse & { path?: KnownPathEvidence;resourceFrames?:KnownResourceFrame[];hypotheticalEnemyOrderIds?:string[];hypotheticalEnemySourceLossIds?:string[] };
export interface KnownPredictionDraft { id: string; issueTick: number; action: Record<string, unknown> }
export interface KnownDepartureEvidence {
  roomId:string;player:number;basisRevision:string;observedTick:number;targetTick:number;
  departures:{fleetId:string;departureSeconds:number;arrivalSeconds:number;
    frames:{tick:number;state:string;position:{x:number;y:number}}[]}[];
}
export interface KnownDefenseEvidence {
  roomId:string;player:number;basisRevision:string;observedTick:number;observedSeconds:number;targetTick:number;
  targets:PlayerObservation['view']['outposts'];fleets:PlayerObservation['view']['fleets'];
  arrivals:{fleetId:string;target:string;tick:number;seconds:number;drillers:number;kind:string}[];
  drafts:readonly KnownPredictionDraft[];
}
export interface KnownPredictionOptions { pathPredicates?: readonly KnownPathPredicate[]; onPathEvidence?: (evidence: KnownPathEvidence) => void; drafts?: readonly KnownPredictionDraft[]; enemyWaiting?: 'defend'; enemyLaunches?:readonly KnownEnemyLaunch[];onDefenseEvidence?:(evidence:KnownDefenseEvidence)=>void;onDepartureEvidence?:(evidence:KnownDepartureEvidence)=>void;collectResourceFrames?:boolean;cancelled?:()=>boolean }
const supportedType = (type: string | undefined): 'factory' | 'generator' | 'mine' =>
  type === 'factory' || type === 'mine' ? type : 'generator';

/** This module receives ONLY the existing player observation. It cannot read a
 * room, server snapshot, hidden runtime, allocation cursors or random seed. */
export function createKnownPrediction(observation: PlayerObservation, options: KnownPredictionOptions = {}) {
  const { inspect, ...session } = createSession(observation, options);
  return session;
}

/** Prepare one private, immutable knowledge-bound world for independent
 * counterfactuals. Each session owns a cloned engine state; assumptions,
 * orders, journals and checkpoints never leak into another branch. */
export function prepareKnownPrediction(observation:PlayerObservation){
  const base=prepareBase(structuredClone(observation));
  return {create(options:KnownPredictionOptions={}){
    const {inspect,...session}=createSession(base.input,options,base);
    return session;
  }};
}

/** Authorized ordinary routes need no reconstructed simulation world. */
export function createKnownForceRouteEstimator(observation:PlayerObservation){return knownForceRouteEstimator(observation);}

function prepareBase(input:PlayerObservation){
  const v=input.view,player=v.player;
  const unknown = new Set(v.outposts.filter(o => o.visibility !== 2).map(o => o.id));
  const known = new Map(v.outposts.map(o => [o.id, o]));
  const pendingMine = v.outposts.some(o => o.owner === player && o.minePending);
  const costUnits = v.self.mineCreationCost / RULES.OutpostParams.BaseMineCreationCostInDrillers;
  const created = Math.max(0, (costUnits === 1 ? 0 : Math.round(costUnits / 2)) - Number(pendingMine));
  const state = createFleetScenario({
    ...(v.launchCancellationLockTick===undefined?{}:{launchCancellationLockTick:v.launchCancellationLockTick}),
    size: { ...v.size }, positions: Object.fromEntries(v.outposts.map(o => [o.id, { ...o.position }])),
    economy: {
      initialTick: v.tick, teamSize: v.teamSize,
      players: Array.from({ length: v.playerCount }, (_, seat) => ({
        active: seat === player ? v.self.active : input.intel.find(p => p.player === seat)?.active ?? true,
        neptunium: seat === player ? v.self.neptunium : input.intel.find(p => p.player === seat)?.neptunium ?? 0,
        minesCreated: seat === player ? created : 0,
      })),
      outposts: v.outposts.map(o => ({
        id: o.id, owner: o.owner ?? null, type: supportedType(o.type),
        // Unknown nodes are inert geometry, never fabricated undefended bases.
        destroyed: unknown.has(o.id) || (o.destroyed ?? false),
        drillers: unknown.has(o.id) ? 0 : o.drillers ?? 0,
        shield: unknown.has(o.id) ? 0 : o.shield ?? 0,
        shieldMax: unknown.has(o.id) ? 0 : o.shieldMax ?? 0,
        shieldsEnabled: o.shieldsEnabled ?? true,
        productionProgress: 0, miningProgress: 0, shieldProgress: 0,
        minePending: false, shieldDisablePending: false,
      })),
    },
  });
  if (state.profile !== v.profile) throw Error('Unsupported prediction rule profile');
  state.forecastPlayer = player;
  // The engine records a separate knowledge-bound crossing, never a live game-ended event.
  if (v.match) { const {ended,...match}=v.match;state.initial.match = match; }
  if (v.self.activity) state.forecastActivity = { player, value: { ...v.self.activity } };
  state.economy.funding[player]=[...v.self.funding];
  const moving=new Set(v.fleets.filter(f=>f.destination?.kind==='outpost'&&known.has(f.destination.id)).map(f=>f.id));
  const fleetCounts = Array<number>(v.playerCount).fill(0);
  state.fleets = v.fleets.filter(f => moving.has(f.id)).map(f => {
    const sources = f.state === 'waiting' ? v.outposts.filter(o => o.owner === f.owner &&
      o.position.x === f.position.x && o.position.y === f.position.y) : [];
    const source = f.source ?? (sources.length === 1 ? sources[0]!.id : null);
    return {
      id: f.id, slot: f.owner * 128 + fleetCounts[f.owner]!++, used: true, owner: f.owner,
      source, destination: f.destination!.id,
      position: { ...f.position }, previous: { ...f.position }, state: f.state as Fleet['state'],
      drillers: f.drillers, secondsUntilLaunch: f.secondsUntilLaunch ??
        (f.departureCommitted===true&&f.state==='waiting'?input.secondsSinceLastTick:f.launchRemainingSeconds === undefined ? f.state === 'waiting' ? 600 : 0 : f.launchRemainingSeconds + input.secondsSinceLastTick),
      fractionMoved: 0, gift: f.gift, returned:f.returned??false,
      giftSeconds: f.giftPendingSeconds ? f.giftPendingSeconds + input.secondsSinceLastTick : 0,
    };
  });
  state.subCounters = fleetCounts.map(n => n - 1);
  if(v.match)state.forecastTerminal={reasons:[
    ...(!v.fullMapVisible?['unobserved-world-possible']:[]),
    ...(unknown.size?['unobserved-outposts']:[]),
    ...(moving.size<v.fleets.length?['fleet-trajectory-unknown']:[]),
    ...(input.intel.length<v.playerCount?['public-player-totals-incomplete']:[]),
  ]};
  for (const o of state.economy.outposts) {
    const seen = known.get(o.id)!;
    if (unknown.has(o.id)) { o.futureUnknown = true; continue; }
    const progress = Math.max(0, Math.min(1, seen.metrics?.progress ?? 0));
    if (o.type === 'factory') o.productionProgress = progress * factoryPeriodTicks();
    if (o.type === 'mine' && o.owner !== null) o.miningProgress = progress * minePeriodTicks(
      state.economy.outposts.filter(p => p.owner === o.owner && !p.destroyed).length);
    // These public counters are remaining durations at the captured command
    // clock. Restore that clock's raw deadline; a fresh 600 seconds would move
    // an existing command and could change the order of combat/construction.
    const pendingDeadline=(remaining:unknown,label:string)=>{
      if(typeof remaining!=='number'||!Number.isFinite(remaining)||remaining<0)throw Error(`Missing or invalid ${label} countdown`);
      return remaining+Math.trunc(input.secondsSinceLastTick);
    };
    if (seen.minePending) { o.minePending = true; o.mineSeconds = pendingDeadline(seen.mineRemainingSeconds,'mine'); }
    if (seen.shieldDisablePending) { o.shieldDisablePending=true;o.shieldDisableSeconds=pendingDeadline(seen.shieldDisableRemainingSeconds,'shield disable'); }
  }
  return {input,state,unknown,known,moving};
}

function createSession(observation: PlayerObservation, options: KnownPredictionOptions = {}, prepared?:ReturnType<typeof prepareBase>) {
  const input = prepared?.input??structuredClone(observation), v = input.view, player = v.player;
  if(Array.isArray(options.drafts)&&!dispatchDraftsAllowed(input,options.drafts))throw Error(DISPATCH_LOCK_MESSAGE);
  validateEnemyHypotheses(input,options.enemyLaunches??[]);
  validateKnownPathPredicates(options.pathPredicates ?? []);
  if (v.match?.ended) throw Error('Match has ended');
  const base=prepared??prepareBase(input);
  const {unknown,known,moving}=base;
  const state=prepared?structuredClone(base.state):base.state;
  if(prepared)inheritFleetJournals(base.state,state);
  if (options.enemyWaiting !== undefined && options.enemyWaiting !== 'defend') throw Error('Invalid enemy waiting assumption');
  let preparedState = state;
  if (options.enemyWaiting === 'defend') for (const fleet of state.fleets) {
    // Recall only waiting military fleets whose troops and unique friendly
    // source are observed.
    if (fleet.owner === player || fleet.state !== 'waiting' || v.fleets.find(f=>f.id===fleet.id)?.departureCommitted===true || fleet.drillers<=0 || !fleet.source ||
      !state.economy.players[fleet.owner]?.active || !v.outposts.some(o => o.visibility === 2 && o.id === fleet.source && o.owner === fleet.owner)) continue;
    try { preparedState = submitFleetOrder(preparedState, { id: `known-recall-${fleet.slot}`, player: fleet.owner, action: { kind: 'cancel-launch', fleetId: fleet.id } }).state; }
    catch { /* Unavailable cancellation is not replaced with invented troops. */ }
  }
  const view = projectPlayerView(state, player);
  // Preserve the original observation boundary; never reveal a placeholder.
  view.outposts = view.outposts.map(o => {
    const seen = known.get(o.id)!;
    return { ...o, visibility: seen.visibility, owner: seen.owner ?? null,
      ...(unknown.has(o.id) ? { type: supportedType(seen.type), destroyed: seen.destroyed ?? false } : {}) };
  });
  const projection = { view, unknownOutposts: [...unknown], observedSeconds: input.secondsSinceLastTick,
    assumptions: ['Client observation only; no hidden entities; no unobserved orders except explicitly listed counterfactual drafts',
      'Unobserved economy and shield phases are not reconstructed',
      'Visible actors continue their known course; unknown targets retain last known contacts'] };
  if (options.enemyWaiting === 'defend') projection.assumptions.push('Observed enemy waiting military fleets are recalled to their observed sources to defend; unknown cancellation flags are not inferred');
  if(options.enemyLaunches?.length)projection.assumptions.push('Counterfactual visible enemy launches, NOT observed orders or predicted intent: '+JSON.stringify(options.enemyLaunches));

  const plans: Plan[] = input.scheduled.filter(p => p.status === 'pending' && p.player === player).map(p => ({
    ...parseFleetOrder({ id: p.id, player: p.player, action: p.action }), issueTick: p.issueTick, status: p.status, slot: -1,
    ...(p.failed ? { failed: true } : {}),
  }));
  const drafts = options.drafts ?? [];
  if (!Array.isArray(drafts) || drafts.length > 32) throw Error('Invalid forecast drafts');
  const ids = new Set(input.scheduled.map(p => p.id));
  for (const draft of drafts) {
    if (Object.keys(draft).sort().join(',') !== 'action,id,issueTick' || ids.has(draft.id) || !Number.isInteger(draft.issueTick) || draft.issueTick < v.tick || draft.issueTick > v.tick + 1440) throw Error('Invalid forecast draft');
    const order = parseFleetOrder({ id: draft.id, player, action: draft.action });
    if (['reserve-fleet','release-fleet-reservation','recall-waiting-fleet','toggle-funding','resign'].includes(order.action.kind)) throw Error('Invalid forecast draft');
    ids.add(draft.id); plans.push({ ...order, issueTick: draft.issueTick, status: 'pending', slot: -1 });
  }
  for(const h of options.enemyLaunches??[]){
    if(ids.has(h.id))throw Error('Duplicate hypothetical order identity');ids.add(h.id);
    const order=parseFleetOrder({id:h.id,player:h.player,action:{kind:'launch',source:h.source,destination:h.destination,drillers:h.drillers}});
    plans.push({...order,issueTick:h.issueTick,status:'pending',slot:-1});
  }
  let initial: Branch = { state: preparedState, plans };
  for (const [index, plan] of plans.entries()) if (plan.action.kind === 'launch') {
    const identity = plan.action.fleetId ?? plan.id;
    if (!plan.action.fleetId && plan.issueTick > v.tick) initial.state = submitFleetOrder(initial.state, {
      id: `local-reserve-${index}`, player:plan.player, action: { kind: 'reserve-fleet', reservationId: identity },
    }).state;
    plan.slot = initial.state.fleetReservations.find(r => r.id === identity)?.slot ?? initial.state.fleets.find(f => f.id === identity)?.slot ?? -1;
  }
  const retained=new WeakSet<Branch>();
  initial = advanceBranch(initial, v.tick);
  retained.add(initial);
  const checkpoints = new Map<number, Branch>();
  // Sample only the near departure window of this existing baseline simulation.
  // Foreign countdowns are unknown: later or differently timed launches must wake.
  const departureIds=options.onDepartureEvidence&&!options.enemyWaiting&&!drafts.length&&!options.enemyLaunches?.length
    ?v.fleets.filter(f=>f.owner!==player&&!f.gift&&f.drillers>0&&f.state==='waiting'&&f.destination?.kind==='outpost').map(f=>f.id):[];
  const departureFrames=new Map<string,KnownDepartureEvidence['departures'][number]['frames']>();
  let working = initial;
  let requestedTargetTick=v.tick;
  function begin(targetTick: number) {
    if (!Number.isInteger(targetTick) || targetTick <= v.tick || targetTick - v.tick > 1440) throw Error('Invalid forecast horizon');
    if (drafts.some(d => d.issueTick > targetTick)||(options.enemyLaunches??[]).some(h=>h.issueTick>targetTick)) throw Error('Invalid forecast draft horizon');
    requestedTargetTick=targetTick;
    working = initial;
    for (const [tick, frame] of checkpoints) if (tick <= targetTick && tick > working.state.economy.tick) working = frame;
  }
  function advanceBranch(base: Branch, target: number) {
    const branch: Branch = { state: retained.has(base)?structuredClone(base.state):base.state, plans: structuredClone(base.plans),...(options.collectResourceFrames?{resourceFrames:[...(base.resourceFrames??[])]}:{}) };
    if(branch.state!==base.state)inheritFleetJournals(base.state,branch.state);
    const due = [...new Set(branch.plans.filter(p => p.status === 'pending' && p.issueTick <= target).map(p => p.issueTick))].sort((a, b) => a - b);
    const skipTerminal=()=>{if(!fleetForecastStopped(branch.state))return false;for(const plan of branch.plans)if(plan.status==='pending')plan.status='skipped-terminal';return true;};
    if(skipTerminal())return branch;
    for (const tick of due) {
      branch.state = advanceOwnedFleetScenario(branch.state, Math.max(branch.state.economy.tick, tick), true);
      if(skipTerminal())break;
      const entries = branch.plans.map(plan => ({ plan, uid: plan.id, playerIndex: plan.player, scheduledTick: plan.issueTick,
        canceled: plan.status !== 'pending', failed: plan.failed ?? plan.status === 'failed', type: plan.action.kind === 'launch' ? 2 : 0,
        launchSubData: plan.action.kind === 'launch' ? { srcOutpostIndex: plan.action.source, dstItemType: 'outpost', dstItemIndex: plan.action.destination, subIndex: plan.slot } : null }));
      applyOriginalFutureQueue(entries, tick, (entry: typeof entries[number]) => {
        const plan = entry.plan;
        try {
          const assumedLaunch=options.enemyLaunches?.find(h=>h.id===plan.id);
          if(assumedLaunch&&branch.state.economy.outposts.find(p=>p.id===assumedLaunch.source)?.owner!==plan.player)plan.knownSourceLost=true;
          branch.state = submitFleetOrder(branch.state, { id: plan.id, player: plan.player, action: plan.action }, tick === v.tick ? input.secondsSinceLastTick : 0).state;
          if (plan.action.kind === 'launch') {
            plan.fleetId = branch.state.events.at(-1)!.subject;
            plan.slot = branch.state.fleets.find(f => f.id === plan.fleetId && f.used)?.slot ?? plan.slot;
            if (entry.launchSubData) entry.launchSubData.subIndex = plan.slot;
          }
          plan.status = 'executed';
          if(skipTerminal())for(const remaining of entries)if(remaining.plan.status==='skipped-terminal')remaining.canceled=true;
          return true;
        }
        catch (error) { plan.status = 'failed'; plan.reason = error instanceof Error ? error.message : 'Known command failed'; return false; }
      });
      for (const entry of entries) {
        if(entry.plan.status==='skipped-terminal')continue;
        if (entry.plan.status === 'pending') { entry.plan.failed = entry.failed; continue; }
        entry.plan.status = entry.failed ? 'failed' : 'executed';
        if (entry.failed && !entry.plan.reason) entry.plan.reason = 'A related launch modification failed';
        if (!entry.failed) delete entry.plan.reason;
      }
      if(options.collectResourceFrames){
        const affected=drafts.filter(d=>d.issueTick===tick);
        if(affected.length){
          const sources=[...new Set([...v.outposts.filter(p=>p.owner===player&&p.visibility===2).map(p=>p.id),...affected.flatMap(d=>[d.action.source,d.action.outpostId].filter((id):id is string=>typeof id==='string'))])];
          const uncertainTargets=new Set(branch.state.events.filter(e=>e.kind==='future-unknown-arrival').map(e=>e.details.target??e.details.outpost));
          const unavailable=unavailableReason(branch);
          branch.resourceFrames!.push({tick,draftIds:affected.map(d=>d.id),coverage:'queue-time/1',
            sources:sources.map(source=>{const p=branch.state.economy.outposts.find(p=>p.id===source),certain=known.get(source)?.visibility===2&&!uncertainTargets.has(source);return {source,owner:certain?p?.owner??null:null,drillers:certain?p?.drillers??null:null};}),
            pendingSchedules:branch.plans.filter(p=>input.scheduled.some(s=>s.id===p.id)&&p.status==='pending'&&!p.failed).map(p=>({id:p.id,issueTick:p.issueTick,action:structuredClone(p.action)})),
            pathUnknownReasons:[
              ...(moving.size<v.fleets.length?['fleet-trajectory-unknown']:[]),
              ...(branch.state.events.some(e=>e.kind==='future-unknown-arrival')?['arrival-outcome-unknown']:[]),
              ],
            unknownReasons:[...(unavailable?[unavailable]:[]),...sources.filter(source=>known.get(source)?.visibility!==2||uncertainTargets.has(source)).map(source=>`source-resource-unknown:${source}`)]});
        }
      }
    }
    branch.state = advanceOwnedFleetScenario(branch.state, target, true);
    skipTerminal();
    return branch;
  }
  function step(targetTick: number, budget = 8) {
    if(options.cancelled?.())throw Error('Forecast cancelled');
    const target = Math.min(targetTick, working.state.economy.tick + (departureIds.length&&working.state.economy.tick<v.tick+4?1:budget));
    working = advanceBranch(working, target);
    if(departureIds.length&&working.state.economy.tick<=v.tick+4)for(const id of departureIds){
      const f=working.state.fleets.find(f=>f.used&&f.id===id);
      if(f){const frames=(departureFrames.get(id)??[]).filter(frame=>frame.tick!==working.state.economy.tick);frames.push({tick:working.state.economy.tick,state:f.state,position:{...f.position}});departureFrames.set(id,frames);}
    }
    return fleetForecastStopped(working.state)||working.state.economy.tick >= targetTick;
  }
  function result(): KnownForecastResponse {
    const scope = { roomId: input.roomId, revision: input.revision,...(options.collectResourceFrames?{resourceFrames:structuredClone(working.resourceFrames??[])}:{}),
      // These IDs come only from hypotheses validated before constructing the
      // branch. Their namespace is checked against all own and pending IDs.
      ...(options.enemyLaunches?.length?{hypotheticalEnemyOrderIds:options.enemyLaunches.map(h=>h.id),hypotheticalEnemySourceLossIds:working.plans.filter(p=>p.knownSourceLost&&p.status==='failed').map(p=>p.id)}:{}) };
    const unavailable = unavailableReason(working);
    if (unavailable) return { ...scope, status: 'unsupported', reasons: [unavailable] };
    const frame = projectForecastResult(projection, working.state);
    const defaultPredicates: KnownPathPredicate[] = v.outposts.filter(o => o.owner === player && o.type === 'mine' && o.visibility === 2).flatMap(o => [
      { id: `control:${o.id}`, kind: 'controlsThroughout' as const, outpostId: o.id },
      { id: `mine-loss:${o.id}`, kind: 'noMineLoss' as const, outpostId: o.id },
    ]);
    const path = projectKnownPathEvidence(input, working.state, frame, options.pathPredicates ?? defaultPredicates,
      working.plans.filter(p => p.action.kind === 'launch').map(p => p.fleetId ?? String(p.action.kind === 'launch' ? p.action.fleetId ?? p.id : p.id)), requestedTargetTick,
      working.plans.filter(p => p.action.kind === 'launch').map(p => ({ orderId: p.id, fleetId: p.fleetId ?? String(p.action.kind === 'launch' ? p.action.fleetId ?? p.id : p.id), issueTick: p.issueTick, status: p.status })), v.fleets.some(f => !moving.has(f.id)));
    options.onPathEvidence?.(path);
    if(departureIds.length&&working.plans.every(p=>p.status==='executed')){
      const departures=departureIds.flatMap(fleetId=>{
        const seen=v.fleets.find(f=>f.id===fleetId)!;
        const departed=working.state.events.find(e=>e.subject===fleetId&&e.kind==='departed');
        const arrival=working.state.events.find(e=>e.subject===fleetId&&['battle','unloaded'].includes(e.kind)&&
          (e.details.target??e.details.outpost)===seen.destination!.id);
        return departed&&arrival?[{fleetId,departureSeconds:(departed.tick-1+departed.fraction)*600,
          arrivalSeconds:(arrival.tick-1+arrival.fraction)*600,frames:departureFrames.get(fleetId)??[]}]:[];
      });
      if(departures.length)options.onDepartureEvidence?.({roomId:input.roomId,player,basisRevision:input.revision,observedTick:v.tick,targetTick:working.state.economy.tick,departures});
    }
    // Extract from the simulation already performed; no extra forecast or model.
    options.onDefenseEvidence?.({roomId:input.roomId,player,basisRevision:input.revision,observedTick:v.tick,observedSeconds:input.secondsSinceLastTick,targetTick:working.state.economy.tick,
      targets:structuredClone(v.outposts),fleets:structuredClone(v.fleets),drafts:structuredClone(drafts),
      arrivals:working.state.events.filter(e=>v.fleets.some(f=>f.id===e.subject)&&['unloaded','battle','future-unknown-arrival'].includes(e.kind)).flatMap(e=>{
        const target=e.details.outpost??e.details.target;
        return typeof target==='string'?[{fleetId:e.subject,target,tick:e.tick,seconds:(e.tick-1+e.fraction)*600,drillers:Number(e.details.drillers??0),kind:e.kind}]:[];
      })});
    const unresolved = v.fleets.filter(f => !moving.has(f.id));
    frame.fleets.push(...structuredClone(unresolved) as typeof frame.fleets);
    retained.add(working);
    checkpoints.set(working.state.economy.tick, working);
    if (checkpoints.size > 12) checkpoints.delete(checkpoints.keys().next().value!);
    return { ...scope, status: 'conditional', path, result: {...frame,requestedTargetTick},
      orders: working.plans.map(p => {
        const failure = p.status === 'failed' ? publicPlayerError(new Error(p.reason)) : null;
        return { id: p.id, issueTick: p.issueTick, status: p.status, certainty: 'conditional', ...(failure ? { code: failure.code, reason: failure.message } : {}) };
      }) };
  }
  return { begin, step, result, inspect: () => working,
    predict(targetTick: number) { begin(targetTick); while (!step(targetTick)); return result(); } };
}

export function forecastKnownObservation(observation: PlayerObservation, targetTick: number, drafts: readonly KnownPredictionDraft[] = [], enemyWaiting?: 'defend',onDepartureEvidence?:KnownPredictionOptions['onDepartureEvidence'],pathPredicates?:readonly KnownPathPredicate[],collectResourceFrames=false) {
  return createKnownPrediction(observation, { drafts, ...(enemyWaiting ? { enemyWaiting } : {}),...(onDepartureEvidence?{onDepartureEvidence}:{}),...(pathPredicates?{pathPredicates}:{}),...(collectResourceFrames?{collectResourceFrames:true}:{}) }).predict(targetTick);
}

/** All alternatives share one assumption. By default visible pending attacks
 * continue; recalling enemies is an explicit counterfactual, not their intent. */
export function compareKnownObservations(observation: PlayerObservation, scenarios: readonly { id: string; targetTick: number; drafts: readonly KnownPredictionDraft[];predicates?:readonly KnownPathPredicate[] }[],onDefenseEvidence?:(id:string,evidence:KnownDefenseEvidence)=>void,enemyWaiting?:'defend',onDepartureEvidence?:KnownPredictionOptions['onDepartureEvidence'],collectResourceFrames=false) {
  if (!Array.isArray(scenarios) || scenarios.length < 2 || scenarios.length > 5 || new Set(scenarios.map(s => s.id)).size !== scenarios.length ||
    scenarios.some(s => typeof s.id !== 'string' || !s.id.trim() || s.id.length > 80 || !Array.isArray(s.drafts) || s.drafts.length > 8)) throw Error('Invalid forecast scenarios');
  const frozen = structuredClone(observation);
  return { roomId: frozen.roomId, revision: frozen.revision, scenarios: scenarios.map(s => ({
    ...s, drafts: [...s.drafts], result: createKnownPrediction(frozen,{drafts:s.drafts,...(s.predicates?{pathPredicates:s.predicates}:{}),...(collectResourceFrames?{collectResourceFrames:true}:{}),...(enemyWaiting?{enemyWaiting}:{}),...(onDepartureEvidence?{onDepartureEvidence}:{}),...(onDefenseEvidence?{onDefenseEvidence:(evidence:KnownDefenseEvidence)=>onDefenseEvidence(s.id,evidence)}:{})}).predict(s.targetTick),
  })) };
}

/** Read-only current-tick transaction through the exact shared command queue.
 * Future production, movement and combat are not advanced. The returned view is
 * hypothetical and retains the real basis revision, never a live write receipt. */
export function previewKnownDraftTransaction(observation: PlayerObservation, drafts: readonly KnownPredictionDraft[]) {
  if (!Array.isArray(drafts) || drafts.length > 32 || drafts.some(d => d.issueTick !== observation.view.tick))
    throw Error('Immediate draft transaction requires current-tick drafts');
  const session = createSession(observation, { drafts }), result = session.result();
  if (result.status === 'unsupported') return { status: 'unsupported' as const, reasons: result.reasons, orders: [], observation: null, sourceEffects: [] };
  const frame = result.result, next = structuredClone(observation);
  next.view = { ...next.view, tick: frame.targetTick, outposts: frame.outposts, fleets: frame.fleets,
    self: frame.self, sonar: frame.sonar };
  const sourceEffects = observation.view.outposts.filter(o => o.owner === observation.view.player && o.visibility === 2 && o.drillers !== undefined).map(o => {
    const after = next.view.outposts.find(p => p.id === o.id);
    return { outpostId: o.id, beforeDrillers: o.drillers!, afterDrillers: after?.drillers ?? null,
      netCommitted: after?.drillers === undefined ? null : o.drillers! - after.drillers };
  });
  return { status: 'conditional' as const, orders: result.orders, observation: next, sourceEffects,
    assumptions: ['Current-tick drafts and already due own scheduled orders use the shared queue without advancing the clock',
      'Partial failure is represented per order; this is a hypothetical transaction, not atomic live execution'] };
}

/** Arrival and deployment helpers use the same client observation constructor,
 * including its unknown boundary. They never accept an authoritative world. */
export function* knownFleetArrivalSteps(observation:PlayerObservation,fleetId:string,atTick=observation.view.tick):Generator<void,FleetArrivalEstimate> {
  const start=observation.view.tick;
  if(!Number.isInteger(atTick)||atTick<start||atTick>start+1440)throw Error('Invalid arrival frame');
  if(observation.view.match?.ended)return unknownFleetArrival(fleetId);
  const session=createSession(observation);
  // This private session advances to the displayed frame, then at most 288 ticks
  // past it. Unlike a timeline projection, it does not project every frame.
  session.begin(start+1);
  while(session.inspect().state.economy.tick<atTick){
    const before=session.inspect().state.economy.tick;
    session.step(atTick,1);yield;
    if(unavailableReason(session.inspect())||session.inspect().state.economy.tick===before)return unknownFleetArrival(fleetId);
  }
  const fleet=session.inspect().state.fleets.find(f=>f.used&&f.id===fleetId);
  if(!fleet)return unknownFleetArrival(fleetId);
  const destination=fleet.destination;
  for(let tick=atTick+1;tick<=Math.min(1e7,atTick+288);tick++){
    const previous=session.inspect().state,previousTick=previous.economy.tick,first=previous.events.length;
    session.step(tick,1);
    const branch=session.inspect();
    if(unavailableReason(branch))return unknownFleetArrival(fleetId);
    const event=branch.state.events.slice(first).find(e=>e.subject===fleetId&&
      (e.kind==='unloaded'||e.kind==='battle'||e.kind==='future-unknown-arrival')&&(e.details.outpost??e.details.target)===destination);
    if(event)return {fleetId,arrivalTick:event.tick,arrivalSeconds:(event.tick-1+event.fraction)*600,status:'estimated'};
    if(branch.state.economy.tick===previousTick||!branch.state.fleets.some(f=>f.used&&f.id===fleetId))break;
    yield;
  }
  return unknownFleetArrival(fleetId);
}

export function estimateKnownArrivals(observation: PlayerObservation) {
  const session = createSession(observation), start = observation.view.tick;
  const arrivals = observation.view.fleets.map(f => ({ id: f.id, arrivalTick: null as number | null, arrivalMinutes: null as number | null }));
  const pending = new Set(arrivals.map(f => f.id));
  if (!pending.size) return { status: 'conditional' as const, arrivals };
  session.begin(start + 288);
  for (let tick = start + 1; tick <= start + 288 && pending.size; tick++) {
    if(fleetForecastStopped(session.inspect().state))break;
    const first = session.inspect().state.events.length;
    session.step(tick, 1);
    const unavailable = unavailableReason(session.inspect());
    if (unavailable) return { status: 'unsupported' as const, reasons: [unavailable], arrivals };
    for (const event of session.inspect().state.events.slice(first)) {
      if (!pending.has(event.subject) || !['unloaded','battle','future-unknown-arrival'].includes(event.kind)) continue;
      const destination = observation.view.fleets.find(f => f.id === event.subject)?.destination;
      if (!destination || (event.details.outpost ?? event.details.target) !== destination.id) continue;
      const row = arrivals.find(f => f.id === event.subject)!;
      row.arrivalTick = tick;
      row.arrivalMinutes = Math.max(0, (tick - start - 1 + event.fraction) * 10 - observation.secondsSinceLastTick / 60);
      pending.delete(event.subject);
    }
    const world = session.inspect().state;
    for (const id of pending) if (!world.fleets.some(f => f.id === id && f.used)) pending.delete(id);
  }
  return { status: 'conditional' as const, arrivals };
}

export type KnownDeploymentPreview =
  | {status:'unsupported';reasons:string[]}
  | {status:'conditional';arrivalTick:number|null;
      /** Exact absolute rule seconds from the movement event, not its settlement tick. */
      arrivalSeconds:number|null;
      /** Remaining rule minutes from this captured observation, including launch wait. */
      arrivalMinutes:number|null;
      target:{id:string;owner:number|null;drillers:number;shield:number}|null;
      outcome:'unknown'|'reinforced'|'won'|'lost'|'unresolved'};
export function previewKnownDeployment(observation: PlayerObservation, draft: KnownPredictionDraft, enemyWaiting?: 'defend'):KnownDeploymentPreview {
  if (draft.action.kind !== 'launch') throw Error('Invalid deployment draft');
  const session = createSession(observation, { drafts: [draft], ...(enemyWaiting ? { enemyWaiting } : {}) });
  const end = Math.min(observation.view.tick + 1440, draft.issueTick + 288);
  session.begin(end);
  const destination = String(draft.action.destination), player = observation.view.player;
  for (let tick = observation.view.tick + 1; tick <= end; tick++) {
    if(fleetForecastStopped(session.inspect().state))break;
    const before = session.inspect(), first = before.state.events.length;
    const defender = before.state.economy.outposts.find(o => o.id === destination)?.owner;
    session.step(tick, 1);
    const branch = session.inspect(), plan = branch.plans.find(p => p.id === draft.id)!;
    const unavailable = unavailableReason(branch);
    if (unavailable) return { status: 'unsupported' as const, reasons: [unavailable] };
    if (plan.status === 'failed') {
      throw Error(plan.reason ?? 'Deployment draft failed');
    }
    const id = plan.fleetId ?? String(draft.action.fleetId ?? draft.id);
    const arrival = branch.state.events.slice(first).find(e => e.subject === id &&
      (e.kind === 'unloaded' && e.details.outpost === destination || e.kind === 'battle' && e.details.target === destination || e.kind === 'future-unknown-arrival' && e.details.outpost === destination));
    if (arrival) {
      const projected = session.result();
      if (projected.status === 'unsupported') return projected;
      const post = projected.result.outposts.find(o => o.id === destination);
      const target = post && post.drillers !== undefined && post.shield !== undefined && post.owner !== undefined ?
        { id: post.id, owner: post.owner, drillers: post.drillers, shield: post.shield } : null;
      // Economic tick advances before movement; the unrounded event fraction
      // belongs to the interval ending at arrival.tick. This is the same event
      // convention used by knownFleetArrivalSteps and estimateKnownArrivals.
      const arrivalSeconds=(arrival.tick-1+arrival.fraction)*600;
      const arrivalMinutes=Math.max(0,(arrivalSeconds-observationRuleSeconds(observation))/60);
      return { status: 'conditional' as const, arrivalTick: tick, arrivalSeconds, arrivalMinutes, target,
        outcome: !target ? 'unknown' : arrival.kind === 'unloaded' && defender === player ? 'reinforced' : target.owner === player ? 'won' : 'lost' };
    }
    if (tick >= draft.issueTick && !branch.state.fleets.some(f => f.id === id && f.used)) break;
  }
  return { status: 'conditional' as const, arrivalTick: null, arrivalSeconds: null, arrivalMinutes: null, target: null, outcome: 'unresolved' };
}

export { advanceLabBranch, fleetCountdowns, type LabPredictionRoom } from './lab-branch.js';
export { createLabPrediction } from './lab-prediction.js';
export { forecastKnownPath, searchKnownForceCandidates, compileKnownIssueTickCandidates, searchKnownSupportCandidates, compileKnownTimingCandidates,
  type KnownPathRequest, type KnownSearchBudget, type KnownCandidateRequest, type KnownCandidateArrival, type KnownCandidateEvaluation,
  type KnownSearchCoverage, type KnownCandidateSearchResult, type KnownForceCandidateRequest, type KnownIssueTickCandidateRequest,
  type KnownSupportCandidateRequest, type KnownSupportCandidateResult, type KnownTimingCandidateRequest, type KnownTimingCandidateResult } from './candidate-search.js';
