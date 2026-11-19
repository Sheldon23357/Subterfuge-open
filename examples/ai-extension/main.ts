import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {AgentRuntime,startAgentConsole,parseAgentConfig} from '../../packages/ai/src/runtime.js';
import {exampleRegistry} from './strategies.js';
import {exampleModel} from './model.js';

const args=process.argv.slice(2),options=new Map<string,string>();
for(let i=0;i<args.length;i+=2){const key=args[i],value=args[i+1];if(!key||!['--config','--port','--web-root'].includes(key)||!value||options.has(key))throw Error('Usage: ai:example [--config PATH] [--port PORT] [--web-root PATH]');options.set(key,value);}
const configPath=options.get('--config');
const config=parseAgentConfig(configPath?JSON.parse(readFileSync(configPath,'utf8')):{storeDirectory:mkdtempSync(join(tmpdir(),'subterfuge-ai-example-')),seats:[]});
const runtime=new AgentRuntime(config,exampleModel,configPath?process.env:{},{modes:exampleRegistry(),fixedSlots:!configPath});
const consoleServer=await startAgentConsole(runtime,{webRoot:resolve(options.get('--web-root')??'packages/client/agent-console-public'),port:Number(options.get('--port')??0),provider:'offline',...(configPath?{connectionMode:'configured' as const}:{})});
runtime.serve();
process.stdout.write(consoleServer.url+'\n');
let closing:Promise<void>|undefined;
const close=()=>closing??=(async()=>{await runtime.shutdown();await consoleServer.close();})();
const stop=()=>void close().then(()=>process.exit(0),()=>process.exit(1));
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,stop);
process.on('message',message=>{if((message as {kind?:unknown}|null)?.kind==='shutdown')stop();});
