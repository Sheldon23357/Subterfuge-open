import type {AiMemory} from '../contracts/types.js';
import {shortFleetReferences} from '../presentation/fleet-labels.js';
import {STRATEGY_CHARACTERS} from './notebook-capacity.js';

/** Exact, unique replacements only. Validate the entire update before saving. */
export function patchMemory(current:AiMemory, replacements:unknown, edits:unknown):AiMemory {
  const fields=['strategy','relations','agreements','deceptions'];
  const next={...shortFleetReferences(current)};
  if(replacements!==undefined){
    if(!replacements||typeof replacements!=='object'||Array.isArray(replacements))throw Error('Invalid memory');
    for(const [field,value] of Object.entries(replacements)){
      if(!fields.includes(field)||typeof value!=='string'||value.length>12000)throw Error('Invalid memory');
      next[field as keyof AiMemory]=value;
    }
  }
  if(edits!==undefined){
    if(!Array.isArray(edits)||edits.length>16)throw Error('At most 16 memory edits');
    for(const edit of edits){
      if(!edit||typeof edit!=='object'||Array.isArray(edit)||Object.keys(edit).sort().join(',')!=='field,find,replace'||!fields.includes(edit.field)||typeof edit.find!=='string'||!edit.find.length||typeof edit.replace!=='string')throw Error('Invalid memory edit: field, nonempty find and replace required');
      if(replacements&&Object.hasOwn(replacements,edit.field))throw Error('Do not replace and edit the same memory field');
      const field=edit.field as keyof AiMemory,text=next[field],at=text.indexOf(edit.find);
      if(at<0||text.indexOf(edit.find,at+1)>=0)throw Error(`Memory edit must match exactly once in ${field}; read notebook {} before revising`);
      next[field]=text.slice(0,at)+edit.replace+text.slice(at+edit.find.length);
    }
  }
  if(next.strategy.length>STRATEGY_CHARACTERS)throw Error(`战略判断最多${STRATEGY_CHARACTERS}字符，请将具体计划写入笔记`);
  if(Object.values(next).some(v=>v.length>12000))throw Error('Invalid memory: field exceeds 12000 characters');
  return next;
}
