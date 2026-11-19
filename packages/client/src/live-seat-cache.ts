/** Keep one view per slot; rebinding discards its previous identity and rejects late responses. */
export class LiveSeatCache<T> {
 private entries=new Map<string,{scope:string;value:T|undefined}>();
 peek(id:string,scope:string):T|undefined{const entry=this.entries.get(id);return entry?.scope===scope?entry.value:undefined;}
 read(id:string,scope:string):T|undefined{
  const entry=this.entries.get(id);
  if(entry?.scope===scope)return entry.value;
  this.entries.set(id,{scope,value:undefined});return undefined;
 }
 write(id:string,scope:string,value:T):boolean{
  const entry=this.entries.get(id);
  if(entry?.scope!==scope||entry.value===value)return false;
  entry.value=value;return true;
 }
}
