import type {ChatMessage,GameScenarioInfo} from '../../contracts/src/index.js';
import type {AiMemory} from '../../ai/src/index.js';
import type {FleetOrder,FleetScenario,FleetSetup} from '../../engine/src/index.js';

export type EndgameScenarioId='expansion-conflict'|'broken-truce'|'resource-race';
export interface EndgamePreset extends GameScenarioInfo {
  id:EndgameScenarioId;
  applySetup(setup:FleetSetup,mode:'mining'|'domination'):void;
  orders(state:FleetScenario):FleetOrder[];
  messages(players:number):ChatMessage[];
  memory(seat:number,players:number):AiMemory;
}

const posts=(setup:FleetSetup,owner:number)=>setup.economy.outposts.filter(o=>o.owner===owner&&!o.destroyed);
const neutral=(setup:FleetSetup)=>setup.economy.outposts.filter(o=>o.owner===null&&!o.destroyed);
function resetEconomy(setup:FleetSetup,tick:number){
  setup.economy.initialTick=tick;
  setup.economy.players.forEach((p,i)=>{p.active=true;p.neptunium=4+i%3;p.minesCreated=0;});
  for(const o of setup.economy.outposts){if(o.owner===null){o.type='factory';o.drillers=14;}else{o.drillers=64;o.shield=Math.min(o.shieldMax,12);}}
}
function claim(setup:FleetSetup,owner:number,count:number){
  for(const o of neutral(setup).slice(0,count)){o.owner=owner;o.type='factory';o.drillers=34;o.shield=Math.min(o.shieldMax,10);}
}
function mine(setup:FleetSetup,owner:number,count:number){
  for(const o of posts(setup,owner).filter(o=>o.type!=='mine').slice(-count)){o.type='mine';o.drillers=Math.max(o.drillers,28);o.miningProgress=0;setup.economy.players[owner]!.minesCreated++;}
}
function source(state:FleetScenario,owner:number){return state.economy.outposts.find(o=>o.owner===owner&&o.type==='factory'&&o.drillers>=20)??state.economy.outposts.find(o=>o.owner===owner&&o.drillers>=20);}
function orders(state:FleetScenario,pairs:[number,number][],prefix:string):FleetOrder[]{
  return pairs.flatMap(([from,to],i)=>{const s=source(state,from),d=state.economy.outposts.find(o=>o.owner===to&&o.type!=='mine');if(!s||!d)return[];return[{id:`scenario-${prefix}-${i}`,player:from,action:{kind:'launch',source:s.id,destination:d.id,drillers:Math.min(18,Math.max(1,s.drillers-1))}}];});
}

function messages(id:EndgameScenarioId,players:number):ChatMessage[]{
  const rows:Omit<ChatMessage,'sentAt'>[] = id==='expansion-conflict' ? [
    {id:'scenario-expansion-1',from:0,to:1,text:'我已经拿下05，接下来会把主力放在09。你若准备走北侧，先给我一个明确边界。',tick:3},
    {id:'scenario-expansion-2',from:1,to:0,text:'09我暂时不碰，但05不是你的永久保留区。先按12世界天观察，谁先出现增援谁承担争议。',tick:4},
    {id:'scenario-expansion-3',from:0,to:null,text:'北侧边界暂定05—09，协议只覆盖当前舰队，不等于长期停战。',tick:5},
  ] : id==='broken-truce' ? [
    {id:'scenario-truce-1',from:0,to:1,text:'我们约定到第12 tick前不碰14。你要改条件，现在说，不要让舰队替你发言。',tick:8},
    {id:'scenario-truce-2',from:1,to:0,text:'14仍在我的计划里，但我没有承诺永远放弃。第12 tick后重新谈，之前不会主动越线。',tick:8},
    {id:'scenario-truce-3',from:0,to:1,text:'我看到你向14调了增援。若那是防守，请说明；若是抢点，协议从这一刻算破。',tick:11},
    {id:'scenario-truce-4',from:1,to:null,text:'关于14的协议已经失去约束力，之后各自承担出兵风险。',tick:12},
  ] : [
    {id:'scenario-race-1',from:2,to:0,text:'你在18上投入了大笔资源，我在南线有更快的工厂。可以交换一轮情报，但不会替你守住那条线。',tick:10},
    {id:'scenario-race-2',from:0,to:2,text:'情报可以谈：你不碰21，我把18的增援窗口留到第20 tick。条件是你先说明舰队方向。',tick:10},
    {id:'scenario-race-3',from:2,to:0,text:'我不接受先交底。你先把21让出来，我再考虑是否共享抵达时间。',tick:11},
    {id:'scenario-race-4',from:0,to:null,text:'资源领先不等于安全。南线的交换只到第20 tick，之后我会重新评估。',tick:12},
  ];
  const base=1_700_000_000_000;
  return rows.filter(m=>m.from<players&&(m.to===null||(Array.isArray(m.to)?m.to.every(p=>p<players):m.to<players))).map((m,i)=>({...m,sentAt:base+m.tick*600_000+i}));
}

function memoryFor(id:EndgameScenarioId,seat:number):AiMemory{
  const rival=seat===0?1:0;
  const prefix=id==='expansion-conflict'?'当前处于扩张冲突残局，先稳住已占据点，再判断05/09边界。':id==='broken-truce'?'当前处于停战破裂残局，14的协议状态必须以最近一次舰队行动核对。':'当前处于资源竞速残局，18/21的资源交换只服务于扩大胜率，不把情报交换当成友谊。';
  return {strategy:prefix+' 当前 tick 已在残局中，优先处理已出发舰队和近期协议。',relations:`席位${rival+1}是主要外交对象。关系依据来自残局开局记录；不要把礼貌回复当成接受协议。`,agreements:id==='broken-truce'?'曾有一份关于14的限时安排，已到或接近复查窗口，必须引用具体 tick。':'当前只有有限边界提议，没有默认长期停战。',deceptions:'本人的真实目标与对外说法分开保存；不要把这段私密记录转发给其他玩家。'};
}

const PRESETS:EndgamePreset[]=[
  {id:'expansion-conflict',title:'扩张冲突',description:'部分中立据点已经被占领，北侧边界正在形成。',startTick:6,applySetup(setup){resetEconomy(setup,6);for(let p=0;p<setup.economy.players.length;p++)claim(setup,p,1);},orders(state){return orders(state,[[0,1],[1,0]],'expansion');},messages(players){return messages('expansion-conflict',players);},memory(seat){return memoryFor('expansion-conflict',seat);}},
  {id:'broken-truce',title:'协议破裂',description:'一份限时边界协议接近失效，争议据点已有舰队动作。',startTick:12,applySetup(setup,mode){resetEconomy(setup,12);for(let p=0;p<setup.economy.players.length;p++)claim(setup,p,1);if(mode==='mining'){mine(setup,0,1);if(setup.economy.players.length>1)mine(setup,1,1);}},orders(state){return orders(state,[[0,1],[1,0]],'truce');},messages(players){return messages('broken-truce',players);},memory(seat){return memoryFor('broken-truce',seat);}},
  {id:'resource-race',title:'资源竞速',description:'部分阵营已经取得资源领先，领先者与军事反击者都还没有锁定胜局。',startTick:18,applySetup(setup,mode){resetEconomy(setup,18);for(let p=0;p<setup.economy.players.length;p++)claim(setup,p,p%2?1:2);if(mode==='mining'){mine(setup,0,2);if(setup.economy.players.length>1)mine(setup,1,1);setup.economy.players[0]!.neptunium=18;if(setup.economy.players[1])setup.economy.players[1]!.neptunium=11;}},orders(state){return orders(state,[[2,0],[0,1]],'race');},messages(players){return messages('resource-race',players);},memory(seat){return memoryFor('resource-race',seat);}},
];

export function chooseEndgameScenario(seed:number,players:number):EndgamePreset{
  const mixed=(Math.imul(seed>>>0,0x45d9f3b)+players*0x9e3779b9)>>>0;
  return PRESETS[mixed%PRESETS.length]!;
}
export function endgameScenario(id:string):EndgamePreset|undefined{return PRESETS.find(p=>p.id===id);}
export function endgameScenarioInfo(id:string):GameScenarioInfo|undefined{const p=endgameScenario(id);return p?{id:p.id,title:p.title,description:p.description,startTick:p.startTick}:undefined;}
export function scenarioMessages(id:string,players:number){const p=endgameScenario(id);return p?p.messages(players):[];}
export function scenarioMemory(id:string,seat:number,players:number){const p=endgameScenario(id);return p?.memory(seat,players);}
export function applyEndgameScenario(setup:FleetSetup,mode:'mining'|'domination',preset:EndgamePreset){preset.applySetup(setup,mode);}
export function endgameOrders(state:FleetScenario,id:string){return endgameScenario(id)?.orders(state)??[];}
export function listEndgameScenarios(){return PRESETS.map(({id,title,description,startTick})=>({id,title,description,startTick}));}
