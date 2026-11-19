import {createHash,randomUUID} from 'node:crypto';
import {classifyProviderFailure} from './provider-error.js';

const events=new Set(['thread.started','turn.started','turn.completed','turn.failed','error','item.started','item.updated','item.completed']);
const codes=/\b(?:ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE)\b/g;
/** Extract bounded facts, never arbitrary provider text, prompts or account data. */
export class ProviderEvidence {
  readonly callId=randomUUID();
  private pending={stdout:'',stderr:''};
  private dropping={stdout:false,stderr:false};
  private bytes={stdout:0,stderr:0};
  private firstOutputMs:number|null=null;
  private lastOutputMs:number|null=null;
  private counts:Record<string,number>={};
  private lastEvent:{type:string;atMs:number}|null=null;
  private malformedLines=0;
  private oversizedLines=0;
  private reasons=new Set<string>();
  private networkCodes=new Set<string>();
  private httpStatuses=new Set<number>();
  private httpRoutes=new Set<string>();
  private requestIds=new Set<string>();
  private fingerprints=new Set<string>();
  private stderrHash=createHash('sha256');
  constructor(private startedAt:number){}
  private facts(text:string){
    if(/\/models(?:\?|\b)/i.test(text))this.httpRoutes.add('models');
    if(/responses/i.test(text))this.httpRoutes.add('responses');
    if(/\/chat\/completions(?:\?|\b)/i.test(text))this.httpRoutes.add('chat-completions');
    const reason=classifyProviderFailure(text).diagnostic?.reason;
    if(reason&&reason!=='no-recognized-provider-signal')this.reasons.add(reason);
    for(const code of text.match(codes)??[])this.networkCodes.add(code);
    for(const match of text.matchAll(/\b(?:HTTP(?:\/\d(?:\.\d)?)?|status(?:_code)?)["']?\s*[=:]?\s*([45]\d{2})\b/gi))this.httpStatuses.add(Number(match[1]));
    for(const match of text.matchAll(/\brequest[_ -]?id["']?\s*[:=]\s*["']?(req_[\w-]{8,100}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(?=["'\s,;}]|$)/gi)){
      if(this.requestIds.size<8)this.requestIds.add(match[1]!);
    }
  }
  private line(source:'stdout'|'stderr',line:string){
    if(!line.trim())return;
    if(source==='stderr'){this.facts(line);return;}
    let event;
    try{event=JSON.parse(line);}catch{this.malformedLines++;return;}
    const type=events.has(event?.type)?event.type:'other';
    this.counts[type]=(this.counts[type]??0)+1;
    this.lastEvent={type,atMs:this.lastOutputMs??0};
    if(type==='error'||type==='turn.failed'){
      // Error payloads are inspected in memory; only fixed codes and hashes survive.
      const error=event.error??event;
      const message=typeof error==='string'?error:typeof error.message==='string'?error.message:'';
      this.facts(message);
      this.facts(JSON.stringify({status:error.status??error.status_code,request_id:error.request_id??event.request_id,code:error.code}));
      if(message&&this.fingerprints.size<8)this.fingerprints.add(createHash('sha256').update(message).digest('hex'));
    }
  }
  chunk(source:'stdout'|'stderr',text:string,now=Date.now()){
    this.bytes[source]+=Buffer.byteLength(text);
    if(source==='stderr')this.stderrHash.update(text);
    this.firstOutputMs??=Math.max(0,now-this.startedAt);
    this.lastOutputMs=Math.max(0,now-this.startedAt);
    for(const part of text.split(/(?<=\n)/)){
      if(!this.dropping[source]){
        if(this.pending[source].length+part.length>65536){this.oversizedLines++;this.pending[source]='';this.dropping[source]=true;}
        else this.pending[source]+=part;
      }
      if(part.endsWith('\n')){
        if(!this.dropping[source])this.line(source,this.pending[source]);
        this.pending[source]='';this.dropping[source]=false;
      }
    }
  }
  summary(now=Date.now()){
    for(const source of ['stdout','stderr'] as const){
      if(this.pending[source]){this.line(source,this.pending[source]);this.pending[source]='';}
    }
    return {callId:this.callId,startedAt:new Date(this.startedAt).toISOString(),finishedAt:new Date(now).toISOString(),
      stdoutBytes:this.bytes.stdout,stderrBytes:this.bytes.stderr,firstOutputMs:this.firstOutputMs,lastOutputMs:this.lastOutputMs,
      silenceMs:this.lastOutputMs===null?Math.max(0,now-this.startedAt):Math.max(0,now-this.startedAt-this.lastOutputMs),
      events:{...this.counts},lastEvent:this.lastEvent,malformedLines:this.malformedLines,oversizedLines:this.oversizedLines,
      reasons:[...this.reasons],networkCodes:[...this.networkCodes],httpStatuses:[...this.httpStatuses],httpRoutes:[...this.httpRoutes],requestIds:[...this.requestIds],
      errorFingerprints:[...this.fingerprints],stderrSha256:this.stderrHash.copy().digest('hex')};
  }
}
export type ProviderEvidenceSummary=ReturnType<ProviderEvidence['summary']>;
