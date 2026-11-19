import type {NotebookEntry} from '../contracts/types.js';

/** Omitted scalar fields preserve only the current active note supplied by the caller. */
export function patchNotebookEntry(input:Record<string,unknown>,previous:NotebookEntry|undefined){
 const note={...input},inherited:string[]=[];
 if(previous)for(const key of ['priority','kind','text','expiresAt'] as const){
  if(!Object.hasOwn(input,key)&&Object.hasOwn(previous,key)){note[key]=previous[key];inherited.push(key);}
 }
 return {note,inherited};
}
