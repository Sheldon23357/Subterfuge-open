import { MUSIC_TRACKS, type TrackId, type SoundId } from './audio-policy.js';
const key = 'abyss-audio-v1';
const immediateUiSounds = ['ui_click_a','ui_click_b','ui_panel_open'] as const;
export interface AudioPreferences { music:number; musicMuted:boolean; effectsMuted:boolean; track:TrackId; playlist:boolean }
const defaults: AudioPreferences = {music:25,musicMuted:false,effectsMuted:false,track:'bgm_abyssal_planning',playlist:true};
function readPreferences():AudioPreferences {
  try {
    const p=JSON.parse(localStorage.getItem(key)??'{}');
    return {music:typeof p.music==='number'&&Number.isFinite(p.music)?Math.max(0,Math.min(100,p.music)):25,
      musicMuted:p.musicMuted===true,effectsMuted:p.effectsMuted===true,
      track:MUSIC_TRACKS.some(t=>t.id===p.track)?p.track:defaults.track,playlist:p.playlist!==false};
  } catch {return {...defaults};}
}
/** One manager per document; no audio starts until a trusted interaction. */
export class GameAudio {
  private preferences:AudioPreferences={...defaults};
  private listeners=new Set<()=>void>();
  private started=false;
  private unlocked=false;
  private effects=25;
  private music:HTMLAudioElement|null=null;
  private playingTrack:TrackId|null=null;
  private fadeIn:HTMLAudioElement|null=null;
  private fading=new Set<HTMLAudioElement>();
  private activeEffects=new Set<HTMLAudioElement>();
  private uiContext:AudioContext|null=null;
  private uiGain:GainNode|null=null;
  private uiBuffers=new Map<SoundId,AudioBuffer>();
  private activeUi=new Set<AudioBufferSourceNode>();
  private last=new Map<string,number>();
  private clickCount=0;
  private owner=false;
  private timer:ReturnType<typeof setInterval>|null=null;
  private ownerKey='abyss-audio-owner';
  private id='';
  getSnapshot=()=>this.preferences;
  subscribe=(fn:()=>void)=>{this.listeners.add(fn);return ()=>{this.listeners.delete(fn);};};
  update(p:Partial<AudioPreferences>) {
    this.preferences={...this.preferences,...p};
    if(this.preferences.effectsMuted)this.stopEffects();
    if(this.uiGain)this.uiGain.gain.value=this.preferences.effectsMuted?0:this.effects/100;
    try{localStorage.setItem(key,JSON.stringify(this.preferences));}catch{}
    this.listeners.forEach(f=>f());
    this.syncMusic();
  }
  setEffects(value:number){this.effects=Number.isFinite(value)?Math.max(0,Math.min(100,value)):25;for(const a of this.activeEffects)a.volume=this.effects/100;if(this.uiGain)this.uiGain.gain.value=this.preferences.effectsMuted?0:this.effects/100;}
  start(){
    if(this.started || typeof window==='undefined')return;
    this.started=true;this.preferences=readPreferences();this.id=globalThis.crypto?.randomUUID?.() ?? `audio-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.prepareUi();
    this.listeners.forEach(f=>f());
    const unlock=(e:Event)=>{if(e.isTrusted){this.unlocked=true;this.claim(true);if(this.uiContext?.state==='suspended')void this.uiContext.resume().catch(()=>{});this.syncMusic();}};
    document.addEventListener('pointerdown',unlock,{capture:true});
    document.addEventListener('keydown',unlock,{capture:true});
    document.addEventListener('click',e=>{
      if(!e.isTrusted)return;
      const target=e.target instanceof Element?e.target.closest('button,[role="button"],summary'):null;
      if(target && !target.hasAttribute('disabled') && target.getAttribute('aria-disabled')!=='true' && !target.closest('[data-audio-controls],[data-audio-silent]') && !/^(关闭|收起)/.test(target.getAttribute('aria-label')??''))
        this.play(this.clickCount++%2?'ui_click_b':'ui_click_a');
    },{capture:true});
    document.addEventListener('visibilitychange',()=>{
      if(document.visibilityState!=='visible'){this.release();this.silence();}else{this.claim(false);this.syncMusic();}
    });
    window.addEventListener('pagehide',()=>{this.release();this.silence();});
    window.addEventListener('storage',e=>{
      if(e.key===key){this.preferences=readPreferences();this.listeners.forEach(f=>f());this.syncMusic();}
      if(e.key===this.ownerKey){this.claim(false);this.syncMusic();}
    });
    this.timer=setInterval(()=>{this.claim(false);this.syncMusic();},2000);
  }
  private claim(force:boolean){
    if(!this.unlocked || document.visibilityState!=='visible'){this.owner=false;return;}
    try {
      const old=JSON.parse(localStorage.getItem(this.ownerKey)??'null') as {id:string;time:number}|null;
      this.owner=force || !old || old.id===this.id || Date.now()-old.time>6000;
      if(this.owner)localStorage.setItem(this.ownerKey,JSON.stringify({id:this.id,time:Date.now()}));
    } catch {this.owner=document.hasFocus();}
  }
  private release(){
    try{const old=JSON.parse(localStorage.getItem(this.ownerKey)??'null');if(old?.id===this.id)localStorage.removeItem(this.ownerKey);}catch{}
    this.owner=false;
  }
  private allowed(){return this.unlocked&&this.owner&&document.visibilityState==='visible';}
  /** Decode small UI cues ahead of interaction. Never enqueue a late UI cue. */
  private prepareUi(){
    if(typeof AudioContext==='undefined')return;
    try {
      const context=new AudioContext({latencyHint:'interactive'});
      const gain=context.createGain();gain.gain.value=this.preferences.effectsMuted?0:this.effects/100;gain.connect(context.destination);
      this.uiContext=context;this.uiGain=gain;
      const ext=new Audio().canPlayType('audio/ogg; codecs="vorbis"')?'ogg':'mp3';
      for(const id of immediateUiSounds){
        void fetch(`/audio/sfx/${id}.${ext}`).then(response=>{
          if(!response.ok)throw Error('UI audio unavailable');
          return response.arrayBuffer();
        }).then(bytes=>context.decodeAudioData(bytes)).then(buffer=>this.uiBuffers.set(id,buffer)).catch(()=>{});
      }
    } catch {this.uiContext=null;this.uiGain=null;}
  }
  private stopEffects(){
    for(const a of this.activeEffects)a.pause();this.activeEffects.clear();
    for(const source of this.activeUi)source.stop();this.activeUi.clear();
  }
  private make(folder:string,id:string){
    const a=new Audio();
    const ext=a.canPlayType('audio/ogg; codecs="vorbis"')?'ogg':'mp3';
    a.src=`/audio/${folder}/${id}.${ext}`;a.preload='auto';
    return a;
  }
  play(id:SoundId){
    if(id==='ui_panel_close')return;
    if(!this.allowed()||!this.effects||this.preferences.effectsMuted)return;
    const now=Date.now(), cooldown=id==='threat_alert'?6000: id==='message_received'?3000:100;
    if(now-(this.last.get(id)??0)<cooldown || this.activeEffects.size+this.activeUi.size>=5)return;
    if(this.uiContext&&immediateUiSounds.some(sound=>sound===id)){
      const buffer=this.uiBuffers.get(id);
      if(!buffer||this.uiContext.state!=='running'||!this.uiGain)return;
      const source=this.uiContext.createBufferSource();source.buffer=buffer;source.connect(this.uiGain);
      source.onended=()=>{this.activeUi.delete(source);source.disconnect();};
      this.activeUi.add(source);this.last.set(id,now);source.start();return;
    }
    this.last.set(id,now);
    const a=this.make('sfx',id);a.volume=this.effects/100;
    this.activeEffects.add(a);
    const cleanup=()=>this.activeEffects.delete(a);
    a.addEventListener('ended',cleanup,{once:true});a.addEventListener('error',cleanup,{once:true});
    void a.play().catch(cleanup);
  }
  next(){const n=MUSIC_TRACKS.findIndex(t=>t.id===this.preferences.track);this.update({track:MUSIC_TRACKS[(n+1)%MUSIC_TRACKS.length]!.id});}
  private fadeOut(a:HTMLAudioElement){
    this.fading.add(a);const start=a.volume,time=performance.now();
    const frame=()=>{if(!this.fading.has(a))return;const p=Math.min(1,(performance.now()-time)/2500);a.volume=start*(1-p);
      if(p<1)requestAnimationFrame(frame);else{a.pause();a.removeAttribute('src');a.load();this.fading.delete(a);}};
    requestAnimationFrame(frame);
  }
  private silence(all=true){
    this.music?.pause();
    for(const a of this.fading)a.pause();this.fading.clear();
    if(all)this.stopEffects();
  }
  private syncMusic(){
    if(!this.started)return;
    if(!this.allowed()){this.silence();return;}
    if(this.preferences.musicMuted||!this.preferences.music){this.silence(false);return;}
    if(this.playingTrack!==this.preferences.track || !this.music){
      if(this.music)this.fadeOut(this.music);
      const a=this.make('bgm',this.preferences.track);this.music=a;this.playingTrack=this.preferences.track;a.volume=0;this.fadeIn=a;
      a.addEventListener('ended',()=>{if(this.music!==a)return;if(this.preferences.playlist)this.next();else{a.currentTime=0;void a.play().catch(()=>{});}});
      void a.play().then(()=>{
        const time=performance.now();const frame=()=>{if(this.music!==a)return;const p=Math.min(1,(performance.now()-time)/2500);a.volume=(this.preferences.music/100)*p;if(p<1)requestAnimationFrame(frame);else this.fadeIn=null;};frame();
      }).catch(()=>{if(this.music===a){this.fadeIn=null;a.volume=this.preferences.music/100;}});
    } else {
      if(this.fadeIn!==this.music)this.music.volume=this.preferences.music/100;
      if(this.music.paused)void this.music.play().catch(()=>{});
    }
    if(this.music)this.music.loop=!this.preferences.playlist;
  }
}
export const gameAudio=new GameAudio();
