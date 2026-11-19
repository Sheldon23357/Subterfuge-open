import {PlayerProtocolError} from './player-protocol-auth.js';
export const PROTOCOL_ADMISSION_LIMITS={globalInFlight:128,seatInFlight:8,subjects:4096,readPerSecond:60,writePerSecond:30} as const;
type Bucket={at:number;count:number;inFlight:number};
/** Bounded, ephemeral transport admission. Never authority or persistence. Keys are server-authenticated subject IDs, not user request labels. */
export class PlayerProtocolAdmission {
 private subjects=new Map<string,Bucket>();private inFlight=0;
 enter(subject:string,kind:'read'|'write'){
  const now=performance.now(),key=subject+':'+kind;let bucket=this.subjects.get(key);
  if(!bucket){if(this.subjects.size>=PROTOCOL_ADMISSION_LIMITS.subjects){for(const [key,value]of this.subjects)if(!value.inFlight&&now-value.at>=1000)this.subjects.delete(key);if(this.subjects.size>=PROTOCOL_ADMISSION_LIMITS.subjects)this.busy(kind);}bucket={at:now,count:0,inFlight:0};this.subjects.set(key,bucket);}
  if(now-bucket.at>=1000){bucket.at=now;bucket.count=0;}
  const seatInFlight=[...this.subjects.entries()].filter(([key])=>key.startsWith(subject+':')).reduce((sum,[,b])=>sum+b.inFlight,0),limit=kind==='read'?PROTOCOL_ADMISSION_LIMITS.readPerSecond:PROTOCOL_ADMISSION_LIMITS.writePerSecond;
  if(this.inFlight>=PROTOCOL_ADMISSION_LIMITS.globalInFlight||seatInFlight>=PROTOCOL_ADMISSION_LIMITS.seatInFlight||bucket.count>=limit)this.busy(kind);
  bucket.count++;bucket.inFlight++;this.inFlight++;let released=false;return()=>{if(released)return;released=true;bucket!.inFlight--;this.inFlight--;};
 }
 private busy(kind:'read'|'write'):never{throw new PlayerProtocolError('RATE_LIMITED',429,'Transport admission budget exhausted; retry later','transient',kind==='write'?'rejected':'read-only');}
}
