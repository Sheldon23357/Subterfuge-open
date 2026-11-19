import React,{useEffect,useSyncExternalStore} from 'react';
import {gameAudio} from './game-audio.js';
import {MUSIC_TRACKS} from './audio-policy.js';
export function useGameAudio(effects:number){
  useEffect(()=>gameAudio.start(),[]);
  useEffect(()=>gameAudio.setEffects(effects),[effects]);
}
export function AudioSettings(){
  const p=useSyncExternalStore(gameAudio.subscribe,gameAudio.getSnapshot,gameAudio.getSnapshot);
  return <section data-audio-controls aria-label="音乐与音效" className="audio-settings">
    <label className="setting-row"><span>背景音乐</span><input aria-label="音乐音量" type="range" min="0" max="100" value={p.music} onChange={e=>gameAudio.update({music:Number(e.target.value)})}/><b>{p.music}%</b></label>
    <label className="setting-row"><span>配乐曲目</span><select aria-label="配乐曲目" value={p.track} onChange={e=>gameAudio.update({track:e.target.value as typeof p.track})}>{MUSIC_TRACKS.map(t=><option value={t.id} key={t.id}>{t.name} · {t.mood}</option>)}</select></label>
    <div className="audio-buttons"><button type="button" aria-pressed={p.musicMuted} onClick={()=>gameAudio.update({musicMuted:!p.musicMuted})}>{p.musicMuted?'开启音乐':'音乐静音'}</button><button type="button" aria-pressed={p.effectsMuted} onClick={()=>gameAudio.update({effectsMuted:!p.effectsMuted})}>{p.effectsMuted?'开启音效':'音效静音'}</button><button type="button" onClick={()=>gameAudio.next()}>下一首</button></div>
    <label className="setting-row"><span>循环播放全部曲目</span><input type="checkbox" checked={p.playlist} onChange={e=>gameAudio.update({playlist:e.target.checked})}/></label>
  </section>;
}
