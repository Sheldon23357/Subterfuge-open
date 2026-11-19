import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {worldCountdown,worldMinutes,tickTime} from '../packages/client/src/time.js';
import {ruleNotificationWorldTime} from '../packages/contracts/src/index.js';

// Execute the real JSX callbacks/expressions without mounting the canvas or
// contacting a game server. The override lets the identical tests check a saved
// pre-fix source tree; it never substitutes a second implementation of the fix.
const sourceRoot=process.env.WORLD_DAY_CLIENT_SOURCE_ROOT??process.cwd();
function source(name:string) {
  const file=path.join(sourceRoot,'packages/client/src',name);
  return ts.createSourceFile(file,readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
}
function find<T extends ts.Node>(file:ts.SourceFile,predicate:(node:ts.Node)=>node is T):T {
  const matches:T[]=[];
  function visit(node:ts.Node){if(predicate(node))matches.push(node);ts.forEachChild(node,visit);}
  visit(file);
  assert.equal(matches.length,1,'expected one matching production expression');
  return matches[0]!;
}
function evaluate(expression:string,scope:Record<string,unknown>={}):any {
  const {outputText}=ts.transpileModule(`(${expression})`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None,jsx:ts.JsxEmit.React}});
  return runInNewContext(outputText,{React,...scope});
}
const game=source('Game.tsx');
const dispatch=find(game,(n):n is ts.JsxAttribute=>ts.isJsxAttribute(n)&&n.name.getText(game)==='dispatch');
assert.ok(dispatch.initializer&&ts.isJsxExpression(dispatch.initializer)&&dispatch.initializer.expression);
const dispatchText=dispatch.initializer.expression.getText(game);
const endRoute=find(game,(n):n is ts.FunctionDeclaration=>ts.isFunctionDeclaration(n)&&n.name?.text==='endRoute');

function dragMode(seconds:number,routePreviewArrived=false,originOffset=0) {
  const tick=10,view={tick,outposts:[{id:'a',drillers:20}]};
  const initial={offset:originOffset,tick:tick+originOffset,view},lastRoute:{current:typeof initial|null}={current:null};
  let mode='',restoredOffset:number|undefined;
  const scope={view,display:view,offset:routePreviewArrived?30:originOffset,phase:seconds/600,
    lastRoute,routeContext:{current:initial},routeSeq:{current:0},routeAbort:{current:null},routeTimer:{current:null},
    clearTimeout,select:()=>{},setTarget:()=>{},setAnchor:()=>{},setMode:(v:string)=>{mode=v;},setSpecs:()=>{},setTroops:()=>{},setDragging:()=>{},setRouteLabel:()=>{},
    predicting:routePreviewArrived,failure:'',setOffset:(v:number)=>{restoredOffset=v;}};
  evaluate(endRoute.getText(game),scope)(true);assert.equal(restoredOffset,originOffset);
  evaluate(dispatchText,scope)('a','b',{x:1,y:2});assert.equal(lastRoute.current,null);return mode;
}
for(const seconds of [0,1,300,599])for(const arrived of [false,true])test('current-time drag opens immediate deployment at phase '+seconds+' with route preview '+arrived,()=>{assert.equal(dragMode(seconds,arrived),'deploy');});
test('future drag cannot open deployment even after the route preview changes the displayed time',()=>{
 for(const seconds of [0,1,300,599])for(const arrived of [false,true])assert.equal(dragMode(seconds,arrived,5),'');
});
const launch=find(game,(n):n is ts.VariableDeclaration=>ts.isVariableDeclaration(n)&&n.name.getText(game)==='canLaunch');
test('deployment is unavailable in future and historical views while current manual deployment remains available',()=>{
 for(const offset of [-1,1,5])assert.equal(evaluate(launch.initializer!.getText(game),{offset,access:{readOnly:false},refreshingPerspective:false,isOwner:true,active:true}),false);
 assert.equal(evaluate(launch.initializer!.getText(game),{offset:0,access:{readOnly:false},refreshingPerspective:false,isOwner:true,active:true}),true);
});

const plannedCountdown=find(game,(n):n is ts.CallExpression=>ts.isCallExpression(n)&&n.expression.getText(game)==='countdown'&&n.arguments.some(arg=>arg.getText(game).includes('p.departureTick')));
function remaining(departureTick:number,display:object) {
  return evaluate(plannedCountdown.getText(game),{p:{departureTick},display,countdown:worldCountdown,phase:599/600,view:{tick:10,secondsSinceLastTick:599}});
}
test('planned-launch countdown subtracts the displayed live phase and clamps expired departures',()=>{
  assert.equal(remaining(12,{tick:10,secondsSinceLastTick:300}),'1.5天');
  assert.equal(remaining(11,{tick:10,secondsSinceLastTick:599}),'≈0.001667天');
  assert.equal(remaining(10,{tick:10,secondsSinceLastTick:300}),'0天');
  assert.equal(remaining(9,{tick:10,secondsSinceLastTick:300}),'0天');
});
test('planned-launch history and prediction use their own frame phase, never current live phase',()=>{
  assert.equal(remaining(12,{tick:8,secondsSinceLastTick:0}),'4天');
  assert.equal(remaining(12,{tick:11,secondsSinceLastTick:0}),'1天');
  assert.equal(remaining(12,{tick:10}),'2天');
  assert.equal(remaining(12,{tick:10,secondsSinceLastTick:599,perspective:{seconds:0}}),'2天');
  assert.equal(remaining(12,{tick:10,secondsSinceLastTick:0,perspective:{seconds:300}}),'1.5天');
});

function productionEventDetails() {
  const {outputText}=ts.transpileModule(source('copy.ts').text,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}});
  const exports:Record<string,any>={};
  runInNewContext(outputText,{exports,require:(specifier:string)=>{assert.equal(specifier,'./time.js');return {worldMinutes};}});
  return exports.eventDetails as (json:string,name?:(id:string)=>string,kind?:string)=>string;
}
const eventDetails=productionEventDetails();
test('typed inactivity detail formatting converts rule minutes to world days',()=>{
  for(const minutes of [0,15,960,1440]) {
    const details=JSON.stringify({owner:0,minutes,count:1});
    const text=eventDetails(details,(id:string)=>id,'inactivity-warning');
    assert.equal(text,`所属席位：0 · 不活跃时长：${worldMinutes(minutes)} · count：1`);
    assert.equal(JSON.parse(details).minutes,minutes,'stored data stays in rule minutes');
  }
});
test('event details do not convert unknown time domains, wall-clock fields or arbitrary prose',()=>{
  const details=JSON.stringify({minutes:1440,text:'We agreed on 2 hours.',durationMs:60000,atMs:1700000000000});
  const unchanged='minutes：1440 · text：We agreed on 2 hours. · durationMs：60000 · atMs：1700000000000';
  assert.equal(eventDetails(details,undefined,'unknown-event'),unchanged);
  assert.equal(eventDetails(details),unchanged);
  assert.equal(eventDetails('We agreed on 2 hours.',undefined,'inactivity-warning'),'We agreed on 2 hours.');
  assert.equal(eventDetails('{"minutes":"1440","durationMs":60000}',undefined,'inactivity-warning'),'minutes：1440 · durationMs：60000');
  assert.equal(eventDetails('{"minutes":null}',undefined,'inactivity-warning'),'minutes：无');
  assert.equal(eventDetails('{"minutes":-10}',undefined,'inactivity-warning'),'minutes：-10');
});

test('formal player manual explains immediate-only deployment and future viewing',()=>{
  const player=source('player-main.tsx');
  const help=find(player,(n):n is ts.JsxElement=>ts.isJsxElement(n)&&n.openingElement.attributes.properties.some(a=>ts.isJsxAttribute(a)&&a.name.getText(player)==='className'&&a.initializer&&ts.isStringLiteral(a.initializer)&&a.initializer.text==='help-grid'));
  const html=renderToStaticMarkup(evaluate(help.getText(player),{}));
  assert.match(html,/舰队立即出发/);
  assert.match(html,/出兵须返回当前时间操作/);
  assert.match(html,/不支持预约出兵/);
  assert.doesNotMatch(html,/绝对整数预约出发日|到预约时间直接出发/);
  assert.doesNotMatch(html,/至少1天准备时间/);
  assert.match(html,/抵达时间仍可为小数天/);
  assert.doesNotMatch(html,/出发倒计时/);
});

const notifications=source('PlayerNotifications.tsx');
const notificationItem=find(notifications,(n):n is ts.ArrowFunction=>ts.isArrowFunction(n)&&n.parameters[0]?.name.getText(notifications)==='entry'&&n.body.getText(notifications).includes('<time>'));
function renderNotification(kind:string,tick:number,seconds?:number) {
  const render=evaluate(notificationItem.getText(notifications),{ruleNotificationWorldTime,tickTime,titles:{},message:(text:string)=>text,BattleReport:()=>null});
  return renderToStaticMarkup(render({id:'n1',kind,tick,seconds,text:'We agreed on 2 hours.'}));
}
test('notification renderer converts movement settlement ticks once, with fractional precision',()=>{
  assert.match(renderNotification('battle',108,270),/<time>第107\.45天<\/time>/);
  assert.match(renderNotification('battle',108,600),/<time>第108天<\/time>/);
  assert.match(renderNotification('departed',10,0),/<time>第9天<\/time>/);
  assert.match(renderNotification('mine-created',10,300),/<time>第10\.5天<\/time>/);
  assert.match(renderNotification('battle',108,270),/We agreed on 2 hours\./);
});
test('notification renderer discloses unknown time instead of guessing unfamiliar provenance',()=>{
  assert.match(renderNotification('unrecognized',108,270),/<time>时间未知<\/time>/);
  assert.match(renderNotification('battle',0,300),/<time>时间未知<\/time>/);
  assert.match(renderNotification('battle',108,601),/<time>时间未知<\/time>/);
});
