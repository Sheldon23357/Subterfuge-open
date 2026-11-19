import type {AiSettings} from './types.js';
import type {BotMode,BotModeDefinition,BotModeResolver,BotModeSummary} from './bot-mode.js';

/** Definitions are supplied by startup code or the trusted local plugin catalog. */
export class BotModeRegistry {
 private readonly definitions=new Map<string,BotModeDefinition>();
 private readonly issued=new WeakSet<BotMode>();
 private sealed=false;
 private readonly changing=new Set<string>();
 private readonly unavailable=new Map<string,string>();
 constructor(definitions:readonly BotModeDefinition[]=[]){for(const definition of definitions)this.register(definition);}
 register(definition:BotModeDefinition){
  if(this.sealed)throw Error('Bot mode registry is sealed');
  return this.install(definition);
 }
 /** Host-only installation of a new identity; updates require an explicit replacement. */
 install(definition:BotModeDefinition){
  if(!/^[a-z][a-z0-9-]{0,39}$/.test(definition.id)||this.definitions.has(definition.id)||!definition.label.trim())throw Error('Duplicate or invalid bot mode: '+definition.id);
  this.definitions.set(definition.id,Object.freeze({...definition,capabilities:Object.freeze({...definition.capabilities})}));return this;
 }
 /** A failed local plugin remains selectable for diagnosis, but cannot acquire control. */
 markUnavailable(id:string,message:string){
  if(this.definitions.has(id))return;
  const fail=()=>{throw Error('Plugin unavailable: '+message);};
  this.install({id,label:id+'（不可用）',capabilities:{model:true,commander:true},validateConfig:()=>{},create:()=>({
   id,recordPrefix:'mode-'+id,usesModelProvider:true,supportsCommander:true,automaticEventCoalesceMs:undefined,
   retainSignals:signals=>signals,needsAnalysis:()=>false,prepare:fail,
  })});this.unavailable.set(id,message);
 }
 assertAvailable(id:string){if(this.changing.has(id))throw Error('Plugin update is in progress');const message=this.unavailable.get(id);if(message)throw Error('Plugin unavailable: '+message);}
 beginChange(id:string){if(this.changing.has(id))throw Error('Plugin cannot be changed');this.changing.add(id);return ()=>this.changing.delete(id);}
 replace(definition:BotModeDefinition){
  if(!this.definitions.has(definition.id))throw Error('Unknown replaceable plugin');
  this.definitions.set(definition.id,Object.freeze({...definition,capabilities:Object.freeze({...definition.capabilities})}));this.unavailable.delete(definition.id);
 }
 list():BotModeSummary[]{return [...this.definitions.values()].map(({id,label,capabilities})=>({id,label,capabilities:{...capabilities}}));}
 validate(settings:AiSettings){
  if(settings.provider==='programmatic')throw Error('Unsupported bot provider');
  const definition=this.definitions.get(settings.mode??'hybrid');
  if(!definition)throw Error('Unknown bot mode: '+settings.mode);
  definition.validateConfig(settings.strategyConfig);
  return definition;
 }
 resolver():BotModeResolver{
  this.sealed=true;
  const instances=new WeakMap<object,{id:string;configKey:string|undefined;definition:BotModeDefinition;mode:BotMode}>();
  return (settings,owner=settings)=>{
   const definition=this.validate(settings),previous=instances.get(owner),configKey=JSON.stringify(settings.strategyConfig);
   if(previous?.definition===definition&&previous.configKey===configKey)return previous.mode;
   const mode=definition.create(structuredClone(settings.strategyConfig));
   if(!mode||typeof mode.prepare!=='function'||typeof mode.needsAnalysis!=='function'||typeof mode.retainSignals!=='function')throw Error('Invalid bot mode hooks');
   for(const hook of ['afterAction','communicate','onReceipt','commanderPrompt','createBackground','beforeExecute','diagnostics'] as const){if(mode[hook]!==undefined&&typeof mode[hook]!=='function')throw Error('Invalid bot mode hook: '+hook);}
   if(mode.id!==definition.id||mode.recordPrefix!=='mode-'+definition.id||mode.usesModelProvider!==definition.capabilities.model||mode.supportsCommander!==definition.capabilities.commander||this.issued.has(mode))throw Error('Invalid or shared bot mode instance: '+definition.id);
   this.issued.add(mode);instances.set(owner,{id:definition.id,definition,configKey,mode});return mode;
  };
 }
}
