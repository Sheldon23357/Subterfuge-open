
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {DISPATCH_LOCK_MESSAGE} from '../packages/contracts/src/index.js';
import {initialState,executeTool,type AiSnapshot} from '../packages/ai/src/index.js';
import {compactGameError,GameRequestError,GameTransportError,PlayerGateway,type GameRequestDiagnostic} from '../packages/ai/src/controller/transport/gateway.js';
import {BatchTransportError} from '../packages/ai/src/controller/execution/batch-outcome.js';

function fixture(){
 const o=observation({state:createFleetScenario(JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial),scheduled:[]},0,'error-diagnostics');
 const snapshot:AiSnapshot={observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2,notebook:[],reminders:[]};
 const state=initialState(o.roomId,0,{model:'',personality:'schemer'}),requests:unknown[]=[],audits:{kind:string;details:unknown}[]=[];
 const actions=Array.from({length:3},()=>({tool:'order',arguments:{action:{kind:'check-in'}}}));
 const gateway={snapshot:async()=>structuredClone(snapshot),request:async(_path:string,data:unknown):Promise<unknown>=>{requests.push(data);return {...structuredClone(o),revision:'accepted-first'};}};
 return {o,snapshot,requests,actions,audits,gateway,context:{state,snapshot,gateway,id:'diagnostics',now:o.view.tick*600+o.secondsSinceLastTick,spoken:0,audit:(kind:string,details:unknown)=>audits.push({kind,details})}};
}
const diagnostic=(extra:Partial<GameRequestDiagnostic>={}):GameRequestDiagnostic=>({requestId:'request-2',method:'POST',path:'/tool/order',origin:'https://unused.invalid',timeoutMs:15000,elapsedMs:7,stage:'http-response',failure:'http-error',status:409,outcome:'rejected',...extra});
function controlReply(input:unknown,init?:RequestInit){return String(input).endsWith('/player/v2/owner/control')?Response.json({roomId:'error-diagnostics',mode:'agent',sessionId:new Headers(init?.headers).get('X-Subterfuge-Control-Session'),expiresAt:Date.now()+30000}):null;}

test('explicit conflict causes survive without relabelling all conflicts as stale observations',()=>{
 for(const code of ['manual-command-protected','commander-replan-required','PLAYER_CONTROL','REVISION_CONFLICT','DISPATCH_SOURCE_LOCKED']){
  const error=new GameRequestError(409,undefined,code);
  assert.equal(error.code,code);assert.equal(error.message,code);
  if(code==='DISPATCH_SOURCE_LOCKED')assert.equal(error.displayReason,DISPATCH_LOCK_MESSAGE);
  else if(code!=='REVISION_CONFLICT')assert.ok(!error.displayReason.includes('情报版本冲突'));
 }
 const generic=new GameRequestError(409);assert.equal(generic.message,'request-conflict');assert.ok(!generic.displayReason.includes('情报版本冲突'));
 const stale=new GameRequestError(409,fixture().o);assert.equal(stale.message,'stale-observation');assert.ok(stale.displayReason.includes('情报版本冲突'));
 assert.equal(new GameRequestError(403,undefined,'SCOPE_DENIED').message,'SCOPE_DENIED');
});

test('owner write rejection retains server code, request identity and submitted/current revision without leaking bearer',async t=>{
 const f=fixture(),fresh={...f.o,revision:'server-current'};let requestId='';
 t.mock.method(globalThis,'fetch',async(_input:unknown,init:RequestInit)=>{
  const control=controlReply(_input,init);if(control)return control;
  requestId=new Headers(init.headers).get('X-Request-Id')!;
  return Response.json({code:'manual-command-protected',message:'Use a different source',observation:fresh,token:'BODY_SECRET'}, {status:409});
 });
 const gateway=new PlayerGateway('https://unused.invalid','AUTH_SECRET',f.o.roomId,0,2);
 await assert.rejects(gateway.request('/tool/order',{revision:'submitted-before',order:{}}),(error:unknown)=>{
  assert.ok(error instanceof GameRequestError);assert.equal(error.message,'manual-command-protected');assert.equal(error.observation?.revision,'server-current');
  const result=compactGameError(error);assert.equal(result.code,'manual-command-protected');assert.equal(result.httpStatus,409);assert.equal(result.requestId,requestId);
  assert.equal(result.expectedRevision,'submitted-before');assert.equal(result.currentRevision,'server-current');assert.equal(result.outcome,'rejected');
  const encoded=JSON.stringify(result);assert.ok(!/AUTH_SECRET|BODY_SECRET|outposts|observation|origin/.test(encoded));return true;
 });
});

test('uncoded owner-write 409 reports generic conflict unless the server supplies a current observation',async t=>{
 const f=fixture();let fresh=false;
 t.mock.method(globalThis,'fetch',async(input:unknown,init?:RequestInit)=>controlReply(input,init)??Response.json(fresh?{conflict:true,observation:f.o}:{error:'Conflict'}, {status:409}));
 const gateway=new PlayerGateway('https://unused.invalid','token',f.o.roomId,0,2);
 await assert.rejects(gateway.request('/tool/order',{revision:'old'}),(error:unknown)=>{
  assert.ok(error instanceof GameRequestError);assert.equal(error.status,409);assert.equal(error.code,undefined);assert.equal(error.observation,undefined);assert.equal(error.message,'request-conflict');return true;
 });
 fresh=true;
 await assert.rejects(gateway.request('/tool/order',{revision:'old'}),(error:unknown)=>{
  assert.ok(error instanceof GameRequestError);assert.equal(error.status,409);assert.equal(error.code,undefined);assert.equal(error.observation?.revision,f.o.revision);assert.equal(error.message,'stale-observation');return true;
 });
});

test('owner-write access rejection retains the actual server error code outside 400/409',async t=>{
 t.mock.method(globalThis,'fetch',async(input:unknown,init?:RequestInit)=>controlReply(input,init)??Response.json({code:'SCOPE_DENIED',message:'private body must not be forwarded'}, {status:403}));
 const gateway=new PlayerGateway('https://unused.invalid','token','error-diagnostics',0,2);
 await assert.rejects(gateway.request('/tool/order',{revision:'old'}),(error:unknown)=>{
  assert.ok(error instanceof GameRequestError);assert.equal(error.message,'SCOPE_DENIED');assert.equal(error.diagnostic?.code,'SCOPE_DENIED');assert.equal(error.status,403);assert.equal(error.detail,undefined);return true;
 });
});

test('compact diagnostics are allowlisted, redacted and bounded even with nested/full transport data',()=>{
 const f=fixture(),error=new GameRequestError(409,f.o,'IDEMPOTENCY_CONFLICT','Bearer DETAIL_SECRET',diagnostic({
  requestId:'request-'+ 'x'.repeat(10000),path:'/tool/order?token=QUERY_SECRET',origin:'https://ORIGIN_SECRET.invalid',
  failure:'Bearer FAILURE_SECRET',expectedRevision:'e'.repeat(10000),currentRevision:'c'.repeat(10000),
  cause:{name:'Error',message:'CAUSE_SECRET',stack:'STACK_SECRET',causes:[{name:'Error',message:'NESTED_SECRET'}]},
 }));
 const result=compactGameError(error),encoded=JSON.stringify(result);
 assert.equal(result.requestId?.length,128);assert.equal(result.expectedRevision?.length,128);assert.equal(result.currentRevision?.length,128);
 assert.equal(result.diagnostic?.path,'/tool/order');assert.equal(result.diagnostic?.failure,'Bearer [redacted]');
 assert.ok(encoded.length<1000);assert.ok(!/SECRET|outposts|observation|stack|causes|origin|timeoutMs/.test(encoded));
});

test('partial rejected batch preserves exact code and compact diagnostics without replaying accepted or untouched items',async()=>{
 const f=fixture(),fresh={...f.o,revision:'rejected-current'};
 f.gateway.request=async(_path,data)=>{f.requests.push(data);if(f.requests.length===2)throw new GameRequestError(409,fresh,'manual-command-protected','Bearer DETAIL_SECRET',diagnostic());return {...f.o,revision:'accepted-first'};};
 const result=await executeTool('batch',{actions:f.actions},f.context) as {results:Record<string,unknown>[];complete:boolean;processed:number;observation:{revision:string}};
 assert.equal(result.complete,false);assert.equal(result.processed,2);assert.equal(result.observation.revision,'rejected-current');assert.equal(f.requests.length,2);
 assert.deepEqual(result.results.map(r=>r.status),['accepted','rejected','not-executed']);assert.deepEqual(result.results.map(r=>r.id),['diagnostics-item-0','diagnostics-item-1','diagnostics-item-2']);
 const rejected=result.results[1]!;assert.equal(rejected.error,'manual-command-protected');assert.equal(rejected.code,'manual-command-protected');assert.equal(rejected.httpStatus,409);assert.equal(rejected.requestId,'request-2');
 assert.equal(rejected.expectedRevision,'accepted-first');assert.equal(rejected.currentRevision,'rejected-current');assert.equal(rejected.outcome,'rejected');assert.equal(rejected.detail,'Bearer [redacted]');
 assert.deepEqual(f.audits.filter(a=>a.kind==='batch-item-result').at(-1)?.details,rejected);
 assert.ok(!/SECRET|outposts|observation/.test(JSON.stringify(rejected)));
});

test('unknown batch preserves unknown outcome, accepted prefix and untouched suffix with compact request evidence',async()=>{
 const f=fixture();f.gateway.request=async(_path,data)=>{f.requests.push(data);if(f.requests.length===2)throw new GameTransportError(diagnostic({stage:'read-response',failure:'connection-reset',outcome:'unknown',status:200,cause:{name:'Error',message:'CAUSE_SECRET'}}));return {...f.o,revision:'accepted-first'};};
 await assert.rejects(executeTool('batch',{actions:f.actions},f.context),(error:unknown)=>{
  assert.ok(error instanceof BatchTransportError);assert.equal(error.outcome.complete,false);assert.equal(error.outcome.processed,2);assert.equal(error.observation.revision,'accepted-first');
  assert.deepEqual(error.outcome.results.map(r=>r.status),['accepted','unknown','not-executed']);
  const unknown=error.outcome.results[1]!;assert.equal(unknown.outcome,'unknown');assert.equal(unknown.httpStatus,200);assert.equal(unknown.requestId,'request-2');assert.equal(unknown.expectedRevision,'accepted-first');assert.equal(unknown.currentRevision,undefined);
  assert.ok(!/CAUSE_SECRET|outposts|observation/.test(JSON.stringify(unknown)));return true;
 });
 assert.equal(f.requests.length,2);const audit=f.audits.find(a=>a.kind==='batch-item-unknown')!.details as Record<string,unknown>;assert.equal(audit.outcome,'unknown');assert.equal(audit.requestId,'request-2');
});
