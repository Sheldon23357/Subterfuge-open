import type {NotebookEntry} from '../contracts/types.js';
import {isActiveNote} from './memory-records.js';

export const NOTEBOOK_CHARACTERS=12000;
export const NOTEBOOK_ENTRIES=32;
export const STRATEGY_CHARACTERS=1000;
/** JS string length is the explicit storage budget (UTF-16 code units).
 * Deterministic ID tie-breaking only applies when body timestamps are equal. */
export function notebookCapacity(entries:Iterable<NotebookEntry>,now:number){
 const active=[...entries].filter(note=>isActiveNote(note,now));
 const rank={low:0,medium:1,high:2};
 const oldest=[...active].sort((a,b)=>rank[a.priority??'medium']-rank[b.priority??'medium']||a.updatedAt-b.updatedAt||a.id.localeCompare(b.id));
 let count=active.length,characters=active.reduce((sum,note)=>sum+note.text.length,0);
 const evicted:string[]=[];
 for(const note of oldest){
  if(count<=NOTEBOOK_ENTRIES&&characters<=NOTEBOOK_CHARACTERS)break;
  evicted.push(note.id);count--;characters-=note.text.length;
 }
 return {evicted,count,characters};
}
