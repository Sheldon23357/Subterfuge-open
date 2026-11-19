import {createHash} from 'node:crypto';
import type {AiSnapshot,NotebookEntry} from '../contracts/types.js';
import {isActiveNote} from './memory-records.js';
import {activeCampaign} from './campaign-state.js';

/** Private, seat-scoped lifecycle projection. Never an active record or proof of an outcome. */
export interface NotebookDependencySummary {id:string;status:string;summary:string;lastContentUpdatedAt:number;version:string}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,24);
export function noteDependencySummary(note:NotebookEntry,now:number,removed=false):NotebookDependencySummary{
  const status=removed?'removed':note.expiresAt!==null&&note.expiresAt<=now?'expired':note.record?.status??'unstructured';
  const summary={id:`note:${note.id}`,status,summary:note.record?.summary??'历史记录；正文可查询归档',lastContentUpdatedAt:note.updatedAt};
  return {...summary,version:`${digest(note)}:${status}`};
}
export function notebookDependencies(snapshot:AiSnapshot){
  const now=snapshot.observation.view.tick*600+snapshot.observation.secondsSinceLastTick;
  const targets=new Map<string,{id:string;active:boolean;summary?:NotebookDependencySummary}>();
  for(const summary of snapshot.notebookDependencies??[])targets.set(summary.id,{id:summary.id,active:false,summary});
  for(const note of snapshot.notebook??[]){const id=`note:${note.id}`;targets.set(id,{id,active:isActiveNote(note,now),...(!isActiveNote(note,now)?{summary:noteDependencySummary(note,now)}:{})});}
  for(const campaign of snapshot.campaigns??[]){
    const id=`campaign:${campaign.id}`,active=activeCampaign(campaign);
    targets.set(id,{id,active,...(!active?{summary:{id,status:campaign.stage,summary:campaign.objective,lastContentUpdatedAt:(campaign.authoredAtTick??campaign.createdTick)*600,version:digest(campaign)}}:{})});
  }
  const resolve=(reference:string)=>{
    // Explicit types are never stripped twice, and ambiguous legacy IDs stay unknown.
    if(reference.startsWith('note:')||reference.startsWith('campaign:'))return targets.get(reference);
    const candidates=[targets.get(`note:${reference}`),targets.get(`campaign:${reference}`)].filter(x=>x!==undefined);
    return candidates.length===1?candidates[0]:undefined;
  };
  return {resolve};
}
/** Apply finalization before checking coverage; removed entries become tombstones. */
export function notebookAfterChanges(snapshot:AiSnapshot,set:NotebookEntry[],remove:string[]):AiSnapshot{
  const now=snapshot.observation.view.tick*600+snapshot.observation.secondsSinceLastTick;
  const notes=new Map((snapshot.notebook??[]).map(n=>[n.id,n]));
  const history=new Map((snapshot.notebookDependencies??[]).map(n=>[n.id,n]));
  for(const id of remove){const note=notes.get(id);if(note)history.set(`note:${id}`,noteDependencySummary(note,now,true));else {const old=history.get(`note:${id}`);if(old)history.set(old.id,{...old,status:'removed',version:old.version.split(':')[0]+':removed'});}notes.delete(id);}
  for(const note of set){notes.set(note.id,note);history.delete(`note:${note.id}`);}
  return {...snapshot,notebook:[...notes.values()],notebookDependencies:[...history.values()]};
}
