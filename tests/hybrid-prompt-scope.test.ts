import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {initialState,type AiSnapshot} from '../packages/ai/src/controller/contracts/types.js';
import {initialHybridState} from '../plugins/hybrid/src/contracts.js';
import {makeBrief} from '../plugins/hybrid/src/brief.js';
import {permanentRules,hybridCommanderInstructions} from '../plugins/hybrid/src/prompts.js';
import {readPromptSections} from '../packages/contracts/src/index.js';

function fixture(){
 const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 setup.match={mode:'mining',neptuniumGoal:200};
 const o=observation({state:createFleetScenario(setup),scheduled:[]},0,'prompt-scope');
 const snapshot:AiSnapshot={observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};
 return {snapshot,state:initialState(o.roomId,0,{mode:'hybrid',model:'mock',personality:'schemer'})};
}

test('strategic rules retain economic tradeoffs without teaching settlement or executor internals',()=>{
 const {snapshot}=fixture(),text=permanentRules(snapshot);
 assert.match(text,/200kg获胜/);
 for(const consequence of ['不释放总容量','牺牲该点原产能或容量','夺回不返还','损失一半兵力','攻防预测'])assert.ok(text.includes(consequence),consequence);
 assert.doesNotMatch(text,/规则秒|第0天|每次结算推进|采矿进度|floor\(|调度锁|签到|manualReview|deploy、forecast|必须携带正数兵力/);
});

test('all actual background roles use program forecasts while retaining the model output contract',()=>{
 const {snapshot,state}=fixture();
 for(const kind of ['strategy','diplomacy','commander'] as const){
  const material=makeBrief({id:'scope-'+kind,kind,scope:'overview',posts:[],messageIds:[],players:[]},state,snapshot,initialHybridState());
  assert.match(material.prompt,/前台程序与模型并行/);
  assert.match(material.prompt,/实际结果以程序反馈为准/);
  if(kind==='diplomacy'){assert.equal(material.permissions.maxTasks,0);assert.match(material.prompt,/maxTasks或maxCancel为0时/);}
  else assert.match(material.prompt,/capture\/configure\/transfer无论新增还是更新都必须填写priority/);
  assert.doesNotMatch(material.prompt,/调度锁：|每次结算推进|承诺\/4|缺口\/4|换工具重复核验/);
  assert.ok(material.responseSchema.properties);
 }
 for(const mode of ['discuss','reconcile'] as const){
  const text=hybridCommanderInstructions(mode);
  assert.match(text,/仅对当前问题明确涉及的目标或对手提供attackAssessment程序初筛结论/);
  assert.match(text,/新指令由玩家确认/);
  if(mode==='discuss'){
   assert.match(text,/提案正文只合并confirmedDirectives.text中的已确认要求和当前玩家明确提出的变更/);
   assert.match(text,/当前已确认正文为空时，不存在需要保留的旧指令/);
  }
  assert.doesNotMatch(text,/调用forecast|调用compare|调用deploy/);
 }
});

test('background task review rules have one home while commander translation keeps its own guidance',()=>{
 const {snapshot,state}=fixture();
 for(const kind of ['strategy','diplomacy','commander'] as const){
  const {prompt}=makeBrief({id:'review-'+kind,kind,scope:'overview',posts:[],messageIds:[],players:[]},state,snapshot,initialHybridState());
  const sections=readPromptSections(prompt)!;
  const summary=sections.find(s=>s.id==='instructions.summary')!.text;
  assert.match(summary,/新的可核验解除条件/);
  const review=sections.filter(s=>['instructions.summary','instructions.data'].includes(s.id)).map(s=>s.text).join('\n');
  assert.equal((review.match(/长期pending\/blocked/g)??[]).length,1);
  if(kind==='commander')assert.match(summary,/投入上限低于静态成本或初筛估算/);
  else{
   assert.doesNotMatch(summary,/长期pending\/blocked/);
   assert.match(sections.find(s=>s.id==='instructions.data')!.text,/兵力上限低于静态成本或初筛估算/);
  }
 }
});
