import path from 'node:path';
const neutral=new Set(['model-json','mode-registry','reply-protocol','commander-protocol','tool-arguments','structured-arguments','tool-metadata','provider-timeout']);
const pure=new Set(['local-commit-plan','campaign-model','campaign-ledger','campaign-projection','seat-lifecycle']);
const provider=new Set(['codex','openai-compatible','provider-factory','agent-runtime','agent-cli','index']);
const capabilities=new Set([...provider,'store','store-interfaces','gateway','tools','tool-results','runner','runner-host','decision-loop','observation-collector','agent-diagnostics']);
/** Direct dependency fences, not a claim of whole-program effect verification. */
export function aiBoundaryViolation(file,target,typeOnly=false){
 const normalized=file.split(path.sep).join('/');
 if(!normalized.startsWith('packages/ai/src/'))return null;
 const resolved=target.startsWith('.')?path.posix.normalize(path.posix.join(path.posix.dirname(normalized),target)):target;
 const prefix='packages/ai/src/';
 if(normalized.endsWith('/store-interfaces.ts')&&resolved===prefix+'controller/storage/store.js')return 'repository contracts cannot depend on the SQLite implementation';
 if(normalized.startsWith(prefix+'application/providers/')&&resolved===prefix+'controller/contracts/reply-protocol.js')return 'model transports cannot parse game instructions';
 if(normalized.startsWith(prefix+'controller/')&&(resolved.startsWith(prefix+'modes/')||resolved.startsWith(prefix+'application/')))return 'controller foundation cannot depend on concrete modes or application assembly';
 if((normalized.startsWith(prefix+'controller/')||normalized.startsWith(prefix+'modes/'))&&(target==='@subterfuge/ai'||resolved===prefix+'index.js'))return 'foundation and modes must use controller ports, not the application barrel';
 if(normalized.startsWith(prefix+'modes/')&&resolved.startsWith(prefix+'application/'))return 'bot modes cannot depend on application assembly';
 const mode=normalized.slice(prefix.length).match(/^modes\/([^/]+)\//)?.[1],other=resolved.slice(prefix.length).match(/^modes\/([^/]+)\//)?.[1];
 if(mode&&other&&mode!==other)return 'bot modes cannot depend on each other; extract shared services into controller';
 const source=path.basename(file).replace(/\.tsx?$/,''),destination=path.basename(target).replace(/\.[cm]?[jt]s$/,'');
 if(neutral.has(source)&&provider.has(destination))return 'provider-neutral module cannot depend on provider/runtime entrypoint';
 if(pure.has(source)&&!typeOnly){
  if(!target.startsWith('.'))return 'pure state module cannot import platform capabilities';
  if(capabilities.has(destination))return 'pure state module cannot import execution/storage capabilities';
 }
 return null;
}
