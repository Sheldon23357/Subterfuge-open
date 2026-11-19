import type { LabView } from '../../contracts/src/index.js';

export type GlobalPredictionSource = NonNullable<LabView['predictionSource']> & { startTick: number };
export function globalPredictionKey(source: GlobalPredictionSource) {
  return JSON.stringify([source.roomId, source.revision, source.startTick]);
}
/** Clock/display-only refreshes retain the same prediction context. A host
 * snapshot digest changes for commands as well as ticks; room identity also
 * prevents a new game at the same tick from inheriting the previous cache. */
export function globalDecisionRevision<T extends Pick<LabView, "tick" | "predictionSource">>(view: T | null) {
  return view?.predictionSource
    ? globalPredictionKey({ ...view.predictionSource, startTick: view.tick })
    : view;
}
