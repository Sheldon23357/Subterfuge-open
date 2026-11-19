import type { PlayerForecastResponse, PlayerObservation } from '../../contracts/src/index.js';
import { createKnownPrediction, type KnownPredictionDraft,type KnownForecastResponse,type KnownEnemyLaunch } from './index.js';
import { validateKnownPathPredicates, type KnownPathEvidence, type KnownPathPredicate, type KnownPredicateTruth } from './path-evidence.js';

export interface KnownPathRequest {
  targetTick: number; drafts?: readonly KnownPredictionDraft[]; predicates?: readonly KnownPathPredicate[]; enemyWaiting?: 'defend';enemyLaunches?:readonly KnownEnemyLaunch[];collectResourceFrames?:boolean;
}
export function forecastKnownPath(observation: PlayerObservation, request: KnownPathRequest): { forecast: KnownForecastResponse; path: KnownPathEvidence | null } {
  const response = createKnownPrediction(observation, { drafts: request.drafts ?? [],
    ...(request.predicates ? { pathPredicates: request.predicates } : {}),
    ...(request.enemyWaiting ? { enemyWaiting: request.enemyWaiting } : {}),...(request.enemyLaunches?{enemyLaunches:request.enemyLaunches}:{}),...(request.collectResourceFrames?{collectResourceFrames:true}:{}) }).predict(request.targetTick);
  const { path, ...forecast } = response;
  return { forecast, path: path ?? null };
}
export interface KnownSearchBudget {
  maxSimulations?: number; maxElapsedMs?: number; signal?: AbortSignal;
}
export interface KnownCandidateRequest extends KnownSearchBudget {
  targetTick: number; drafts: readonly KnownPredictionDraft[]; predicates: readonly KnownPathPredicate[]; enemyWaiting?: 'defend';
  validateResources?:(drafts:KnownPredictionDraft[],forecast:KnownForecastResponse)=>{truth:KnownPredicateTruth;evidence:unknown};
}
export interface KnownCandidateArrival { fleetId: string; target: string; tick: number; fraction: number; sequence: number; kind: string; seconds: number }
export interface KnownCandidateEvaluation {
  value: number; drafts: KnownPredictionDraft[]; truth: KnownPredicateTruth; reason: string;
  path: KnownPathEvidence | null; orders: Extract<PlayerForecastResponse, { status: 'conditional' }>['orders'];
  arrivals: KnownCandidateArrival[];
  resourceCheck?:unknown;
}
export interface KnownSearchCoverage {
  requestedCount: number; testedCount: number; complete: boolean; stopReason: 'complete' | 'simulation-budget' | 'time-budget' | 'cancelled';
}
export interface KnownCandidateSearchResult {
  method: 'ascending-enumeration'; conditional: true; basisRevision: string; roomId: string; player: number;
  domain: { kind: 'drillers' | 'issueTick'; minimum: number; maximum: number; values?: number[] };
  coverage: KnownSearchCoverage; candidates: KnownCandidateEvaluation[];
  smallestProvenValue: number | null; smallestFoundValue: number | null;
  conclusion: 'feasible-candidate-found' | 'no-feasible-candidate-in-complete-domain' | 'inconclusive';
}
export interface KnownForceCandidateRequest extends KnownCandidateRequest { varyDraftId: string; minimumDrillers: number; maximumDrillers: number }
export interface KnownIssueTickCandidateRequest extends KnownCandidateRequest { varyDraftId: string; issueTicks: readonly number[] }

function validateRequest(observation: PlayerObservation, request: KnownCandidateRequest) {
  if (!Number.isSafeInteger(request.targetTick) || request.targetTick <= observation.view.tick || request.targetTick > observation.view.tick + 144)
    throw Error('Candidate horizon must be within 144 ticks');
  if (!Array.isArray(request.drafts) || request.drafts.length > 8 || new Set(request.drafts.map(d => d.id)).size !== request.drafts.length)
    throw Error('Invalid candidate drafts');
  if (request.drafts.some(d => !Number.isSafeInteger(d.issueTick) || d.issueTick < observation.view.tick || d.issueTick > request.targetTick))
    throw Error('Invalid candidate issue tick');
  validateKnownPathPredicates(request.predicates);
  if (request.enemyWaiting !== undefined && request.enemyWaiting !== 'defend') throw Error('Invalid enemy waiting assumption');
}
function searchBudget(request: KnownSearchBudget) {
  const maximum = request.maxSimulations ?? 32, maxElapsed = request.maxElapsedMs ?? 2500, started = performance.now();
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 128 || !Number.isFinite(maxElapsed) || maxElapsed < 1 || maxElapsed > 30000)
    throw Error('Invalid candidate search budget');
  let used = 0;
  const reason = (): KnownSearchCoverage['stopReason'] | null => request.signal?.aborted ? 'cancelled' :
    used >= maximum ? 'simulation-budget' : performance.now() - started >= maxElapsed ? 'time-budget' : null;
  return { reason, get used() { return used; }, take() { const stop = reason(); if (stop) return stop; used++; return null; } };
}
function evaluate(observation: PlayerObservation, request: KnownCandidateRequest, drafts: KnownPredictionDraft[], value: number): KnownCandidateEvaluation {
  const { forecast, path } = forecastKnownPath(observation, { targetTick: request.targetTick, drafts, predicates: request.predicates,
    ...(request.enemyWaiting ? { enemyWaiting: request.enemyWaiting } : {}),...(request.validateResources?{collectResourceFrames:true}:{}) });
  const resource=request.validateResources?.(drafts,{...forecast,...(path?{path}:{})}),resourceEvidence=resource?{resourceCheck:resource.evidence}:{};
  if (forecast.status === 'unsupported') return { value, drafts, truth: 'unknown', reason: forecast.reasons.join(';'), path, orders: [], arrivals: [],...resourceEvidence };
  const draftIds = new Set(drafts.map(d => d.id)), orders = forecast.orders;
  // Existing appointments outside this forecast window are retained, not judged.
  const relevantOrders = orders.filter(o => draftIds.has(o.id) || o.issueTick <= request.targetTick);
  const failed = relevantOrders.some(o => o.status === 'failed'), pending = relevantOrders.some(o => o.status !== 'executed' && o.status !== 'failed');
  // A branch-local counterexample is retained in path, but unresolved coverage
  // must not be promoted to a proof that this candidate (or the domain) is impossible.
  const uncertain = resource?.truth==='unknown'||pending || !path || path.coverage.unknownReasons.length > 0 ||
    path.predicates.some(p => p.truth === 'unknown') || !path.coverage.complete;
  const truth: KnownPredicateTruth = resource?.truth==='false'?'false':uncertain ? 'unknown' : failed || path.predicates.some(p => p.truth === 'false') ? 'false' : 'true';
  const arrivals = (path?.events ?? []).filter(e => e.kind === 'battle' || e.kind === 'unloaded' || e.kind === 'future-unknown-arrival').flatMap(e => {
    const target = e.details.target ?? e.details.outpost;
    return typeof target === 'string' ? [{ fleetId: e.subject, target, tick: e.tick, fraction: e.fraction, sequence: e.sequence, kind: e.kind,
      seconds: (e.tick - 1 + e.fraction) * 600 }] : [];
  });
  return { value, drafts, truth, reason: resource?.truth==='false'?'resource-constraints-failed':resource?.truth==='unknown'?'resource-constraints-unknown':failed ? truth === 'unknown' ? 'order-failed-in-uncertain-branch' : 'order-failed' : pending ? 'order-not-executed-within-coverage' : truth === 'unknown' ? 'predicate-or-coverage-unknown' :
    truth === 'false' ? 'predicate-failed' : draftIds.size ? 'orders-and-predicates-satisfied' : 'baseline-predicates-satisfied', path, orders, arrivals,...resourceEvidence };
}
function hasCompleteKnownCoverage(candidate: KnownCandidateEvaluation) {
  return !!candidate.path?.coverage.complete && candidate.path.coverage.unknownReasons.length === 0 &&
    candidate.path.predicates.every(p => p.truth !== 'unknown');
}
function isProvenFailure(candidate: KnownCandidateEvaluation) {
  return candidate.truth === 'false' && hasCompleteKnownCoverage(candidate);
}
function summarize(observation: PlayerObservation, domain: KnownCandidateSearchResult['domain'], requestedCount: number,
  candidates: KnownCandidateEvaluation[], stop: KnownSearchCoverage['stopReason']): KnownCandidateSearchResult {
  const complete = candidates.length === requestedCount, first = candidates.find(c => c.truth === 'true');
  const proven = first && hasCompleteKnownCoverage(first) && candidates.filter(c => c.value < first.value).every(isProvenFailure);
  return { method: 'ascending-enumeration', conditional: true, roomId: observation.roomId, player: observation.view.player, basisRevision: observation.revision, domain,
    coverage: { requestedCount, testedCount: candidates.length, complete, stopReason: complete ? 'complete' : stop }, candidates,
    smallestFoundValue: first?.value ?? null, smallestProvenValue: proven ? first.value : null,
    conclusion: first ? 'feasible-candidate-found' : complete && candidates.every(isProvenFailure) ? 'no-feasible-candidate-in-complete-domain' : 'inconclusive' };
}

/** General domains are explicitly enumerated. No capacity, source-defense,
 * multi-wave, or compound predicate is silently assumed monotonic. */
export function searchKnownForceCandidates(observation: PlayerObservation, request: KnownForceCandidateRequest): KnownCandidateSearchResult {
  validateRequest(observation, request);
  if (!Number.isSafeInteger(request.minimumDrillers) || !Number.isSafeInteger(request.maximumDrillers) || request.minimumDrillers < 0 ||
    request.maximumDrillers < request.minimumDrillers || request.maximumDrillers > 1e9) throw Error('Invalid force search interval');
  const selected = request.drafts.find(d => d.id === request.varyDraftId);
  if (!selected || selected.action.kind !== 'launch') throw Error('Force search requires a selected launch draft');
  const budget = searchBudget(request), candidates: KnownCandidateEvaluation[] = [];
  let stop: KnownSearchCoverage['stopReason'] = 'complete';
  for (let n = request.minimumDrillers; n <= request.maximumDrillers; n++) {
    const ended = budget.take(); if (ended) { stop = ended; break; }
    const drafts = structuredClone(request.drafts) as KnownPredictionDraft[];
    drafts.find(d => d.id === selected.id)!.action.drillers = n;
    candidates.push(evaluate(observation, request, drafts, n));
  }
  return summarize(observation, { kind: 'drillers', minimum: request.minimumDrillers, maximum: request.maximumDrillers },
    request.maximumDrillers - request.minimumDrillers + 1, candidates, stop);
}
export function compileKnownIssueTickCandidates(observation: PlayerObservation, request: KnownIssueTickCandidateRequest): KnownCandidateSearchResult {
  validateRequest(observation, request);
  if (!request.drafts.some(d => d.id === request.varyDraftId)) throw Error('Unknown varied draft');
  const values = issueTicks(observation, request.issueTicks, request.targetTick), budget = searchBudget(request), candidates: KnownCandidateEvaluation[] = [];
  let stop: KnownSearchCoverage['stopReason'] = 'complete';
  for (const tick of values) {
    const ended = budget.take(); if (ended) { stop = ended; break; }
    const drafts = structuredClone(request.drafts) as KnownPredictionDraft[];
    drafts.find(d => d.id === request.varyDraftId)!.issueTick = tick;
    candidates.push(evaluate(observation, request, drafts, tick));
  }
  return summarize(observation, { kind: 'issueTick', minimum: values[0]!, maximum: values.at(-1)!, values }, values.length, candidates, stop);
}
function issueTicks(observation: PlayerObservation, values: readonly number[], targetTick: number) {
  if (!Array.isArray(values) || !values.length || values.length > 145 || values.some(t => !Number.isSafeInteger(t) || t < observation.view.tick || t > targetTick))
    throw Error('Invalid explicit issue tick set');
  return [...new Set(values)].sort((a, b) => a - b);
}

export interface KnownSupportCandidateRequest extends KnownCandidateRequest { includeHold?: boolean }
export interface KnownSupportCandidateResult {
  method: 'fixed-subset-enumeration'; conditional: true; basisRevision: string; coverage: KnownSearchCoverage;
  candidates: (KnownCandidateEvaluation & { includedDraftIds: string[] })[];
  conclusion: KnownCandidateSearchResult['conclusion'];
}
/** Fixed forces only. Late arrivals are retained for explicit recapture predicates;
 * no distance heuristic removes them or merges different players' forces. */
export function searchKnownSupportCandidates(observation: PlayerObservation, request: KnownSupportCandidateRequest): KnownSupportCandidateResult {
  validateRequest(observation, request);
  if (request.drafts.length < 1 || request.drafts.length > 6 || request.drafts.some(d => d.action.kind !== 'launch')) throw Error('Support search requires 1-6 fixed launch drafts');
  const firstMask = request.includeHold === false ? 1 : 0, requestedCount = 2 ** request.drafts.length - firstMask;
  const budget = searchBudget(request), candidates: KnownSupportCandidateResult['candidates'] = [];
  let stop: KnownSearchCoverage['stopReason'] = 'complete';
  for (let mask = firstMask; mask < 2 ** request.drafts.length; mask++) {
    const ended = budget.take(); if (ended) { stop = ended; break; }
    const drafts = structuredClone(request.drafts.filter((_, i) => mask & (1 << i))) as KnownPredictionDraft[];
    candidates.push({ ...evaluate(observation, request, drafts, mask), includedDraftIds: drafts.map(d => d.id) });
  }
  const complete = candidates.length === requestedCount;
  return { method: 'fixed-subset-enumeration', conditional: true, basisRevision: observation.revision,
    coverage: { requestedCount, testedCount: candidates.length, complete, stopReason: complete ? 'complete' : stop }, candidates,
    conclusion: candidates.some(c => c.truth === 'true') ? 'feasible-candidate-found' : complete && candidates.every(isProvenFailure) ? 'no-feasible-candidate-in-complete-domain' : 'inconclusive' };
}

export interface KnownTimingCandidateRequest extends KnownCandidateRequest {
  timing: readonly { draftId: string; issueTicks: readonly number[] }[];
  /** Integer tick buckets; exact fractions and sequential battles remain in path. */
  maximumArrivalSpreadTicks?: number;
}
export interface KnownTimingCandidateResult {
  method: 'arrival-buckets-with-joint-validation'; conditional: true; basisRevision: string;
  coverage: { simulations: number; singleRequested: number; singleTested: number; combinationsRequested: number;
    combinationsTested: number; combinationsCountExact: boolean; complete: boolean; stopReason: KnownSearchCoverage['stopReason']; domain: 'indexed-arrival-bucket-candidates-only' };
  singleRoutes: { draftId: string; issueTick: number; arrival: KnownCandidateArrival | null; truth: KnownPredicateTruth; reason: string }[];
  candidates: (KnownCandidateEvaluation & { issueTicks: Record<string, number>; arrivalSpreadTicks: number | null; synchronized: KnownPredicateTruth })[];
  conclusion: 'synchronized-candidate-found' | 'no-synchronized-candidate-in-indexed-buckets' | 'inconclusive';
  limitations: string[];
}
export function compileKnownTimingCandidates(observation: PlayerObservation, request: KnownTimingCandidateRequest): KnownTimingCandidateResult {
  validateRequest(observation, request);
  if (request.drafts.length < 1 || request.drafts.length > 6 || request.drafts.some(d => d.action.kind !== 'launch') ||
    !Array.isArray(request.timing) || request.timing.length !== request.drafts.length || new Set(request.timing.map(t => t.draftId)).size !== request.drafts.length ||
    request.timing.some(t => !request.drafts.some(d => d.id === t.draftId))) throw Error('Timing compilation requires explicit timing for 1-6 launch drafts');
  const target = request.drafts[0]!.action.destination;
  if (request.drafts.some(d => d.action.destination !== target || d.action.destinationKind && d.action.destinationKind !== 'outpost'))
    throw Error('Timing compilation requires a shared outpost destination');
  const spread = request.maximumArrivalSpreadTicks ?? 0;
  if (!Number.isSafeInteger(spread) || spread < 0 || spread > 144) throw Error('Invalid synchronization window');
  const domains = request.drafts.map(d => ({ draft: d, values: issueTicks(observation, request.timing.find(t => t.draftId === d.id)!.issueTicks, request.targetTick) }));
  const budget = searchBudget(request), singleRoutes: KnownTimingCandidateResult['singleRoutes'] = [], candidates: KnownTimingCandidateResult['candidates'] = [];
  let stop: KnownSearchCoverage['stopReason'] = 'complete', combinationsRequested = 0;
  const firstArrival = (evaluation: KnownCandidateEvaluation, draft: KnownPredictionDraft) => {
    // Waiting edits preserve an existing fleet identity and departure clock.
    const launches = evaluation.path?.events.filter(e => ['launch-ordered','departed'].includes(e.kind) && e.details.source === draft.action.source && e.details.destination === draft.action.destination) ?? [];
    const fleetId = String(evaluation.path?.orderFleets.find(o => o.orderId === draft.id)?.fleetId ?? draft.action.fleetId ?? launches.at(-1)?.subject ?? draft.id);
    return evaluation.arrivals.find(a => a.fleetId === fleetId && a.target === draft.action.destination) ?? null;
  };
  outer: for (const domain of domains) for (const tick of domain.values) {
    const ended = budget.take(); if (ended) { stop = ended; break outer; }
    const draft = { ...structuredClone(domain.draft), issueTick: tick };
    const {validateResources:jointResourceValidator,...routeRequest}=request;
    const result = evaluate(observation, { ...routeRequest, predicates: [] }, [draft], tick);
    singleRoutes.push({ draftId: draft.id, issueTick: tick, arrival: firstArrival(result, draft), truth: result.truth, reason: result.reason });
  }
  const indexed = domains.map(d => singleRoutes.filter(r => r.draftId === d.draft.id && r.arrival && r.arrival.kind !== 'future-unknown-arrival' && r.truth !== 'false'));
  // Bound enumeration by the same explicit budget, even if all 145^6 issue-time
  // combinations exist. The index is a candidate generator, not a proof of no solution.
  function* combinations(depth = 0, rows: typeof singleRoutes = []): Generator<typeof singleRoutes> {
    if (depth === indexed.length) { yield rows; return; }
    for (const row of indexed[depth]!) {
      const ended = budget.reason(); if (ended) { stop = ended; return; }
      const times = [...rows, row].map(r => r.arrival!.tick);
      if (Math.max(...times) - Math.min(...times) <= spread) yield* combinations(depth + 1, [...rows, row]);
    }
  }
  const singleRequested = domains.reduce((sum, d) => sum + d.values.length, 0);
  if (singleRoutes.length === singleRequested) for (const rows of combinations()) {
    combinationsRequested++;
    const ended = budget.take(); if (ended) { stop = ended; break; }
    const drafts = domains.map(d => ({ ...structuredClone(d.draft), issueTick: rows.find(r => r.draftId === d.draft.id)!.issueTick }));
    const evaluation = evaluate(observation, request, drafts, candidates.length);
    const arrivals = drafts.map(d => firstArrival(evaluation, d)), known = arrivals.every(a => a && a.kind !== 'future-unknown-arrival');
    const arrivalSpreadTicks = known ? Math.max(...arrivals.map(a => a!.tick)) - Math.min(...arrivals.map(a => a!.tick)) : null;
    const distinctFleets = new Set(arrivals.filter(a => a !== null).map(a => a!.fleetId)).size === drafts.length;
    const synchronized: KnownPredicateTruth = !known ? 'unknown' : !distinctFleets ? 'false' : arrivalSpreadTicks! <= spread ? 'true' : 'false';
    candidates.push({ ...evaluation, issueTicks: Object.fromEntries(drafts.map(d => [d.id, d.issueTick])), arrivalSpreadTicks, synchronized });
  }
  const complete = stop === 'complete' && singleRoutes.length === singleRequested;
  return { method: 'arrival-buckets-with-joint-validation', conditional: true, basisRevision: observation.revision,
    coverage: { simulations: budget.used, singleRequested, singleTested: singleRoutes.length, combinationsRequested, combinationsTested: candidates.length,
      combinationsCountExact: complete, complete, stopReason: complete ? 'complete' : stop, domain: 'indexed-arrival-bucket-candidates-only' }, singleRoutes, candidates,
    conclusion: candidates.some(c => c.truth === 'true' && c.synchronized === 'true') ? 'synchronized-candidate-found' : complete && candidates.every(c => hasCompleteKnownCoverage(c) && (c.truth === 'false' || c.synchronized === 'false')) && singleRoutes.every(r => r.arrival || r.truth === 'false') ? 'no-synchronized-candidate-in-indexed-buckets' : 'inconclusive',
    limitations: ['Single-route arrival buckets only generate candidates; interactions can create feasible combinations outside these buckets',
      'Completeness is limited to the indexed buckets, never the full joint issue-time domain or a global no-solution claim',
      'Same-tick arrivals remain sequential battles; inspect fractions and emission sequence',
      'All single-route and joint simulations share one bounded budget; sources and strategies remain fixed'] };
}
