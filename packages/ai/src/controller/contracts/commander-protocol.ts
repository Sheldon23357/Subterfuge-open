import type {AiMemory} from './types.js';
import {parseToolArguments} from './tool-arguments.js';

export type CommanderMode='discuss'|'reconcile';
export const commanderReplyRules={
  // Discussion strategy is a proposed commander directive, not AI strategy.
  discuss:{keys:['strategy'] as readonly (keyof AiMemory)[],strategyRequired:false,maxMemoryLength:6000},
  reconcile:{keys:['strategy'] as readonly (keyof AiMemory)[],strategyRequired:true,maxMemoryLength:1000},
};
const summaryLimit=1600;
const forbiddenSummary=/[\x00-\x08\x0b\x0c\x0e-\x1f]|```|^\s*[\[{]|"(?:request|arguments|tool)"\s*:/;
const object=(properties:Record<string,unknown>)=>({type:'object',additionalProperties:false,required:Object.keys(properties),properties});
/** Generation and host validation use the same mode, fields and text limits. */
export function commanderReplySchema(mode:CommanderMode){
  const rule=commanderReplyRules[mode];
  const memory=object(Object.fromEntries(rule.keys.map(key=>[key,key==='strategy'?{type:'string',maxLength:rule.maxMemoryLength}:{anyOf:[{type:'string',maxLength:rule.maxMemoryLength},{type:'null'}]}])));
  return object({request:object({tool:{type:'string',enum:['finish']},arguments:object({memory:rule.strategyRequired?memory:{anyOf:[memory,{type:'null'}]}})}),summary:{type:'string',minLength:1,maxLength:summaryLimit,description:'Natural-language reply for the player, without protocol JSON, code blocks or control characters.'},nextContext:{type:'null'}});
}
/** An isolated reply is data and is never dispatched as a game tool. */
export function parseCommanderResult(reply:{tool:string;arguments:unknown;summary:string;nextContext?:unknown},mode:CommanderMode){
  if(reply.tool!=='finish')throw Error('Discussion cannot execute tools');
  if(reply.nextContext!=null)throw Error('Unexpected discussion output: nextContext');
  const {args}=parseToolArguments(reply.arguments as string|Record<string,unknown>);
  const unexpected=Object.keys(args).filter(key=>key!=='memory');
  if(unexpected.length)throw Error('Unexpected discussion output: '+unexpected.join(', '));
  const memory=args.memory==null?{}:args.memory;
  if(!memory||typeof memory!=='object'||Array.isArray(memory))throw Error('Invalid discussion memory');
  const values=memory as Record<string,unknown>,rule=commanderReplyRules[mode];
  const invalid=Object.entries(values).filter(([key,value])=>!rule.keys.includes(key as keyof AiMemory)||typeof value!=='string'||value.length>rule.maxMemoryLength).map(([key])=>'memory.'+key);
  if(invalid.length)throw Error('Invalid discussion field: '+invalid.join(', '));
  const clean=Object.fromEntries(Object.entries(values).filter(([,value])=>value!==null)) as Partial<AiMemory>;
  if(mode==='discuss'&&clean.strategy&&(/^(?:准备合并后的完整指挥官指令|合并后的完整指挥官指令)(?:\s*[:：]|\s*$)/.test(clean.strategy.trim())||/玩家(?:再次)?确认后|等待玩家(?:再次)?确认/.test(clean.strategy)))throw Error('Proposal must contain actionable instructions without confirmation workflow');
  if(rule.strategyRequired&&typeof clean.strategy!=='string')throw Error('Missing revised strategy');
  const text=reply.summary.trim();
  if(!text||reply.summary.length>summaryLimit||forbiddenSummary.test(text))throw Error('Expected a natural-language reply');
  return {text,memory:clean};
}
