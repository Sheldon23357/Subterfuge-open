import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {ProviderError,classifyProviderFailure} from '../../controller/contracts/provider-error.js';
import {errorDiagnostic} from '../../../../contracts/src/index.js';

/** One bounded stdio connection. A call owns its process; no idle native worker
 * survives provider completion, shutdown or cancellation. Never save stderr. */
export class CodexRpc {
 private child:ChildProcessWithoutNullStreams;
 private pending=new Map<number,{resolve:(v:any)=>void;reject:(e:unknown)=>void}>();
 private waiters=new Set<{match:(v:any)=>boolean;resolve:(v:any)=>void;reject:(e:unknown)=>void}>();
 private events:any[]=[];
 private serial=0;private buffer='';private bytes=0;private stderr='';private failed:unknown;private ended=false;private closing=false;
 private exited:Promise<void>;
 constructor(executable:string,args:string[],cwd:string,private signal:AbortSignal,private onEvent:(event:any)=>void){
  this.child=spawn(executable,args,{cwd,windowsHide:true,stdio:['pipe','pipe','pipe'],shell:false});
  this.exited=new Promise(resolve=>this.child.once('close',()=>{this.ended=true;resolve();}));
  this.child.once('error',error=>this.fail(new ProviderError('unavailable',undefined,{stage:'spawn',outcome:'not-sent',cause:errorDiagnostic(error)})));
  this.child.once('close',(code)=>{if(!this.closing&&!this.failed)this.fail(new ProviderError('unavailable',undefined,{stage:'app-server-exit',outcome:'unknown',exitCode:code}));});
  this.child.stdout.setEncoding('utf8');this.child.stdout.on('data',(chunk:string)=>{
   this.bytes+=Buffer.byteLength(chunk);if(this.bytes>2_000_000)return this.fail(new ProviderError('invalid-response',undefined,{stage:'app-server-output',outcome:'unknown',reason:'output-limit'}));
   this.buffer+=chunk;
   for(let newline;(newline=this.buffer.indexOf('\n'))>=0;){const line=this.buffer.slice(0,newline);this.buffer=this.buffer.slice(newline+1);if(!line.trim())continue;
    let message:any;try{message=JSON.parse(line);}catch{return this.fail(new ProviderError('invalid-response',undefined,{stage:'app-server-output',reason:'invalid-json',outcome:'unknown'}));}
    if(!message||typeof message!=='object'||Array.isArray(message))return this.fail(new ProviderError('invalid-response',undefined,{stage:'app-server-output',outcome:'unknown',reason:'invalid-json'}));
    this.receive(message);
   }
  });
  this.child.stderr.setEncoding('utf8');this.child.stderr.on('data',(chunk:string)=>{this.stderr=(this.stderr+chunk).slice(-12000);if(this.stderr.split(/\r?\n/).some(line=>/responses/i.test(line)&&/\b429\b/.test(line)))this.fail(new ProviderError('transient',undefined,{stage:'provider-output',outcome:'rejected',reason:'rate-limit',httpStatus:429}));});
  this.child.stdin.on('error',()=>{if(!this.closing)this.fail(new ProviderError('unavailable',undefined,{stage:'app-server-input',outcome:'unknown'}));});
  signal.addEventListener('abort',this.abort,{once:true});if(signal.aborted)this.abort();
 }
 private abort=()=>this.fail(this.signal.reason instanceof ProviderError?this.signal.reason:new ProviderError('cancelled'));
 private receive(message:any){
  if(message.id!==undefined&&!message.method){const p=this.pending.get(message.id);if(!p)return;this.pending.delete(message.id);
   if(message.error){const classified=classifyProviderFailure(String(message.error.message??''));p.reject(new ProviderError(classified.code,undefined,{stage:'app-server-rpc',outcome:'rejected',...(classified.diagnostic?.reason?{reason:classified.diagnostic.reason}:{})}));}
   else p.resolve(message.result);return;
  }
  // No server-initiated request may authorize tools, approvals or user input.
  if(message.id!==undefined&&message.method){this.child.stdin.write(JSON.stringify({id:message.id,error:{code:-32601,message:'Native execution is disabled'}})+'\n');return this.fail(new ProviderError('native-tool',undefined,{stage:'app-server-request',outcome:'unknown'}));}
  try{this.onEvent(message);}catch(error){return this.fail(error);}
  if(!['turn/completed','thread/tokenUsage/updated','item/completed'].includes(message.method))return;
  this.events.push(message);if(this.events.length>96)this.events.shift();
  for(const w of [...this.waiters])if(w.match(message)){this.waiters.delete(w);w.resolve(message);}
 }
 private kill(){if(this.ended||this.child.exitCode!==null||this.child.signalCode!==null)return;if(process.platform==='win32'&&this.child.pid){const killer=spawn('taskkill',['/PID',String(this.child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});killer.on('error',()=>this.child.kill());}else this.child.kill('SIGKILL');}
 private fail(error:unknown){if(this.failed)return;this.failed=error;for(const p of this.pending.values())p.reject(error);this.pending.clear();for(const w of this.waiters)w.reject(error);this.waiters.clear();this.kill();}
 request(method:string,params:unknown={}):Promise<any>{
  if(this.failed)return Promise.reject(this.failed);if(this.ended)return Promise.reject(new ProviderError('unavailable',undefined,{stage:'app-server-rpc',outcome:'not-sent'}));
  return new Promise((resolve,reject)=>{const id=++this.serial;this.pending.set(id,{resolve,reject});this.child.stdin.write(JSON.stringify({id,method,params})+'\n');});
 }
 notify(method:string){if(!this.failed&&!this.ended)this.child.stdin.write(JSON.stringify({method})+'\n');}
 wait(match:(v:any)=>boolean):Promise<any>{if(this.failed)return Promise.reject(this.failed);const found=this.events.find(match);return found?Promise.resolve(found):new Promise((resolve,reject)=>this.waiters.add({match,resolve,reject}));}
 async close(){
  this.signal.removeEventListener('abort',this.abort);this.closing=true;if(!this.ended)this.child.stdin.end();
  const timer=setTimeout(()=>this.kill(),2000);try{await this.exited;}finally{clearTimeout(timer);}
 }
}
