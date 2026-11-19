import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm,readFile,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotPluginCatalog,parseBotPluginManifest} from '../packages/ai/src/application/plugin-catalog.js';
import {BotModeRegistry} from '../packages/ai/src/controller/contracts/mode-registry.js';
import {hybridDefinition} from '../plugins/hybrid/src/api.js';
const manifest={apiVersion:1,id:'sample',name:'Sample',version:'1.0.0',entry:'index.ts'};
async function fixture(){const root=await mkdtemp(join(tmpdir(),'bot-plugins-')),source=join(root,'source'),installed=join(root,'installed');await mkdir(source);await writeFile(join(source,'bot-plugin.json'),JSON.stringify(manifest));return {root,source,installed};}
test('plugin manifest rejects incompatible API, invalid identity and escaping paths',()=>{
 assert.equal(parseBotPluginManifest(manifest).id,'sample');
 for(const change of [{apiVersion:2},{id:'../hybrid'},{entry:'../outside.ts'},{entry:'/tmp/outside.ts'},{version:'latest'},{unknown:true}])assert.throws(()=>parseBotPluginManifest({...manifest,...change}));
});
test('trusted TypeScript plugin installs after resolver sealing, persists and creates separate seat instances',async()=>{
 const f=await fixture();try{
  await writeFile(join(f.source,'index.ts'),"import {defineHybridMode} from '@subterfuge/ai/hybrid'; export default defineHybridMode({id:'sample'},'Sample');");
  const registry=new BotModeRegistry([hybridDefinition]),resolve=registry.resolver(),catalog=new BotPluginCatalog(f.installed,registry);await catalog.load();
  const plugin=await catalog.install(f.source);assert.match(plugin.digest,/^[a-f0-9]{64}$/);
  const settings={mode:'sample',model:'',personality:'schemer' as const};
  const one={},two={};assert.equal(resolve(settings,one),resolve(settings,one));assert.notEqual(resolve(settings,one),resolve(settings,two));
  assert.equal(resolve(settings,one).recordPrefix,'mode-sample');
  await assert.rejects(catalog.install(f.source),/already installed/);
  await writeFile(join(f.source,'index.ts'),'broken source');
  const restored=new BotPluginCatalog(f.installed,new BotModeRegistry([hybridDefinition]));await restored.load();assert.equal(restored.list()[0]!.error,undefined);
  await writeFile(join(f.installed,'sample','plugin.mjs'),'tampered');
  const bad=new BotPluginCatalog(f.installed,new BotModeRegistry([hybridDefinition]));await bad.load();assert.match(bad.list()[0]!.error!,/digest/);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('invalid exports and private host imports fail installation without registering a mode',async()=>{
 const f=await fixture();try{
  const registry=new BotModeRegistry([hybridDefinition]),catalog=new BotPluginCatalog(f.installed,registry);await catalog.load();
  await writeFile(join(f.source,'index.ts'),'export default {id:"wrong"}');await assert.rejects(catalog.install(f.source),/matching/);
  assert.equal(registry.list().length,1);
  await writeFile(join(f.source,'index.ts'),"import x from '@subterfuge/ai/runtime'; export default x;");await assert.rejects(catalog.install(f.source),/public host API/);
  assert.equal(registry.list().length,1);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('directory discovery does not execute code and exposes invalid manifests independently',async()=>{
 const f=await fixture();try{
  await writeFile(join(f.source,'index.ts'),"throw Error('must not execute while scanning');");
  const catalog=new BotPluginCatalog(f.installed,new BotModeRegistry([hybridDefinition]));
  const found=await catalog.scan(f.root);assert.equal(found.length,1);assert.equal(found[0]!.manifest!.id,'sample');
  await writeFile(join(f.source,'bot-plugin.json'),'{broken');
  const invalid=await catalog.scan(f.root);assert.equal(invalid.length,1);assert(invalid[0]!.error);
  assert.equal(catalog.list().length,0);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('missing or corrupt plugins remain diagnosable but fail closed before control acquisition',async()=>{
 const f=await fixture();try{
  const registry=new BotModeRegistry([hybridDefinition]),catalog=new BotPluginCatalog(f.installed,registry);
  await catalog.load();catalog.markMissing(['lost-bot']);
  const settings={mode:'lost-bot',model:'',personality:'schemer' as const};
  // State can be restored with the exact identity; no fallback to hybrid.
  assert.equal(registry.resolver()(settings).id,'lost-bot');
  assert.throws(()=>registry.assertAvailable('lost-bot'),/missing/);
  assert.equal(catalog.validate('lost-bot',undefined).valid,false);
  assert.match(catalog.list()[0]!.error!,/missing/);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('an explicit unused-plugin update replaces immutable code and refreshes the resolver cache',async()=>{
 const f=await fixture();try{
  const code=(label:string)=>`import {defineHybridMode} from '@subterfuge/ai/hybrid';export default {...defineHybridMode({id:'sample'},'Sample'),create:config=>({...defineHybridMode({id:'sample'},'Sample').create(config),diagnostics:()=>({build:'${label}'})})};`;
  await writeFile(join(f.source,'index.ts'),code('one'));
  const registry=new BotModeRegistry([hybridDefinition]),resolver=registry.resolver(),catalog=new BotPluginCatalog(f.installed,registry);await catalog.load();await catalog.install(f.source);
  const settings={mode:'sample',model:'',personality:'schemer' as const},owner={};const old=resolver(settings,owner);
  await writeFile(join(f.source,'index.ts'),code('two'));
  await assert.rejects(catalog.install(f.source,()=>{throw Error('still in use');}),/still in use/);
  assert.equal(resolver(settings,owner),old);
  await catalog.install(f.source,()=>{});
  const updated=resolver(settings,owner);assert.notEqual(updated,old);assert.deepEqual(updated.diagnostics!({observation:undefined,latest:()=>undefined}),{build:'two'});
  await writeFile(join(f.source,'index.ts'),'invalid typescript ^^^');await assert.rejects(catalog.install(f.source,()=>{}));
  assert.equal(resolver(settings,owner),updated);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('interrupted update restores the last installed bundle before loading',async()=>{
 const f=await fixture();try{
  await writeFile(join(f.source,'index.ts'),"import {defineHybridMode} from '@subterfuge/ai/hybrid';export default defineHybridMode({id:'sample'},'Sample');");
  const catalog=new BotPluginCatalog(f.installed,new BotModeRegistry([hybridDefinition]));await catalog.load();await catalog.install(f.source);
  await rename(join(f.installed,'sample'),join(f.installed,'.previous-interrupted'));
  const restored=new BotPluginCatalog(f.installed,new BotModeRegistry([hybridDefinition]));await restored.load();
  assert.equal(restored.list()[0]!.error,undefined);assert.equal(restored.validate('sample',undefined).valid,true);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
