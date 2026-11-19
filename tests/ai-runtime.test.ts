import {SeatRunner} from './helpers/scripted-controller.js';
import {protocolHarness,createOwnerPlayerApi} from './player-protocol-test-helpers.js';
import {expandGarrisonContext} from '../packages/ai/src/controller/presentation/garrison-context.js';
import {ProviderError,classifyProviderFailure} from '../packages/ai/src/controller/contracts/provider-error.js';
import {classifyChanges} from '../packages/ai/src/controller/runtime/decision.js';
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";import {AiStore,initialState,executeTool,parseCodexOutput,codexArguments,PlayerGateway,GameTransportError,GameRequestError,type AgentProvider,type AiSnapshot,type GameGateway} from "../packages/ai/src/index.js";
import {
  createFleetScenario,
  submitFleetOrder,
  type FleetSetup,
} from "../packages/engine/src/index.js";
import {
  observation,
  createPlayerApi,
} from "../packages/server/src/player-api.js";
import {
  PlayerAccess,
  SerialExecutor,
} from "../packages/server/src/player-access.js";
import { ChatStore } from "../packages/server/src/chat.js";
import type { LabRoom } from "../packages/server/src/planning.js";

const settings = {
  model: "",
  personality: "schemer" as const,
};
test('AI roster uses chat usernames and preserves compacted gameplay identities',async()=>{
  for(const mapping of [undefined,[{chatPlayer:0,gamePlayer:0},{chatPlayer:7,gamePlayer:1}]]){
    const gateway=new PlayerGateway('http://unused','token','room',0,mapping?8:2,mapping);
    gateway.request=async(path)=>path==='/tool/observation'?{}:path.startsWith('/tool/chat')?{messages:[],nextCursor:0}:{notifications:[],nextCursor:0};
    const snapshot=await gateway.snapshot(0,0);
    assert.deepEqual(snapshot.roster,mapping?[
      {chatPlayer:0,gamePlayer:0,displayName:'北辰'},
      {chatPlayer:7,gamePlayer:1,displayName:'翡翠'},
    ]:[
      {chatPlayer:0,gamePlayer:0,displayName:'北辰'},
      {chatPlayer:1,gamePlayer:1,displayName:'赤潮'},
    ]);
  }
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "subterfuge-ai-test-")),
    store = new AiStore(join(dir, "ai.sqlite"));
  const cfg = JSON.parse(readFileSync("examples/fleet-lab.json", "utf8"))
    .initial as FleetSetup;
  const room: LabRoom = { state: createFleetScenario(cfg), scheduled: [] };
  const snapshot: AiSnapshot = {
    observation: observation(room, 0, "room"),
    chat: [],
    notifications: [],
    chatCursor: 0,
    notificationCursor: 0,
    chatPlayer: 0,
    chatCount: 2,
  };
  const requests: { path: string; data: unknown }[] = [];
  const gateway: GameGateway = {
    snapshot: async () => structuredClone(snapshot),
    request: async (path, data) => {
      requests.push({ path, data });
      return snapshot.observation;
    },
  };
  const state = initialState("room", 1, settings);
  store.save(state);
  return {
    dir,
    store,
    room,
    snapshot,
    gateway,
    requests,
    state,
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const response = (tool: string, args: unknown) => ({
  reply: { tool, arguments: JSON.stringify(args), summary: "测试决策" },
  tokens: 20,
});

test('remote ownership changes are deferred while threats to own outposts are urgent',()=>{
  const f=fixture();
  try{
    const before=structuredClone(f.snapshot.observation),after=structuredClone(before);
    const other=after.view.outposts.find(o=>o.owner!==after.view.player)!;
    other.owner=other.owner===null?1:null;
    assert.equal(classifyChanges(before,after).important.length,0);
    assert.equal(classifyChanges(before,after).minor[0]!.key,'public-ownership');
    const target=after.view.outposts.find(o=>o.owner===after.view.player)!;
    after.view.fleets.push({id:'threat',owner:1,position:{x:1,y:2},drillers:3,state:'moving',gift:false,destination:{kind:'outpost',id:target.id}});
    assert.ok(classifyChanges(before,after).important.some(s=>s.category==='military'&&s.urgent));
  }finally{f.close();}
});

test("AI tool gateway rejects hidden actions and identity overrides without making requests", async () => {
  const f = fixture();
  try {
    const c = {
      state: f.state,
      snapshot: f.snapshot,
      gateway: f.gateway,
      id: "unique",
      spoken: 0,
      now: 60000,
    };
    for (const kind of [
      "promote",
      "resign",
      "toggle-funding",
      "reserve-fleet",
    ]) {
      await assert.rejects(
        executeTool("order", { action: { kind } }, c),
        /not available/,
      );
      await assert.rejects(
        executeTool(
          "forecast",
          {
            targetTick: 101,
            drafts: [{ id: "d", issueTick: 100, action: { kind } }],
          },
          c,
        ),
        /not available/,
      );
    }
    await assert.rejects(
      executeTool("order", { action: { kind: "check-in" }, player: 1 }, c),
      /fields/,
    );
    await assert.rejects(
      executeTool("forecast", { targetTick: 300, drafts: [] }, c),
      /Tool not available/,
    );
    await assert.rejects(
      executeTool("say", { to: 0, text: "self" }, c),
      /recipients/,
    );
    assert.equal(f.requests.length, 0);
    await executeTool("order", { action: { kind: "check-in" } }, c);
    assert.deepEqual(f.requests[0], {
      path: "/tool/order",
      data: {
        revision: f.snapshot.observation.revision,
        order: { id: "unique", action: { kind: "check-in" } },
      },
    });
  } finally {
    f.close();
  }
});

test("AI completes a thought, persists strategy, initiates diplomacy and wakes only at an explicit reminder", async () => {
  const f = fixture();
  try {
    const replies = [
      response("notebook", {memory:{strategy:"# 防守东线"},set:[{id:'diplomacy',kind:'agreement',text:'蓝方尚可合作；已提议停战但尚未接受',expiresWorldDay:null}]}),
      response("say", { to: 1, text: "我们可以停战六小时吗？" }),
      response("finish", { }),
    ];
    const provider: AgentProvider = { step: async () => replies.shift()! };
    const runner = new SeatRunner(f.state, f.store, f.gateway, provider);
    await runner.poll(0);
    assert.equal(f.state.calls, 0);
    assert.equal(f.state.status, "waiting");
    assert.equal(f.requests[0]!.path, "/tool/chat");
    assert.equal(f.store.load("room", 1)!.memory.strategy, "# 防守东线");
    assert.equal(f.store.load("other-room", 1), null);
    await runner.poll(6000);
    assert.equal(f.state.calls, 0);
    f.store.save(f.state,'reminder-set',{id:'review',atSeconds:60600,note:'核对防线'});
    f.snapshot.observation.view.tick = 101;f.snapshot.observation.secondsSinceLastTick = 0;
    replies.push(response("finish", { reminders:{complete:["review"]} }));
    await runner.pollAndFlush(12000);
    assert.equal(f.state.calls, 0);
  } finally {
    f.close();
  }
});

test("AI single-flight and pause prevent actions returned by an in-flight Codex request", async () => {
  const f = fixture();
  try {
    let release!: (v: ReturnType<typeof response>) => void;
    const provider: AgentProvider = {
      step: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    };
    const runner = new SeatRunner(f.state, f.store, f.gateway, provider),
      task = runner.poll(0);
    await new Promise((resolve) => setImmediate(resolve));
    await runner.poll(10000);
    assert.equal(f.state.calls, 0);
    runner.pause();
    release(response("order", { action: { kind: "check-in" } }));
    await task;
    assert.equal(f.requests.length, 0);
    assert.equal(f.state.status, "paused");
    assert.equal(f.state.tokens, 0);
  } finally {
    f.close();
  }
});

test("real-time coalescing wakes AI on new diplomacy with a frozen game clock; own messages do not loop", async () => {
  const f = fixture();
  try {
    const runner = new SeatRunner(f.state, f.store, f.gateway, {
      step: async () => response("finish", { }),
    });
    await runner.poll(0);
    f.snapshot.chat = [
      { id: "m", from: 1, to: 0, text: "合作吗", tick: 100, sentAt: 0 },
    ];
    f.snapshot.chatCursor = 1;
    await runner.poll(5000);
    assert.equal(f.state.calls, 0);
    await runner.poll(21000);
    assert.equal(f.state.calls, 0);
    assert.deepEqual((f.store.decisionPage('room',1).entries[0]!.payload as {reasons:string[]}).reasons,['收到新消息']);
    assert.deepEqual((f.store.decisionPage('room',1).entries[0]!.payload as {incomingMessages:unknown[]}).incomingMessages,f.snapshot.chat);
    assert.equal(f.state.chatCursor, 1);
    f.snapshot.chat = [
      { id: "own", from: 0, to: 1, text: "可以", tick: 100, sentAt: 0 },
    ];
    f.snapshot.chatCursor = 2;
    await runner.poll(30000);
    await runner.poll(60000);
    assert.equal(f.state.calls, 0);
  } finally {
    f.close();
  }
});

test('frozen-clock replies bypass proactive cooldown only for incoming senders, with the per-target cap intact',async()=>{
  const f=fixture();
  try{
    f.state.lastSpoke=60000;
    const c={state:f.state,snapshot:f.snapshot,gateway:f.gateway,id:'reply',spoken:0,now:60000};
    f.snapshot.chatCount=3;
    f.snapshot.chat=[{id:'incoming',from:1,to:0,text:'合作吗',tick:100,sentAt:0}];
    await executeTool('say',{to:1,text:'可以谈谈'},c);
    await assert.rejects(executeTool('say',{to:2,text:'无关主动联系'},c),/cooldown/);
    await assert.rejects(executeTool('say',{to:null,text:'公开广播'},c),/cooldown/);
    await executeTool('say',{to:1,text:'第五条'},{...c,spoken:4,chatSentByTarget:{'player:1':4}});
    await assert.rejects(executeTool('say',{to:1,text:'第六条'},{...c,spoken:5,chatSentByTarget:{'player:1':5}}),/quota/);
    f.snapshot.chat=[{id:'public',from:1,to:null,text:'大家好',tick:100,sentAt:0}];
    await executeTool('say',{to:null,text:'你好'},c);
    f.snapshot.chat=[];
    await assert.rejects(executeTool('say',{to:1,text:'重复联系'},c),/cooldown/);
    assert.equal(f.requests.length,3);
  }finally{f.close();}
});

test("Codex JSONL parser requires successful completion and usage; rejects native tools", () => {
  const output = [
    {
      type: "item.completed",
      item: {
        type: "agent_message",
        text: JSON.stringify(
          {request:{tool:'finish',arguments:{}},summary:'测试决策'},
        ),
      },
    },
    {
      type: "turn.completed",
      usage: { input_tokens: 50, output_tokens: 10, cached_input_tokens: 40 },
    },
  ]
    .map((v) => JSON.stringify(v))
    .join("\n");
  assert.equal(parseCodexOutput(output).tokens, 60);
  assert.deepEqual(parseCodexOutput(output).usage,{inputTokens:50,outputTokens:10,cachedInputTokens:40});
  assert.throws(() => parseCodexOutput(output.split("\n")[0]!), /incomplete/);
  assert.throws(
    () =>
      parseCodexOutput(
        JSON.stringify({
          type: "item.completed",
          item: { type: "command_execution" },
        }),
      ),
    /native/,
  );
  const args = codexArguments("C:/temporary isolated folder", "test-model");
  assert.ok(args.includes("--ignore-user-config"));
  assert.ok(args.includes("read-only"));
  assert.ok(args.includes("shell_tool"));
  assert.equal(args.at(-1), "-");
});

test("unknown write outcome stops AI; uncoded conflict is returned for reconsideration", async () => {
  const f = fixture();
  try {
    let calls = 0;
    const runner = new SeatRunner(
      f.state,
      f.store,
      {
        ...f.gateway,
        request: async () => {
          throw new GameTransportError();
        },
      },
      {
        step: async () => {
          calls++;
          return response("order", { action: { kind: "check-in" } });
        },
      },
    );
    await runner.poll(0);
    await runner.poll(10000, true);
    assert.equal(calls, 1);
    assert.equal(f.state.status, "error");
    const state = initialState("room", 2, settings);
    let steps = 0;
    const stale = new SeatRunner(
      state,
      f.store,
      {
        ...f.gateway,
        request: async () => {
          throw new GameRequestError(409);
        },
      },
      {
        step: async (request) => {
          steps++;
          if (steps === 1)
            return response("order", { action: { kind: "check-in" } });
          assert.ok(request.prompt.includes("request-conflict"));
          assert.ok(!request.prompt.includes("stale-observation"));
          return response("finish", { });
        },
      },
    );
    await stale.poll(0);
    assert.equal(state.status, "waiting");
    assert.equal(steps, 2);
  } finally {
    f.close();
  }
});

test("AI gateway uses actual authenticated HTTP commands and chat without hidden-state access", async t => {
  const f = fixture();
  let current = f.room;
  const h=protocolHarness(t,{room:current}),accessData=h.ownerCredentials,chat=new ChatStore(join(f.dir,'chat.json'));await chat.load();
  const server=await createOwnerPlayerApi(h,{chat:()=>chat});
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const gateway = new PlayerGateway(
      `http://127.0.0.1:${address.port}`,
      accessData.credentials[0]!.token,
      accessData.roomId,
      0,
      2,
    );
    const state = initialState(accessData.roomId, 0, settings);
    f.store.save(state);
    const replies = [
      response("forecast", { targetTick: 101, drafts: [] }),
      response("order", {
        action: { kind: "set-shields", outpostId: f.snapshot.observation.outpostNames!["蓝方工厂"]!, enabled: false },
      }),
      response("say", { to: 1, text: "我们可以讨论边界。" }),
      response("finish", { }),
    ];
    const runner = new SeatRunner(state, f.store, gateway, {
      step: async () => replies.shift()!,
    });
    await runner.poll(0);
    assert.equal(state.status, "waiting");
    assert.equal(
      h.store.load()!.room.state.commands.filter((c) => c.action.kind === "set-shields")
        .length,
      1,
    );
    assert.equal(chat.listForSeat(1)[0]!.text, "我们可以讨论边界。");
    assert.equal(state.calls, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.close();
  }
});

test('conflict observation is delivered to the next decision without retrying a write or fetching twice',async()=>{
 const f=fixture();try{
  let writes=0,reads=0,steps=0;
  const latest=structuredClone(f.snapshot.observation);latest.revision='new-revision';latest.view.self.mineCreationCost=123;
  f.gateway.snapshot=async()=>{reads++;return structuredClone(f.snapshot);};
  f.gateway.request=async()=>{writes++;throw new GameRequestError(409,latest);};
  await new SeatRunner(f.state,f.store,f.gateway,{step:async r=>{
   if(++steps===1)return response('order',{action:{kind:'check-in'}});
   assert.ok(r.prompt.includes('new-revision'));assert.ok(r.prompt.includes('"mineCreationCost":123'));
   assert.ok(r.prompt.includes('No automatic retry'));return response('finish',{});
  }}).poll(0,true);
  assert.equal(writes,1);assert.equal(reads,1);assert.equal(f.state.status,'waiting');
 }finally{f.close();}
});


test('batch uses updated revisions, applies independent orders through the engine and finishes with partial memory in two calls',async()=>{
 const f=fixture();try{
  f.state.memory={strategy:'old',relations:'',agreements:'',deceptions:''};f.store.save(f.state);
  f.store.save(f.state,'notebook-set',{id:'agreement',kind:'agreement',priority:'high',text:'keep agreement body',updatedAt:60000,expiresAt:null});
  let calls=0;
  f.gateway.request=async(path,data)=>{
   assert.equal(path,'/tool/order');const raw=data as any;
   const current=observation(f.room,0,'room');assert.equal(raw.revision,current.revision);
   f.room.state=submitFleetOrder(f.room.state,{...raw.order,player:0}).state;
   return observation(f.room,0,'room');
  };
  const actions=[10,15].map((drillers,index)=>({tool:'order',arguments:{action:{kind:'launch',source:f.snapshot.observation.outpostNames!['蓝方工厂']!,destination:f.snapshot.observation.outpostNames![index===0?'红方矿场':'红方后方']!,drillers}}}));
  await new SeatRunner(f.state,f.store,f.gateway,{step:async r=>{
   if(++calls===1)return response('batch',{actions});
   assert.ok(r.prompt.includes('"complete":true'));
   return {...response('finish',{memory:{strategy:'new strategy'}}),usage:{inputTokens:12,outputTokens:8,cachedInputTokens:5}};
  }}).poll(0,true);
  assert.equal(calls,2);assert.equal(f.state.status,'waiting',JSON.stringify(f.store.history('room',1,30)));assert.equal(f.room.state.economy.outposts[0]!.drillers,75,JSON.stringify(f.store.history('room',1,30)));
  assert.deepEqual(f.state.memory,{strategy:'new strategy',relations:'',agreements:'',deceptions:''});
  const logs=f.store.history('room',1,50);
  assert.equal(logs.filter(r=>r.kind==='batch-item-intent').length,2);
  assert.equal(logs.filter(r=>r.kind==='batch-item-result').length,2);
  assert.equal(f.state.tokens,0);
 }finally{f.close();}
});

test('batch stops after rejection or pause, validates all envelopes first and never repeats an accepted action',async()=>{
 const f=fixture();try{
  const actions=[0,1,2].map(()=>({tool:'order',arguments:{action:{kind:'check-in'}}}));
  const audit:unknown[]=[];let requests=0,active=true;
  const c={state:f.state,snapshot:f.snapshot,gateway:f.gateway,id:'batch',spoken:0,now:0,active:()=>active,audit:(kind:string,p:unknown)=>audit.push({kind,p})};
  const latest=structuredClone(f.snapshot.observation);latest.revision='fresh-conflict';
  f.gateway.request=async()=>{if(++requests===2)throw new GameRequestError(409,latest);return f.snapshot.observation;};
  const result=await executeTool('batch',{actions},c) as any;
  assert.equal(requests,2);assert.equal(result.complete,false);assert.equal(result.processed,2);
  assert.deepEqual(result.results.map((r:any)=>r.status),['accepted','rejected','not-executed']);
  assert.equal(result.observation.revision,'fresh-conflict');
  requests=0;f.gateway.request=async()=>{requests++;active=false;return f.snapshot.observation;};
  assert.equal((await executeTool('batch',{actions},c) as any).processed,1);assert.equal(requests,1);
  active=true;requests=0;
  await assert.rejects(executeTool('batch',{actions:[actions[0],{tool:'say',arguments:{}}]},c));assert.equal(requests,0);
  f.gateway.request=async()=>{requests++;throw new GameTransportError();};
  await assert.rejects(executeTool('batch',{actions},c),GameTransportError);assert.equal(requests,1);
  assert.ok(JSON.stringify(audit).includes('batch-item-unknown'));
  await assert.rejects(executeTool('finish',{memory:{strategy:42}},c));
  assert.equal(f.state.memory.strategy,'');
 }finally{f.close();}
});

test('round budget yields between acknowledged actions and schedules continuation without repeating writes',async(t)=>{
 const f=fixture();let wall=1000,calls=0,writes=0;
 t.mock.method(Date,'now',()=>wall);
 try{
  f.gateway.request=async()=>{writes++;wall=1171001;return f.snapshot.observation;};
  const runner=new SeatRunner(f.state,f.store,f.gateway,{step:async()=>{calls++;return response('order',{action:{kind:'check-in'}});}});
  await runner.poll(0,true);
  assert.equal(calls,1);assert.equal(writes,1);assert.equal(f.state.status,'waiting');
  assert.equal(f.store.latest<any>('room',1,'completed').reason,'time-budget-yield');
  assert.ok(f.store.latest<any>('room',1,'wake-state').signals.some((s:any)=>s.key==='continuation'));
  assert.equal((f.store.decisionPage('room',1).entries[0]!.payload as any).status,'pending-continuation');
  assert.equal(typeof f.store.latest<any>('room',1,'bot-compute-completed').durationMs,'number');
 }finally{f.close();}
});

test('automatic recovery backs off, reads fresh state and never repeats an accepted write',async()=>{
  const f=fixture();let calls=0,observations=0;
  f.gateway.snapshot=async()=>{observations++;return structuredClone(f.snapshot);};
  try{
    const runner=new SeatRunner(f.state,f.store,f.gateway,{step:async request=>{
      calls++;
      if(calls===1)return response('order',{action:{kind:'check-in'}});
      if(calls===2)throw new GameTransportError({requestId:'read-failure',method:'GET',path:'/tool/observation',origin:'http://localhost',timeoutMs:1000,elapsedMs:1000,stage:'read-response',failure:'timeout',outcome:'read-only'});
      assert.ok(request.prompt.includes('已接受命令和已发送消息不得重复执行'));
      assert.ok(request.prompt.includes('fresh-after-recovery'));
      return response('finish',{});
    }});
    await runner.poll(0,true);
    assert.equal(f.requests.length,1);assert.equal(f.state.status,'error');
    const event=f.store.latest<any>('room',1,'error');
    assert.equal(event.recovery.delayMs,15000);assert.equal(calls,2);
    assert.equal(f.store.latest('room',1,'provider-retry'),null);
    await runner.poll(14000,true);assert.equal(calls,2);
    f.snapshot.observation.revision='fresh-after-recovery';
    await runner.poll(event.recovery.at?Date.parse(event.recovery.at)+1:20000,true);
    assert.equal(f.state.status,'waiting');assert.equal(f.state.error,null);
    assert.equal(calls,3);assert.equal(observations,2);assert.equal(f.requests.length,1);
    assert.equal(f.store.latest<any>('room',1,'recovery-completed').attempts,1);
  }finally{f.close();}
});

test('read-only failures retry with capped exponential delay and pause cancels recovery',async()=>{
  const f=fixture();let reads=0;
  const error=new GameTransportError({requestId:'read',method:'GET',path:'/tool/observation',origin:'http://localhost',timeoutMs:15000,elapsedMs:0,stage:'connect-or-send',failure:'connection-reset',outcome:'read-only'});
  f.gateway.snapshot=async()=>{reads++;throw error;};
  try{
    const runner=new SeatRunner(f.state,f.store,f.gateway,{step:async()=>response('finish',{})});
    let now=0;
    for(const delay of [15000,30000,60000,120000,240000,300000,300000]){
      await runner.poll(now,true);
      const recovery=f.store.latest<any>('room',1,'error').recovery;
      assert.equal(recovery.delayMs,delay);
      await runner.poll(Date.parse(recovery.at)-1,true);
      assert.equal(reads,recovery.attempt);
      now=Date.parse(recovery.at)+1;
    }
    runner.pause();await runner.poll(now+600000,true);
    assert.equal(reads,7);assert.equal(f.state.status,'paused');
  }finally{f.close();}
});

test('AI new reminders and explicit launch reservations require integer absolute world days atomically',async()=>{
 const f=fixture();try{
  const c={state:f.state,snapshot:f.snapshot,gateway:f.gateway,id:'integer-days',spoken:0,now:60150};
  const before=structuredClone(f.state.memory);
  await assert.rejects(executeTool('finish',{memory:{strategy:'must not commit'},reminders:{set:[{id:'fraction',atSeconds:61350,note:'invalid fractional wake'}]}},c),/整数/);
  assert.deepEqual(f.state.memory,before);assert.equal(f.requests.length,0);
  const reminder=await executeTool('reminders',{set:[{id:'whole',atSeconds:61200,note:'whole-day wake'}]},c) as any;
  assert.ok(reminder);
  await assert.rejects(executeTool('order',{action:{kind:'launch',source:'蓝方工厂',destination:'红方矿场',drillers:1,delayWorldDays:2}},c),/整数/);
  assert.equal(f.requests.length,0);
  await executeTool('order',{action:{kind:'launch',source:'蓝方工厂',destination:'红方矿场',drillers:1,delayWorldDays:1.75}},c);
  assert.equal(f.requests.length,1);
 }finally{f.close();}
});
