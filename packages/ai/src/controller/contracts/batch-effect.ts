/** Executor-owned evidence for the next child effect, never model arguments.
 * Only successful prior children enter accepted; rejection/unknown stops a batch. */
export interface BatchEffect {
 readonly id:string;
 readonly index:number;
 readonly actions:readonly {tool:string;arguments:Record<string,unknown>}[];
 readonly accepted:readonly {index:number;requestId:string}[];
}
