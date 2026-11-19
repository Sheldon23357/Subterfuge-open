import type {IncomingMessage,ServerResponse} from 'node:http';
import {randomUUID} from 'node:crypto';
import {appendFile,rename,stat} from 'node:fs/promises';
import {errorDiagnostic,type ErrorDiagnostic} from '../../contracts/src/index.js';

export interface RequestDiagnostic {
  kind:'request-error'|'request-slow'|'request-aborted'|'request-rejected';
  at:string;requestId:string;method:string;path:string;stage:string;elapsedMs:number;queueMs?:number;status:number;cause?:ErrorDiagnostic;
}

/** Asynchronous bounded persistence, shared by the lab and its player listener.
 * A failed logger cannot turn an accepted game command into an API failure. */
export function createRequestDiagnosticLog<T=RequestDiagnostic>(path:string,maxBytes=10*1024*1024,echo=true){
  let queue=Promise.resolve(),reportedFailure=false;
  const write=(entry:T)=>{
    const line=JSON.stringify(entry)+'\n';
    if(echo)console.error(line.trimEnd());
    queue=queue.then(async()=>{
      const size=await stat(path).then(s=>s.size).catch(error=>{if(error.code==='ENOENT')return 0;throw error;});
      if(size&&size+Buffer.byteLength(line)>maxBytes)await rename(path,path+'.1');
      await appendFile(path,line,{encoding:'utf8',mode:0o600});reportedFailure=false;
    }).catch(error=>{if(!reportedFailure)console.error(JSON.stringify({kind:'diagnostic-log-failed',cause:errorDiagnostic(error)}));reportedFailure=true;});
  };
  return {write,flush:()=>queue};
}
/** Server-only log: no authorization, query strings, bodies, or hidden world
 * state. The response carries only the correlation ID, never internal errors. */
export function requestDiagnostics(req:IncomingMessage,res:ServerResponse,write:(entry:RequestDiagnostic)=>void=entry=>console.error(JSON.stringify(entry)),correlationId?:string){
  const startedAt=Date.now(),incoming=req.headers['x-request-id'];
  const requestId=correlationId??(typeof incoming==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(incoming)?incoming:randomUUID());
  res.setHeader('X-Request-Id',requestId);
  let stage='receive',queueStart:number|undefined,queueMs:number|undefined,failed=false;
  const rawPath=(req.url??'/').split('?')[0]!;
  const path=/^\/(?:player\/v2|lobby\/v2|ai\/v2)\/[a-zA-Z0-9._/-]+$/.test(rawPath)||/^\/api\/[a-z-]+$/.test(rawPath)?rawPath:'[other-path]';
  const emit=(kind:RequestDiagnostic['kind'],status:number,cause?:ErrorDiagnostic)=>{
    // Logging must never change whether a game command was accepted.
    try{write({kind,at:new Date().toISOString(),requestId,method:req.method??'UNKNOWN',path,stage,elapsedMs:Math.max(0,Date.now()-startedAt),...(queueMs!==undefined?{queueMs}:queueStart!==undefined?{queueMs:Math.max(0,Date.now()-queueStart)}:{}),status,...(cause?{cause}:{})});}catch{}
  };
  res.once('finish',()=>{if(!failed){if(res.statusCode>=400)emit('request-rejected',res.statusCode);else if(Date.now()-startedAt>=5000)emit('request-slow',res.statusCode);}});
  res.once('close',()=>{if(!res.writableFinished&&!failed)emit('request-aborted',res.statusCode);});
  return {
    stage(next:string){if(stage==='queue'&&queueStart!==undefined)queueMs=Math.max(0,Date.now()-queueStart);stage=next;if(next==='queue')queueStart=Date.now();},
    fail(error:unknown,status:number){failed=true;emit('request-error',status,errorDiagnostic(error,true));},
  };
}
