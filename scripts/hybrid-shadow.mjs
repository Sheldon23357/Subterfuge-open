/** Read-only tactical shadow over a saved, authorized PlayerObservation.
 * node scripts/hybrid-shadow.mjs INPUT_JSON OUTPUT_JSON [DIRECTIVE_JSON]
 * No model, game command, clock advance, live credential, or database is used.
 */
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {hybridMode} from '../dist/plugins/hybrid/src/index.js';
import {initialHybridState,scopeMatches} from '../dist/plugins/hybrid/src/contracts.js';
import {initialState} from '../dist/packages/ai/src/controller/contracts/types.js';
import {attackRoutes,forecastKnownPath} from '../dist/packages/prediction/src/index.js';
import {evaluateBotFrame} from '../dist/packages/ai/src/controller/analysis/tactical-evaluation.js';
import {resolveOutpostReferences} from '../dist/packages/ai/src/controller/presentation/outpost-references.js';
import {closeBotForecastPool} from '../dist/packages/ai/src/controller/analysis/tactical-forecast-pool.js';
const [source,output,directivePath,...extra]=process.argv.slice(2);if(!source||!output||extra.length||resolve(source)===resolve(output))throw Error('Expected INPUT OUTPUT [DIRECTIVE], output must differ');
const input=JSON.parse(readFileSync(source,'utf8')),o=input.observed??input.observation??input;
if(o.view?.format!=='player-observation/2'||!o.roomId)throw Error('Expected an authorized player observation');
const saved=initialHybridState();if(directivePath){saved.directive=JSON.parse(readFileSync(directivePath,'utf8'));if(!scopeMatches(saved.directive.basis,o))throw Error('Directive scope mismatch');}
const records=new Map([['state',saved]]),state=initialState(o.roomId,o.view.player,{mode:'hybrid',model:'',personality:'schemer'});state.enabled=true;state.sequence=1;
const snapshot={observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:o.view.player,chatCount:o.view.playerCount};
let result;try{result=await hybridMode.prepare({state,snapshot,history:[],feedback:[],efficiency:{cacheReports:true,cacheRoutes:true},suffix:'',routes:attackRoutes(o,{attackTicks:144,localTicks:144,holdTicks:24})}).run({prompt:'',model:'',signal:new AbortController().signal},{model:{step:async()=>{throw Error('Shadow cannot call a model');}},local:async(request,compute)=>compute(request),latest:name=>records.get(name),record:(name,value)=>records.set(name,value),markAssessed:()=>{}});}finally{closeBotForecastPool();}
const args=resolveOutpostReferences(structuredClone(result.reply.arguments),o),drafts=result.reply.tool==='batch'?args.actions.filter(a=>a.tool==='order').map((a,i)=>({id:'shadow-'+i,issueTick:o.view.tick,action:a.arguments.action})):[];
const compare={};for(const [name,orders]of [['hold',[]],['selected',drafts]]){const prediction=forecastKnownPath(o,{targetTick:o.view.tick+144,drafts:orders});compare[name]={status:prediction.forecast.status,...prediction.forecast.status==='conditional'?{score:evaluateBotFrame(o,prediction.forecast.result,prediction.path),terminal:prediction.forecast.result.terminalPrediction}: {reasons:prediction.forecast.reasons}};}
const report={format:'hybrid-shadow/1',basis:{roomId:o.roomId,player:o.view.player,revision:o.revision,tick:o.view.tick},modelSource:directivePath?'supplied-directive':'no-directive-fallback',proposed:result.reply,decision:records.get('decision'),feedback:records.get('feedback'),compare,limitations:['Read-only conditional tactical replay; no live effect','No AI diplomacy or full-game strength claim']};
mkdirSync(dirname(resolve(output)),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify({output,selected:report.feedback?.selected,tool:result.reply.tool,coverage:report.feedback?.coverage}));
