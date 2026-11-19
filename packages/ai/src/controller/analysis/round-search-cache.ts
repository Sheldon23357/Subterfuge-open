import {createHash} from 'node:crypto';
import {serialize} from 'node:v8';

/** Exact inputs, scoped to a seat's current decision round only. */
export const searchInputKey=(value:unknown)=>createHash('sha256').update(serialize(value)).digest('hex');
export class RoundSearchCache<T> {
 private entries=new Map<string,{scope:string;round:number;value:T;bytes:number}>();
 private rounds=new Map<string,number>();private bytes=0;
 constructor(private readonly maxBytes=16*1024*1024,private readonly maxEntries=256){}
 private advance(scope:string,round:number){
  if(this.rounds.get(scope)!==round)for(const [key,row] of this.entries)if(row.scope===scope)this.remove(key);
  this.rounds.delete(scope);this.rounds.set(scope,round);
  while(this.rounds.size>64){const oldest=this.rounds.keys().next().value!;this.rounds.delete(oldest);for(const [key,row] of this.entries)if(row.scope===oldest)this.remove(key);}
 }
 private remove(key:string){const row=this.entries.get(key);if(row){this.bytes-=row.bytes;this.entries.delete(key);}}
 get(scope:string,round:number,key:string):T|undefined{
  this.advance(scope,round);const row=this.entries.get(JSON.stringify([scope,key]));
  return row?.round===round?structuredClone(row.value):undefined;
 }
 set(scope:string,round:number,key:string,value:T){
  if(round<(this.rounds.get(scope)??round))return;
  this.advance(scope,round);const bytes=serialize(value).byteLength;if(bytes>this.maxBytes)return;
  const id=JSON.stringify([scope,key]);this.remove(id);this.entries.set(id,{scope,round,value:structuredClone(value),bytes});this.bytes+=bytes;
  while(this.bytes>this.maxBytes||this.entries.size>this.maxEntries)this.remove(this.entries.keys().next().value!);
 }
 clear(){this.entries.clear();this.rounds.clear();this.bytes=0;}
}
