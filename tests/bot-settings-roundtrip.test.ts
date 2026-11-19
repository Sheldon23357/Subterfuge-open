
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import React from 'react';
import {DEFAULT_BOT_SETTINGS,BOT_SETTING_LIMITS,resolveBotSettings,type BotSettings,type BotSettingKey} from '../packages/contracts/src/index.js';
import {parseAgentConfig} from '../packages/ai/src/controller/contracts/agent-config.js';
import {AgentRuntime} from '../packages/ai/src/reference.js';
import {AgentBotSettings} from '../packages/client/src/AgentBotSettings.js';

const fixture=(name:string):unknown=>JSON.parse(readFileSync(`tests/fixtures/bot-settings/${name}.json`,'utf8'));
const settings=(bot:unknown)=>({model:'',personality:'sentinel',provider:'offline',bot});

test('published configuration fixtures roundtrip through CLI parsing as canonical v2',()=>{
 const base={id:'fixture',serverUrl:'http://localhost:1',roomId:'fixture',lobbySeat:0,gamePlayer:0,chatPlayer:0,chatCount:1,tokenEnv:'FIXTURE_TOKEN'};
 for(const variant of ['default','custom']){
  const legacy=fixture(`legacy-${variant==='default'?'default-full':'custom'}`),current=fixture(`current-${variant}`),original=structuredClone(legacy);
  const config={storeDirectory:'unused-fixture-directory',seats:[{...base,settings:settings(legacy)}]};
  const parsed=parseAgentConfig(config);
  assert.deepEqual(parsed.seats[0]!.settings.bot,variant==='default'?{...current as BotSettings,maxSimulations:50,maxElapsedMs:10000,horizonTicks:144,forceBufferRatio:0.2,minActionGain:2,minCaptureGain:2}:current);
  assert.deepEqual(parseAgentConfig(JSON.parse(JSON.stringify(parsed))),parsed);
  assert.deepEqual(legacy,original);
 }
 assert.deepEqual(DEFAULT_BOT_SETTINGS,fixture('current-default'),'baseline changes require deliberate fixture review');
});

test('current valid legacy controller profiles canonicalize once and retain per-seat values across restart',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'bot-v2-profiles-')),profilesPath=join(directory,'profiles.json');
 const legacy=fixture('legacy-custom'),expected=fixture('current-custom');
 writeFileSync(profilesPath,JSON.stringify({format:'controller-slots/1',slots:Array.from({length:8},(_,slot)=>({id:`ai-${String(slot+1).padStart(2,'0')}`,slot,settings:slot===0?settings(legacy):{model:'',personality:'sentinel'},provider:{kind:'offline'}}))}));
 const config={storeDirectory:directory,seats:[],pollMs:1000,live:true as const};
 const make=()=>new AgentRuntime(config,{step:async()=>{throw Error('No provider calls');}},{},{fixedSlots:true,profilesPath});
 let runtime=make();
 try{
  assert.deepEqual(runtime.consoleConfig().seats[0]!.settings.bot,expected);
  assert.ok(runtime.consoleConfig().seats.slice(1).every(s=>s.settings.bot===undefined));
  assert.ok(runtime.status().every(s=>!s.bound&&!s.enabled&&s.calls===0));
  const persisted=readFileSync(profilesPath,'utf8');
  assert.deepEqual(JSON.parse(persisted).slots[0].settings.bot,expected);
  const before=runtime.consoleConfig();
  for(const bot of [{schemaVersion:3},{schemaVersion:2,aggression:1},{schemaVersion:2,forceBufferRatio:-0.1},{minCaptureGain:2,aggression:1}]){
   assert.throws(()=>runtime.configureSeat('ai-01',{kind:'offline'},settings(bot)));
   assert.deepEqual(runtime.consoleConfig(),before);assert.equal(readFileSync(profilesPath,'utf8'),persisted);
  }
  await runtime.shutdown();runtime=make();
  assert.equal(readFileSync(profilesPath,'utf8'),persisted);
  assert.deepEqual(runtime.consoleConfig().seats[0]!.settings.bot,expected);
 }finally{await runtime.shutdown();rmSync(directory,{recursive:true,force:true});}
});

type FormProps={children?:React.ReactNode;name?:string;type?:string;min?:number;max?:number;value?:number|string;disabled?:boolean;onChange?:(event:{target:{valueAsNumber:number}})=>void;onClick?:()=>void};
function formElements(value:BotSettings|undefined,onChange:(value:BotSettings)=>void,disabled=false){
 const elements:React.ReactElement<FormProps>[]=[];
 const visit=(node:React.ReactNode)=>{React.Children.forEach(node,child=>{if(React.isValidElement<FormProps>(child)){elements.push(child);visit(child.props.children);}});};
 visit(AgentBotSettings({value,disabled,onChange}));return elements;
}

test('parameter form presents exactly numeric v2 keys and scales shared limits without a version knob',()=>{
 const elements=formElements(undefined,()=>{},true),inputs=elements.filter(e=>e.type==='input');
 assert.deepEqual(inputs.map(e=>e.props.name).sort(),Object.keys(BOT_SETTING_LIMITS).filter(k=>k!=='minCaptureGain').sort());
 assert.equal(inputs.length,11);assert.ok(elements.some(e=>e.type==='fieldset'&&e.props.disabled));
 for(const input of inputs){
  const key=input.props.name as BotSettingKey,scale=key==='maxElapsedMs'?0.001:key==='forceBufferRatio'||key==='remoteUncertaintyForceFraction'?100:1;
  assert.equal(input.props.min,BOT_SETTING_LIMITS[key].min*scale);assert.equal(input.props.max,BOT_SETTING_LIMITS[key].max*scale);
  assert.equal(input.props.value,Number((DEFAULT_BOT_SETTINGS[key]*scale).toFixed(6)));
 }
});

test('form edits use one gain threshold and convert milliseconds and percentages precisely',()=>{
 const before=resolveBotSettings(fixture('current-custom')),original=structuredClone(before),changes:BotSettings[]=[];
 const elements=formElements(before,value=>changes.push(value));
 const change=(key:BotSettingKey,value:number)=>elements.find(e=>e.type==='input'&&e.props.name===key)!.props.onChange!({target:{valueAsNumber:value}});
 change('maxElapsedMs',1.001);assert.equal(changes.at(-1)!.maxElapsedMs,1001);
 change('forceBufferRatio',25.5);assert.equal(changes.at(-1)!.forceBufferRatio,0.255);
 change('remoteUncertaintyForceFraction',0);assert.equal(changes.at(-1)!.remoteUncertaintyForceFraction,0);
 change('minActionGain',5);assert.equal(changes.at(-1)!.minActionGain,5);assert.equal(changes.at(-1)!.minCaptureGain,before.minCaptureGain);
 assert.ok(changes.every(s=>s.schemaVersion===2));assert.deepEqual(before,original);
 change('maxElapsedMs',NaN);assert.ok(Number.isNaN(changes.at(-1)!.maxElapsedMs));assert.throws(()=>resolveBotSettings(changes.at(-1)));
});

test('restore defaults changes only the form draft and keeps an independent canonical copy',()=>{
 const saved=resolveBotSettings(fixture('current-custom')),original=structuredClone(saved),changes:BotSettings[]=[];
 const elements=formElements(saved,value=>changes.push(value));
 assert.equal(changes.length,0);
 elements.find(e=>e.type==='button'&&e.props.type==='button')!.props.onClick!();
 assert.deepEqual(changes,[DEFAULT_BOT_SETTINGS]);assert.notEqual(changes[0],DEFAULT_BOT_SETTINGS);
 assert.deepEqual(saved,original);
 changes[0]!.minCaptureGain=9;assert.equal(DEFAULT_BOT_SETTINGS.minCaptureGain,1);
});
