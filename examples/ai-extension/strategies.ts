import {BotModeRegistry,buildLocalModeContext,type BotMode,type BotModeDefinition,type AgentResult} from '../../packages/ai/src/extension.js';
import {defineHybridMode,hybridDefinition,hybridBriefPrompt,computeBot,botStep} from '../../plugins/hybrid/src/api.js';
import {encodePromptSections,readPromptSections} from '../../packages/contracts/src/index.js';

const finish=(summary:string):AgentResult=>({tokens:0,reply:{tool:'finish',arguments:{},summary}});
/** An intentionally simple policy: disable one owned factory's shields per round. */
export const factoryPolicy:BotModeDefinition={
 id:'factory-policy',label:'工厂策略示例',capabilities:{model:false,commander:false},
 validateConfig:config=>{if(config!==undefined)throw Error('Factory policy does not accept strategyConfig');},
 create:():BotMode=>({
  id:'factory-policy',recordPrefix:'mode-factory-policy',usesModelProvider:false,supportsCommander:false,
  automaticEventCoalesceMs:undefined,retainSignals:signals=>signals,needsAnalysis:()=>false,
  afterAction:()=>finish('本轮操作已核对，等待下一轮。'),
  diagnostics:({latest})=>({strategyDetails:latest('last-choice')??null}),
  prepare:input=>({context:buildLocalModeContext(input.state,input.snapshot,'工厂策略示例'),
   run:async(request,services)=>services.local(request,async admitted=>{
    admitted.signal.throwIfAborted();
    if(services.latest<{sequence:number}>('last-choice')?.sequence===input.state.sequence)return finish('本轮建议已处理，后续操作等待下一轮。');
    const observation=input.snapshot.observation;
    const post=observation.view.outposts.find(p=>p.owner===observation.view.player&&!p.destroyed&&p.type==='factory'&&p.shieldsEnabled&&observation.outpostNames?.[p.id]);
    services.record('last-choice',{outpost:post?.id??null,tick:input.snapshot.observation.view.tick});
    return post?{tokens:0,executionObservation:observation,reply:{tool:'order',arguments:{action:{kind:'set-shields',outpostId:observation.outpostNames![post.id]!,enabled:false}},summary:'关闭一处己方工厂护盾。'}}:finish('没有符合条件的己方工厂。');
   })}),
 }),
};

/** Same official safeguards, with independently edited prompt and planner components. */
export const customHybrid=defineHybridMode({
 id:'custom-hybrid',
 briefPrompt:(...args)=>{
  const sections=readPromptSections(hybridBriefPrompt(...args));
  if(!sections)throw Error('Expected structured hybrid prompt');
  return encodePromptSections(sections.map(section=>section.id.startsWith('instructions.')?{...section,text:section.text+'\n本示例优先解释守住工厂与扩大产能之间的取舍。'}:section));
 },
 planner:(observation,routes,options)=>computeBot(observation,routes,{...options,maxSimulations:Math.min(options?.maxSimulations??64,64)}),
 localPlanner:(...args)=>botStep(...args),
},'自定义协同示例');

export function exampleRegistry(){return new BotModeRegistry([hybridDefinition,factoryPolicy,customHybrid]);}
