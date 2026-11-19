import {createRequire} from 'node:module';
import type {build as Esbuild} from 'esbuild';
declare const __BOT_PLUGIN_BUNDLED__: boolean;
const packaged=typeof __BOT_PLUGIN_BUNDLED__!=='undefined'&&__BOT_PLUGIN_BUNDLED__;
function compiler():typeof Esbuild {
 try{return (createRequire(import.meta.url)(packaged?'./compiler/esbuild/lib/main.js':'esbuild') as typeof import('esbuild')).build;}
 catch{throw Error(packaged?'Bundled plugin compiler is unavailable; restore the matching host distribution.':'Project plugin compiler is unavailable; install project dependencies first.');}
}
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,rm,readdir,lstat,realpath} from 'node:fs/promises';
import {isAbsolute,relative,resolve,join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import sdkExports from '../../../bot-sdk/exports.json' with {type:'json'};
export const defaultPluginDirectory=fileURLToPath(new URL(packaged?'../plugins/':'../../../../../plugins/',import.meta.url));
import type {BotModeDefinition} from '../controller/contracts/bot-mode.js';
import type {BotModeRegistry} from '../controller/contracts/mode-registry.js';

export const BOT_PLUGIN_API_VERSION=1;
export interface BotPluginManifest {apiVersion:1;id:string;name:string;version:string;entry:string;description?:string}
export interface InstalledBotPlugin {manifest:BotPluginManifest;digest:string;directory:string}
export interface BotPluginStatus {id:string;name:string;version:string;digest:string;error?:string}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export function parseBotPluginManifest(raw:unknown):BotPluginManifest {
 if(!object(raw)||Object.keys(raw).some(k=>!['apiVersion','id','name','version','entry','description'].includes(k)))throw Error('Invalid bot plugin manifest');
 if(raw.apiVersion!==BOT_PLUGIN_API_VERSION)throw Error('Unsupported bot plugin API version');
 if(typeof raw.id!=='string'||! /^[a-z][a-z0-9-]{0,39}$/.test(raw.id))throw Error('Invalid or reserved bot plugin ID');
 if(typeof raw.name!=='string'||!raw.name.trim()||raw.name.length>100||typeof raw.version!=='string'||! /^\d+\.\d+\.\d+$/.test(raw.version))throw Error('Invalid bot plugin name or version');
 if(typeof raw.entry!=='string'||! /\.[cm]?[jt]s$/.test(raw.entry)||isAbsolute(raw.entry)||raw.entry.split(/[\\/]/).includes('..'))throw Error('Plugin entry must be a relative TypeScript or JavaScript file');
 if(raw.description!==undefined&&(typeof raw.description!=='string'||raw.description.length>1000))throw Error('Invalid bot plugin description');
 return {...raw} as unknown as BotPluginManifest;
}
function definition(raw:unknown,manifest:BotPluginManifest):BotModeDefinition {
 if(!object(raw)||raw.id!==manifest.id||typeof raw.create!=='function'||typeof raw.validateConfig!=='function'||!object(raw.capabilities)||typeof raw.capabilities.model!=='boolean'||typeof raw.capabilities.commander!=='boolean')throw Error('Plugin must default-export a matching BotModeDefinition');
 return {...raw,label:manifest.name} as unknown as BotModeDefinition;
}
/** Trusted local code, same process as the host. This is not a security sandbox.
 * Installed bundles are immutable; source edits do not change running seats. */
export class BotPluginCatalog {
 private readonly installed=new Map<string,InstalledBotPlugin>();
 private readonly failures:BotPluginStatus[]=[];
 private pending=Promise.resolve();
 constructor(private readonly directory:string,private readonly registry:BotModeRegistry,private readonly sources=defaultPluginDirectory){}
 list():BotPluginStatus[]{return [...this.installed.values()].map(p=>({id:p.manifest.id,name:p.manifest.name,version:p.manifest.version,digest:p.digest})).concat(this.failures);}
 /** Discovery reads manifests only; scanning never imports executable code. */
 async scan(source:string):Promise<Array<{directory:string;manifest?:BotPluginManifest;error?:string}>>{
  if(typeof source!=='string'||!isAbsolute(source))throw Error('Choose an absolute local plugin directory');
  const root=await realpath(source),entries=await readdir(root,{withFileTypes:true});
  if(entries.length>2000)throw Error('Plugin directory is too large; select a more specific folder');
  const result:Array<{directory:string;manifest?:BotPluginManifest;error?:string}>=[];
  // A selected plugin folder itself, or a folder containing plugin folders.
  const candidates=[root,...entries.filter(e=>e.isDirectory()&&!e.name.startsWith('.')).map(e=>join(root,e.name))];
  for(const directory of candidates){try{const raw=await this.readManifest(directory);result.push({directory,manifest:parseBotPluginManifest(JSON.parse(raw))});}
   catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')result.push({directory,error:error instanceof Error?error.message:'Invalid plugin'});}}
  return result;
 }
 validate(id:string,config:unknown):{checks:{name:string;passed:boolean;message?:string}[];valid:boolean}{
  const checks:Array<{name:string;passed:boolean;message?:string}>=[];
  const check=(name:string,run:()=>void)=>{try{run();checks.push({name,passed:true});return true;}catch(e){checks.push({name,passed:false,message:e instanceof Error?e.message:'Validation failed'});return false;}};
  let mode:ReturnType<BotModeDefinition['create']>|undefined;
  const settings={mode:id,model:'',personality:'schemer' as const,strategyConfig:config};
  if(check('配置接口',()=>{this.registry.assertAvailable(id);this.registry.validate(settings);})){check('实例及能力接口',()=>{
   const resolveMode=this.registry.resolver();mode=resolveMode(settings,{});const second=resolveMode(settings,{});
   if(mode===second||typeof mode.prepare!=='function'||typeof mode.needsAnalysis!=='function'||typeof mode.retainSignals!=='function')throw Error('Plugin must create independent instances with prepare, needsAnalysis and retainSignals');
  });}
  return {checks,valid:checks.every(c=>c.passed)};
 }
 noteUnavailable(id:string,message:string){this.registry.markUnavailable(id,message);if(!this.failures.some(f=>f.id===id))this.failures.push({id,name:id,version:'',digest:'',error:message});}
 markMissing(ids:readonly string[]){for(const id of ids){if(this.registry.list().some(m=>m.id===id))continue;
  this.registry.markUnavailable(id,'Installed plugin folder is missing');this.failures.push({id,name:id,version:'',digest:'',error:'Installed plugin folder is missing'});
 }}
 async load(){
  await mkdir(this.directory,{recursive:true,mode:0o700});
  // Recover an interrupted replacement before restoring seat identities.
  for(const name of (await readdir(this.directory)).filter(n=>n.startsWith('.previous-'))){
   const backup=join(this.directory,name);
   try{
   const manifest=parseBotPluginManifest(JSON.parse(await readFile(join(backup,'installed.json'),'utf8')).manifest);
   const destination=join(this.directory,manifest.id);
   try{await lstat(destination);await rm(backup,{recursive:true,force:true});}
   catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;await rename(backup,destination);}
   }catch(error){this.failures.push({id:name,name:'Interrupted plugin update',version:'',digest:'',error:error instanceof Error?error.message:'Recovery failed'});}
  }
  for(const entry of (await readdir(this.directory)).filter(n=>/^[a-z][a-z0-9-]{0,39}$/.test(n)).sort()){
   try{const path=join(this.directory,entry),record=JSON.parse(await readFile(join(path,'installed.json'),'utf8')) as InstalledBotPlugin;
    const manifest=parseBotPluginManifest(record.manifest);if(manifest.id!==entry)throw Error('Plugin directory identity mismatch');
    const bundle=await readFile(join(path,'plugin.mjs'));if(createHash('sha256').update(bundle).digest('hex')!==record.digest)throw Error('Plugin bundle digest mismatch');
    await this.activate({...record,manifest,directory:path});
   }catch(error){const message=error instanceof Error?error.message:'Plugin load failed';this.failures.push({id:entry,name:entry,version:'',digest:'',error:message});this.registry.markUnavailable(entry,message);}
  }
 }
 install(source:string,assertUnused?: (id:string)=>void):Promise<BotPluginStatus>{
  const run=this.pending.then(()=>this.installOne(source,assertUnused));this.pending=run.then(()=>{},()=>{});return run;
 }
 private async readManifest(directory:string){
  const path=join(directory,'bot-plugin.json');if((await lstat(path)).size>16384)throw Error('Plugin manifest exceeds 16 KiB');
  return readFile(path,'utf8');
 }
 private async activate(record:InstalledBotPlugin,prepared?:BotModeDefinition,replace=false){
  const mode=prepared??definition((await import(pathToFileURL(join(record.directory,'plugin.mjs')).href)).default,record.manifest);
  if(replace)this.registry.replace(mode);else this.registry.install(mode);
  const failure=this.failures.findIndex(f=>f.id===mode.id);if(failure>=0)this.failures.splice(failure,1);
  this.installed.set(mode.id,record);
 }
 private async installOne(source:string,assertUnused?: (id:string)=>void){
  if(typeof source!=='string'||!source.trim()||!isAbsolute(source))throw Error('Choose an absolute local plugin directory');
  const root=await realpath(source),manifest=parseBotPluginManifest(JSON.parse(await this.readManifest(root)));
  const replacing=this.registry.list().some(m=>m.id===manifest.id);
  if(replacing&&!assertUnused)throw Error('Plugin ID is already installed; switch its seats to another plugin before updating');
  if(replacing)assertUnused!(manifest.id);
  const finishChange=this.registry.beginChange(manifest.id);
  try{return await this.compileAndInstall(root,manifest,replacing);}finally{finishChange();}
 }
 private async compileAndInstall(root:string,manifest:BotPluginManifest,replacing:boolean){
  const entry=await realpath(resolve(root,manifest.entry)),part=relative(root,entry);if(part.startsWith('..')||isAbsolute(part)||!(await lstat(entry)).isFile())throw Error('Plugin entry escapes its directory');
  const hostEntries=new Map(Object.keys(sdkExports).map(key=>['@subterfuge/bot-sdk'+(key==='index'?'':'/'+key),new URL(packaged?'./sdk-'+key.replaceAll('/','--')+'.js':'../../../bot-sdk/src/'+key+'.js',import.meta.url).href]));
  // Existing source extensions use the same SDK root; concrete hybrid code stays external to the host.
  hostEntries.set('@subterfuge/ai',hostEntries.get('@subterfuge/bot-sdk')!);
  hostEntries.set('@subterfuge/contracts',hostEntries.get('@subterfuge/bot-sdk/contracts')!);
  const hybridEntry=join(this.sources,'hybrid','src','api.ts');
  const compiled=await compiler()({entryPoints:[entry],bundle:true,write:false,platform:'node',format:'esm',target:'node22',logLevel:'silent',plugins:[{name:'bot-host-api',setup:b=>{
   b.onResolve({filter:/^@subterfuge\//},args=>{if(args.path==='@subterfuge/hybrid'||args.path==='@subterfuge/ai/hybrid')return {path:hybridEntry};const path=hostEntries.get(args.path);if(!path)throw Error('Plugin import is not a public host API: '+args.path);return {path,external:true};});
  }}]});
  const bundle=compiled.outputFiles[0]!.contents,digest=createHash('sha256').update(bundle).digest('hex');
  await mkdir(this.directory,{recursive:true,mode:0o700});const staging=join(this.directory,'.pending-'+randomUUID()),destination=join(this.directory,manifest.id);
  try{await mkdir(staging,{mode:0o700});await writeFile(join(staging,'plugin.mjs'),bundle,{mode:0o600});
   const record={manifest,digest,directory:destination};await writeFile(join(staging,'installed.json'),JSON.stringify(record),{mode:0o600});
   // Validate trusted code before publishing the installed directory.
   const module=await import(pathToFileURL(join(staging,'plugin.mjs')).href);const prepared=definition(module.default,manifest);
   const backup=join(this.directory,'.previous-'+randomUUID());let backedUp=false;
   if(replacing){try{await rename(destination,backup);backedUp=true;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
   try{await rename(staging,destination);await this.activate(record,prepared,replacing);}catch(e){if(backedUp){await rm(destination,{recursive:true,force:true});await rename(backup,destination);}throw e;}
   if(backedUp)await rm(backup,{recursive:true,force:true}).catch(()=>{});
   return this.list().find(p=>p.id===manifest.id)!;
  }catch(error){await rm(staging,{recursive:true,force:true});throw error;}
 }
}
