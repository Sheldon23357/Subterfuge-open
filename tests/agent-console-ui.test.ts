import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {NewVoyage} from '../packages/client/src/NewVoyage.js';
import {AgentConsoleConnectionControls,consoleSettingsActionLabel} from '../packages/client/src/AgentConsole.js';
import {AgentConnectionWizard,type ConsoleRequest} from '../packages/client/src/AgentConnectionWizard.js';
import {AgentProviderPanel,providerSaveConfig} from '../packages/client/src/AgentProviderPanel.js';
import {AgentConsoleStart} from '../packages/client/src/AgentConsoleStart.js';
const request:ConsoleRequest=async<T>()=>{throw Error('Unexpected request during render');};
test('start surface offers the binding action until connected and honors start permissions',()=>{
 const props={bound:false,connected:true,canStart:false,canConnect:true,model:'自主决策 · 无需模型',onStart:()=>{},onConfigure:()=>{},onConnect:()=>{}};
 const unbound=renderToStaticMarkup(React.createElement(AgentConsoleStart,props));
 assert.ok(unbound.includes('>连接游戏</button>'));assert.ok(!unbound.includes('>启动 AI</button>'));
 const bound=renderToStaticMarkup(React.createElement(AgentConsoleStart,{...props,bound:true,canStart:true}));
 assert.ok(bound.includes('>启动 AI</button>'));assert.ok(!bound.includes('disabled=""'));
 const disconnected=renderToStaticMarkup(React.createElement(AgentConsoleStart,{...props,bound:true,connected:false}));
 assert.ok(disconnected.includes('disabled=""'));assert.ok(disconnected.includes('运行器连接中断'));
});

test('model configuration excludes the programmatic adapter and expands API fields',()=>{
 const html=renderToStaticMarkup(React.createElement(AgentProviderPanel,{id:'seat',mode:'hybrid',value:{kind:'openai-compatible',model:'test',baseUrl:'https://example.test/v1',hasKey:false},disabled:false,request}));
 assert.ok(!html.includes('value="programmatic"'));assert.ok(html.includes('模型来源'));
 for(const field of ['API 地址','API Key','API 协议','输出格式','超时（毫秒）'])assert.ok(html.includes(field),field);
 assert.ok(!html.includes('<details'));
});

test('hybrid preserves an unconfigured model as an autonomous local configuration',()=>{
 const html=renderToStaticMarkup(React.createElement(AgentProviderPanel,{id:'seat',mode:'hybrid',value:{kind:'offline',model:'',hasKey:false},disabled:false,request}));
 assert.ok(!html.includes('value="programmatic"'));assert.ok(html.includes('value="offline" selected=""'));
 assert.doesNotMatch(html,/>模型<input/);assert.ok(html.includes('不配置模型 · 自主决策'));
});
test('new voyage binds independent controller slots without hosted model controls',()=>{
 const html=renderToStaticMarkup(React.createElement(NewVoyage,{players:2,seed:1,busy:false,error:'',setPlayers:()=>{},setSeed:()=>{},close:()=>{},create:async()=>{},rules:{mode:'mining',teamSize:0,neptuniumGoal:200},setRules:()=>{},startMode:'fresh',setStartMode:()=>{}}));
 assert.ok(html.includes('每个 AI 席位只能绑定一次'));
 assert.ok(!html.includes('默认模型'));assert.ok(!html.includes('性格'));assert.ok(html.includes('>AI</button>'));assert.ok(!html.includes('共用本机 Codex'));
});
test('browser connection directs users to bind from room seats without manual credential controls',()=>{
 const html=renderToStaticMarkup(React.createElement(AgentConnectionWizard,{request,onAdded:async()=>{},onCancel:()=>{},count:0}));
 for(const label of ['从房间绑定 bot','自己的席位或空位','打开游戏大厅'])assert.ok(html.includes(label));
 assert.ok(!html.includes('type="password"'));assert.ok(!html.includes('name="roomId"'));assert.ok(!html.includes('name="gamePlayer"'));
 assert.ok(html.includes('href="http://127.0.0.1:4312"'));
 for(const removed of ['更换大厅','高级连接','type="url"'])assert.ok(!html.includes(removed));
 assert.ok(!html.replace(/\shref="[^"]*"/g,'').includes('127.0.0.1'));
});
test('provider fields expose no stored key and cannot save inherited provider as a new configuration',()=>{
 const html=renderToStaticMarkup(React.createElement(AgentProviderPanel,{id:'seat-0',value:{kind:'openai-compatible',model:'test',baseUrl:'https://example.test/v1',hasKey:true},disabled:false,request}));
 assert.ok(html.includes('type="password"'));assert.ok(html.includes('已配置，留空保留同地址密钥'));assert.ok(html.includes('API · 自定义接口'));assert.ok(!html.includes('读取已保存配置的模型'));
 const inherited=renderToStaticMarkup(React.createElement(AgentProviderPanel,{id:'seat-1',value:{kind:'inherited',hasKey:false},disabled:false,request}));assert.ok(!inherited.includes('type="submit"'));
});

test('untouched compatible form submits exactly its displayed protocol and timeout defaults',()=>{
 const payload=providerSaveConfig({kind:'openai-compatible',model:'test',baseUrl:'https://example.test/v1',hasKey:true},'',false);
 assert.equal(payload.apiStyle,'chat');assert.equal(payload.responseFormat,'json_schema');assert.equal(payload.timeoutMs,120000);assert.ok(!('hasKey' in payload));assert.ok(!('apiKey' in payload));
 assert.equal(providerSaveConfig({kind:'openai-compatible',hasKey:true},'',true).apiKey,'');
});


test('provider form includes vendor presets and never submits server key-source metadata',()=>{
 const html=renderToStaticMarkup(React.createElement(AgentProviderPanel,{id:'seat',value:{kind:'offline',hasKey:false},disabled:false,request}));
 for(const name of ['DeepSeek','OpenRouter','MiniMax'])assert.ok(html.includes('>'+name+'</option>'));
 const config=providerSaveConfig({kind:'openai-compatible',preset:'deepseek',keySource:'environment',hasKey:true,model:'deepseek-flash'},'',false);
 assert.equal(config.preset,'deepseek');assert.ok(!('keySource' in config));assert.ok(!('apiKey' in config));
});

test('native Gemini provider form uses environment credentials without editable key or protocol controls',()=>{
 const value={kind:'gemini' as const,preset:'gemini' as const,model:'gemini-4-argon',hasKey:true,keySource:'environment' as const};
 const html=renderToStaticMarkup(React.createElement(AgentProviderPanel,{id:'seat',value,disabled:false,request}));
 assert.ok(html.includes('Gemini · 原生'));assert.ok(html.includes('已读取环境密钥'));assert.ok(!html.includes('type="password"'));assert.ok(!html.includes('API 协议'));
 const config=providerSaveConfig(value,'',false);assert.equal(config.kind,'gemini');assert.ok(!('apiKey' in config));assert.ok(!('baseUrl' in config));assert.ok(!('keySource' in config));
});


test('configured console renders an explicit mode label without local discovery or legacy connection controls',()=>{
 const html=renderToStaticMarkup(React.createElement(AgentConsoleConnectionControls,{mode:'configured',fixedSlots:false,connected:true,detecting:false,count:2,onDetect:()=>{},onConnect:()=>{}}));
 assert.ok(html.includes('配置文件模式'));assert.ok(html.includes('不检测本机游戏'));
 assert.ok(!html.includes('<button'));assert.ok(!html.includes('aria-label="检测本机游戏"'));assert.ok(!html.includes('aria-label="连接游戏"'));
});

test('local console retains discovery without the plus connection button',()=>{
 const html=renderToStaticMarkup(React.createElement(AgentConsoleConnectionControls,{mode:'local',fixedSlots:true,connected:true,detecting:false,count:8,onDetect:()=>{},onConnect:()=>{}}));
 assert.ok(html.includes('aria-label="检测本机游戏"'));assert.ok(!html.includes('aria-label="连接游戏"'));assert.ok(!html.includes('配置文件模式'));
});

test('console without mode metadata disables discovery without showing a plus connection button',()=>{
 const html=renderToStaticMarkup(React.createElement(AgentConsoleConnectionControls,{mode:undefined,fixedSlots:false,connected:false,detecting:false,count:0,onDetect:()=>{},onConnect:()=>{}}));
 assert.ok(html.includes('aria-label="检测本机游戏"'));assert.ok(!html.includes('aria-label="连接游戏"'));assert.equal([...html.matchAll(/disabled=""/g)].length,1);
});


test('configured setting actions promise only this run while local profiles keep save wording',()=>{
 assert.equal(consoleSettingsActionLabel(true,false),'应用到本次运行');assert.equal(consoleSettingsActionLabel(true,true),'应用中…');
 assert.equal(consoleSettingsActionLabel(false,false),'保存全部');assert.equal(consoleSettingsActionLabel(false,true),'保存中…');
});
