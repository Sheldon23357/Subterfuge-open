/** Static upper bounds, not authorization: argument validators, commander
 * checks, receipts and CAS still decide whether a particular call may commit. */
export interface ToolMetadata {
  name:string;
  wireShape:'json-string'|'structured';
  effect:'read'|'private-state'|'game-command'|'chat';
  commit:'receipt'|'local-cas'|'remote';
}
type Options=Partial<Pick<ToolMetadata,'wireShape'>>;
const read=(options:Options={}):Omit<ToolMetadata,'name'>=>({wireShape:'json-string',effect:'read',commit:'receipt',...options});
const local=(options:Options={}):Omit<ToolMetadata,'name'>=>({...read(),effect:'private-state',commit:'local-cas',...options});
const remote=(effect:'game-command'|'chat'):Omit<ToolMetadata,'name'>=>({...read(),effect,commit:'remote'});
const definitions={
  notebook:local(),
  reminders:local(),
  order:remote('game-command'),
  batch:remote('game-command'),
  say:remote('chat'),
  finish:local({wireShape:'structured'}),
} satisfies Record<string,Omit<ToolMetadata,'name'>>;
export type ToolName=keyof typeof definitions;
export const TOOL_METADATA:Readonly<Record<ToolName,Readonly<ToolMetadata>>>=Object.freeze(Object.fromEntries(
  Object.entries(definitions).map(([name,metadata])=>[name,Object.freeze({name,...metadata})]),
) as Record<ToolName,Readonly<ToolMetadata>>);
export const TOOL_NAMES=Object.freeze(Object.keys(TOOL_METADATA) as ToolName[]);
export function toolMetadata(name:string):Readonly<ToolMetadata>|undefined {
  return Object.hasOwn(TOOL_METADATA,name)?TOOL_METADATA[name as ToolName]:undefined;
}
export function toolNamesWhere(predicate:(metadata:Readonly<ToolMetadata>)=>boolean):string[] {
  return TOOL_NAMES.filter(name=>predicate(TOOL_METADATA[name as ToolName]));
}
