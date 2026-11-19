// Isolated real-provider A/B. Never opens or writes the live room database.
// npm run build; node scripts/verify-ai-analysis-efficiency.mjs baseline|optimized
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {once} from 'node:events';
import {resolve} from 'node:path';
import {createFleetScenario,advanceFleetScenario,fleetOriginalTotals} from '../dist/packages/engine/src/index.js';
import {createPlayerApi} from '../dist/packages/server/src/player-api.js';
import {PlayerAccess,SerialExecutor} from '../dist/packages/server/src/player-access.js';
import {ChatStore} from '../dist/packages/server/src/chat.js';
import {AiStore,SeatRunner,initialState,PlayerGateway,CodexProvider} from '../dist/packages/ai/src/index.js';

const mode=process.argv[2];if(!['baseline','optimized'].includes(mode))throw Error('Use baseline|optimized');
const directory=resolve('artifacts/ai-analysis-efficiency',`${mode}-${Date.now()}`);mkdirSync(directory,{recursive:true});
const config={cacheReports:mode==='optimized',cacheRoutes:mode==='optimized'};
writeFileSync(`${directory}/config.json`,JSON.stringify(config));process.env.AI_ANALYSIS_EFFICIENCY_CONFIG=`${directory}/config.json`;
const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial;
setup.economy.initialTick=0;setup.size={width:40,height:40};
setup.positions={'蓝方工厂':{x:0,y:0},'红方矿场':{x:8,y:0},'红方后方':{x:9,y:0}};
const template=setup.economy.outposts[2];
for(const [id,x] of [['安全甲',.1],['安全乙',.2],['安全丙',.3],['争议点',4]]){
 setup.positions[id]={x,y:0};setup.economy.outposts.push({...template,id,owner:null,type:'generator'});
}
let room={state:createFleetScenario(setup),scheduled:[]};
const credentials=PlayerAccess.generate(2),access=new PlayerAccess(credentials),chat=new ChatStore(`${directory}/chat.json`);
const api=createPlayerApi({room:()=>room,access:()=>access,serial:new SerialExecutor(),chat:()=>chat,save:async next=>{room=next;}});
api.listen(0,'127.0.0.1');await once(api,'listening');
const store=new AiStore(`${directory}/ai.sqlite`),state=initialState(access.roomId,0,{model:'',personality:'raider'}),events=[];
const save=store.save.bind(store);store.save=(...args)=>{events.push({kind:args[1],payload:args[2]});return save(...args);};
try{
 const gateway=new PlayerGateway(`http://127.0.0.1:${api.address().port}`,credentials.credentials[0].token,access.roomId,0,2);
 const provider=new CodexProvider(process.env.CODEX_EXECUTABLE??'codex',120000);
 await new SeatRunner(state,store,gateway,{step:async request=>{
   writeFileSync(`${directory}/prompt-${state.calls}.txt`,request.prompt);
   const result=await provider.step(request);console.log(JSON.stringify({mode,call:state.calls,tool:result.reply.tool,summary:result.reply.summary}));return result;
 }}).poll(0);
 const simulation=advanceFleetScenario(room.state,144);
 const result={mode,status:state.status,error:state.error,calls:state.calls,tokens:state.tokens,
  promptCharacters:events.filter(e=>e.kind==='call-reserved').reduce((n,e)=>n+e.payload.promptCharacters,0),
  analyses:events.filter(e=>e.kind==='analysis-cache').map(e=>e.payload),
  tools:events.filter(e=>['tool-intent','tool-rejected'].includes(e.kind)),
  reminders:store.reminders(access.roomId,0),memory:state.memory,orders:room.state.commands,
  conditionalTick144:fleetOriginalTotals(simulation)};
 writeFileSync(`${directory}/result.json`,JSON.stringify(result,null,2));console.log(JSON.stringify({directory,...result,tools:undefined,memory:undefined,orders:undefined}));
}finally{store.close();await new Promise(r=>api.close(r));}
