import type {BotModeDefinition} from '@subterfuge/bot-sdk/contracts/bot-mode';
import {buildLocalModeContext} from '@subterfuge/bot-sdk/contracts/local-mode-context';

const definition:BotModeDefinition={
 id:'minimal-bot',label:'Minimal bot',capabilities:{model:false,commander:false},
 validateConfig(config){if(config!==undefined&&config!==null)throw Error('This example accepts no strategyConfig');},
 create(){return {
  id:'minimal-bot',recordPrefix:'mode-minimal-bot',usesModelProvider:false,supportsCommander:false,
  automaticEventCoalesceMs:undefined,retainSignals:signals=>signals,needsAnalysis:()=>true,
  prepare(input){return {
   context:buildLocalModeContext(input.state,input.snapshot,'Review authorized facts without issuing orders'),
   run:(request,services)=>services.local(request,async admitted=>{
    admitted.signal.throwIfAborted();
    const o=input.snapshot.observation;
    services.record('review',{tick:o.view.tick,player:o.view.player,visibleOutposts:o.view.outposts.length});
    services.markAssessed();
    return {tokens:0,reply:{tool:'finish',arguments:{},summary:'Example review completed; no gameplay order proposed.'}};
   }),
  };},
  afterAction:()=>({tokens:0,reply:{tool:'finish',arguments:{},summary:'Action receipts recorded; wait for the next round.'}}),
  diagnostics:({latest})=>({lastReview:latest('review')??null}),
 };},
};
export default definition;
