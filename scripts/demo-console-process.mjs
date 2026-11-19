import {readFileSync,rmSync} from 'node:fs';
import {join,basename} from 'node:path';
// Development-only wrapper: close the existing CLI if its launcher disappears.
if(!process.send)throw Error('Start with npm run demo:agent');
// Windows terminates SIGTERM targets without running JavaScript handlers.
// Deliver the existing CLI shutdown handler in-process instead.
process.once('disconnect',()=>process.emit('SIGTERM'));
process.on('message',message=>{if(message?.kind==='stop')process.emit('SIGTERM');});
process.channel?.unref();
process.once('exit',()=>{const directory=process.env.SUBTERFUGE_DEMO_DIRECTORY;try{if(directory&&basename(directory).startsWith('subterfuge-agent-demo-')&&readFileSync(join(directory,'demo.marker'),'utf8')==='synthetic-agent-demo/1')rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});}catch{}});
await import('../dist/packages/ai/src/application/agent-cli.js');
