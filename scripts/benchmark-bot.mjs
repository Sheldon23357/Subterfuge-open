/** Isolated authoritative games. Planners receive only player observations.
 * Usage: node scripts/benchmark-bot.mjs --seed=4300 --players=4 --ticks=1440
 *   --simulations=96 --opponent=greedy --seat=0 --out=artifacts/bot-benchmark/run.json
 * No running room, credentials, models, or network are used. */
import {mkdirSync,writeFileSync,appendFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {createGeneratedRoom} from '../dist/packages/server/src/generated-room.js';
import {observation} from '../dist/packages/server/src/player-api.js';
import {attackRoutes} from '../dist/packages/prediction/src/index.js';
import {advanceRoom,saveRoom} from '../dist/packages/server/src/planning.js';
import {scheduleOrder} from '../dist/packages/server/src/scheduled-orders.js';
import {submitFleetOrder,fleetStandings,fleetMatchOutcome} from '../dist/packages/engine/src/index.js';
import {planBot} from '../dist/packages/ai/src/controller/local/bot-planner.js';
import {scheduledCommitments} from '../dist/packages/ai/src/controller/analysis/scheduled-commitments.js';

const args=Object.fromEntries(process.argv.slice(2).map(value=>{const match=/^--([^=]+)=(.+)$/.exec(value);if(!match)throw Error('Expected --key=value');return [match[1],match[2]];}));
if(Object.keys(args).some(key=>!['seed','players','ticks','simulations','opponent','seat','out','mode','interval','maxMs'].includes(key)))throw Error('Unknown option');
const seed=Number(args.seed??4300),players=Number(args.players??4),ticks=Number(args.ticks??1440),simulations=Number(args.simulations??96),seat=Number(args.seat??0),interval=Number(args.interval??6);
const maxMs=Number(args.maxMs??10000);if(!Number.isFinite(maxMs)||maxMs<1||maxMs>60000)throw Error('Invalid time budget');
if(![seed,players,ticks,simulations,seat,interval].every(Number.isSafeInteger)||players<2||players>10||ticks<1||ticks>10000||simulations<2||simulations>512||seat<0||seat>=players||interval<1||interval>24)throw Error('Invalid benchmark range');
const opponent=args.opponent??'self',mode=args.mode??'mining';if(!['self','greedy'].includes(opponent)||!['mining','domination'].includes(mode))throw Error('Invalid benchmark mode');
const output=resolve(args.out??`artifacts/bot-benchmark/${seed}-${players}-${mode}-${opponent}-${seat}.json`);
mkdirSync(dirname(output),{recursive:true});
const trace=output.replace(/\.json$/, '')+'.decisions.jsonl';
writeFileSync(trace,'');
let room=await createGeneratedRoom(players,seed,'original',{mode});
const stats=Array.from({length:players},(_,player)=>({player,policy:opponent==='self'||player===seat?'bot':'greedy',decisions:0,holds:0,operations:0,rejected:0,simulations:0,computeMs:0,objectives:{},errors:[]}));
const snapshots=[],incumbents=new Map(),scouted=new Map();let orderSequence=0;
function greedy(o,routes){
  const v=o.view,commitments=new Map(scheduledCommitments(o).map(c=>[c.source,c]));
  const own=v.outposts.filter(p=>p.owner===v.player&&!p.destroyed),available=p=>Math.max(0,(p.drillers??0)-(commitments.get(p.id)?.drillers??0));
  const targets=v.outposts.filter(p=>p.owner!==v.player&&!p.destroyed&&p.visibility===2);
  const pairs=own.flatMap(source=>targets.flatMap(target=>{
    const eta=routes.postTicks[source.id]?.[target.id],force=(target.drillers??Infinity)+(target.shield??Infinity)+5;
    return eta!==null&&eta!==undefined&&available(source)>force+10&&!v.fleets.some(f=>f.owner===v.player&&f.destination?.id===target.id)?[{source,target,eta,force}]:[];
  })).sort((a,b)=>a.eta-b.eta||a.force-b.force);
  if(pairs.length){const p=pairs[0];return [{issueTick:v.tick,action:{kind:'launch',source:p.source.id,destination:p.target.id,drillers:p.force}}];}
  if(mode==='mining'){
    const post=own.find(p=>p.type!=='mine'&&!p.minePending&&available(p)>v.self.mineCreationCost+30);
    if(post)return [{issueTick:v.tick,action:{kind:'toggle-mine',outpostId:post.id}}];
  }
  return [];
}
const started=performance.now();
for(let tick=0;tick<=ticks&&!fleetMatchOutcome(room.state);tick+=interval){
  room=advanceRoom(room,tick);
  if(fleetMatchOutcome(room.state))break;
  for(let index=0;index<players;index++){
    const player=(index+Math.floor(tick/interval))%players,row=stats[player];
    if(!room.state.economy.players[player].active)continue;
    // Same mechanical check-in for both policies; activity maintenance is
    // tested separately in the actual runner, not a confounding win condition.
    room={...room,state:submitFleetOrder(room.state,{id:`activity-${orderSequence++}`,player,action:{kind:'check-in'}}).state};
    const o=observation(room,player,'isolated-bot-benchmark'),routes=attackRoutes(o,{attackTicks:144,localTicks:144,holdTicks:24});
    const begin=performance.now();let drafts;
    if(row.policy==='bot'){
      const decision=planBot(o,routes,{maxSimulations:simulations,maxElapsedMs:maxMs,scoutedTargets:scouted.get(player)??[],...incumbents.has(player)?{incumbentObjective:incumbents.get(player)}:{}});
      if(decision.selected.kind==='scout')scouted.set(player,[...new Set([...(scouted.get(player)??[]),...decision.selected.targets])]);
      drafts=decision.selected.drafts;incumbents.set(player,decision.selected.objective);row.simulations+=decision.coverage.simulations;
      row.objectives[decision.selected.kind]=(row.objectives[decision.selected.kind]??0)+1;
      // Append immediately so a long-running or interrupted match still has
      // evidence of why it held. No hidden world is passed into the planner.
      appendFileSync(trace,JSON.stringify({tick,player,selected:decision.selected,coverage:decision.coverage,
        assessments:decision.assessments.map(a=>({id:a.candidate.id,kind:a.candidate.kind,objective:a.candidate.objective,status:a.status,
          score:a.score,stress:a.stress,reasons:a.reasons,stressCases:a.stressCases}))})+'\n');
    }else drafts=greedy(o,routes);
    row.computeMs+=performance.now()-begin;row.decisions++;if(!drafts.length)row.holds++;
    for(const draft of drafts){
      const order={id:`benchmark-${orderSequence++}`,player,action:draft.action};
      try{room=draft.issueTick>tick?scheduleOrder(room,{order,issueTick:draft.issueTick}):{...room,state:submitFleetOrder(room.state,order).state};row.operations++;}
      catch(error){row.rejected++;row.errors.push({tick,action:draft.action,message:String(error)});break;}
    }
    if(fleetMatchOutcome(room.state))break;
  }
  if(tick%Math.max(interval,48)===0){
    const snapshot={tick,players:stats.map(row=>{const v=observation(room,row.player,'isolated-bot-benchmark').view;return {player:row.player,active:v.self.active,outposts:v.self.outpostCount,drillers:v.self.drillers,capacity:v.self.capacity,neptunium:v.self.neptunium,mines:v.outposts.filter(p=>p.owner===row.player&&p.type==='mine'&&!p.destroyed).length};})};
    snapshots.push(snapshot);process.stdout.write(JSON.stringify(snapshot)+'\n');
    writeFileSync(output.replace(/\.json$/, '')+'.checkpoint.room.json',saveRoom(room));
  }
}
const report={format:'bot-benchmark/1',seed,players,mode,opponent,seat,simulations,maxMs,interval,requestedTicks:ticks,actualTick:room.state.economy.tick,completed:!!fleetMatchOutcome(room.state),standings:fleetStandings(room.state),elapsedMs:performance.now()-started,stats,snapshots,
  scheduleFailures:(room.scheduledOrders??[]).filter(s=>s.status==='failed'),limitations:['Finite isolated seeds, not an estimated general win rate','Decision-core harness; transport has separate integration tests','Greedy baseline is intentionally simple','Both sides receive identical check-in maintenance']};
mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2));
writeFileSync(output.replace(/\.json$/, '')+'.room.json',saveRoom(room));
process.stdout.write(JSON.stringify({output,completed:report.completed,tick:report.actualTick,elapsedMs:report.elapsedMs,stats})+'\n');
