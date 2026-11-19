import test from 'node:test';
import assert from 'node:assert/strict';
import {GameAudio} from '../packages/client/src/game-audio.js';

test('audio respects gestures, independent mute, hidden pages, tab ownership and fallback IDs',async()=>{
 const original=new Map<string,PropertyDescriptor|undefined>();
 const put=(key:string,value:unknown)=>{original.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});};
 const handlers=new Map<string,((e:any)=>void)[]>();
 const on=(key:string,fn:(e:any)=>void)=>handlers.set(key,[...(handlers.get(key)??[]),fn]);
 const fire=(key:string,e:any={})=>handlers.get(key)?.forEach(fn=>fn(e));
 const store=new Map<string,string>();const audios:FakeAudio[]=[];let pulse:()=>void=()=>{};
 class FakeAudio {
  src='';preload='';volume=1;paused=true;loop=false;currentTime=0;
  constructor(){audios.push(this);}
  canPlayType(){return '';}
  play(){this.paused=false;return Promise.resolve();}
  pause(){this.paused=true;}
  addEventListener(){} removeAttribute(){} load(){}
 }
 const doc={visibilityState:'visible',addEventListener:on,hasFocus:()=>true};
 put('document',doc);put('window',{addEventListener:on});put('crypto',{});
 put('localStorage',{getItem:(k:string)=>store.get(k)??null,setItem:(k:string,v:string)=>store.set(k,v),removeItem:(k:string)=>store.delete(k)});
 put('Audio',FakeAudio);put('requestAnimationFrame',()=>0);put('setInterval',(fn:()=>void)=>{pulse=fn;return 1;});
 try {
  const a=new GameAudio();a.start();a.play('order_confirm');assert.equal(audios.length,0,'no autoplay before gesture');
  fire('pointerdown',{isTrusted:false});assert.equal(audios.length,0);
  fire('pointerdown',{isTrusted:true});assert.equal(audios.length,1);assert.match(audios[0]!.src,/\.mp3$/);assert.equal(audios[0]!.paused,false);
  await Promise.resolve();
  pulse();assert.ok(audios[0]!.volume<0.01,'heartbeat must not jump active fade-in to full volume');
  a.update({musicMuted:true});assert.equal(audios[0]!.paused,true);
  a.play('order_confirm');assert.equal(audios.length,2,'music mute does not mute effects');
  a.update({effectsMuted:true});a.play('fleet_launch');assert.equal(audios.length,2);
  a.update({effectsMuted:false,musicMuted:false});
  doc.visibilityState='hidden';fire('visibilitychange');assert.ok(audios.every(x=>x.paused));
  a.play('fleet_launch');assert.equal(audios.length,2);
  doc.visibilityState='visible';store.set('abyss-audio-owner',JSON.stringify({id:'another-tab',time:Date.now()}));fire('visibilitychange');
  assert.equal(audios[0]!.paused,true,'background tab cannot steal fresh ownership');
  fire('keydown',{isTrusted:true});assert.equal(audios[0]!.paused,false,'new gesture claims audio ownership');
  a.update({playlist:false});assert.equal(audios[0]!.loop,true);
  a.next();assert.equal(a.getSnapshot().track,'bgm_abyssal_tension');assert.equal(audios.length,3);
 }finally{for(const [key,d] of original){if(d)Object.defineProperty(globalThis,key,d);else Reflect.deleteProperty(globalThis,key);}}
});

test('UI sounds decode ahead of clicks, start synchronously when ready, and never replay late or on close',async()=>{
 const original=new Map<string,PropertyDescriptor|undefined>();
 const put=(key:string,value:unknown)=>{original.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});};
 const handlers=new Map<string,((e:any)=>void)[]>();
 const on=(key:string,fn:(e:any)=>void)=>handlers.set(key,[...(handlers.get(key)??[]),fn]);
 const fire=(key:string,e:any={})=>handlers.get(key)?.forEach(fn=>fn(e));
 const pending:((response:unknown)=>void)[]=[];
 const sources:{started:boolean;stopped:boolean;onended:(()=>void)|null;start:()=>void;stop:()=>void;connect:()=>void;disconnect:()=>void;buffer:unknown}[]=[];
 const gain={gain:{value:0},connect(){}};
 let htmlPlays=0;
 class FakeAudio {canPlayType(){return 'probably';}play(){htmlPlays++;return Promise.resolve();}}
 class FakeContext {
  state='suspended';destination={};
  createGain(){return gain;}
  resume(){this.state='running';return Promise.resolve();}
  decodeAudioData(){return Promise.resolve({decoded:true});}
  createBufferSource(){
   const source={buffer:null as unknown,started:false,stopped:false,onended:null as (()=>void)|null,connect(){},disconnect(){},start(){this.started=true;},stop(){this.stopped=true;this.onended?.();}};
   sources.push(source);return source;
  }
 }
 class FakeElement {
  constructor(private label='',private silent=false){}
  closest(selector:string){return selector.startsWith('button')?this:this.silent?this:null;}
  hasAttribute(){return false;}
  getAttribute(name:string){return name==='aria-label'?this.label:null;}
 }
 const doc={visibilityState:'visible',addEventListener:on,hasFocus:()=>true};
 const store=new Map([['abyss-audio-v1',JSON.stringify({musicMuted:true})]]);
 put('document',doc);put('window',{addEventListener:on});put('Element',FakeElement);
 put('localStorage',{getItem:(k:string)=>store.get(k)??null,setItem:(k:string,v:string)=>store.set(k,v),removeItem:(k:string)=>store.delete(k)});
 put('Audio',FakeAudio);put('AudioContext',FakeContext);put('setInterval',()=>1);
 put('fetch',()=>new Promise(resolve=>pending.push(resolve)));
 try {
  const a=new GameAudio();a.start();
  assert.equal(pending.length,3,'UI resources preload before interaction');
  fire('pointerdown',{isTrusted:true});
  a.play('ui_panel_open');assert.equal(sources.length,0,'unloaded cue is skipped');
  pending.forEach(resolve=>resolve({ok:true,arrayBuffer:()=>Promise.resolve(new ArrayBuffer(1))}));
  for(let i=0;i<12;i++)await Promise.resolve();
  assert.equal(sources.length,0,'loading completion does not replay an obsolete cue');
  a.play('ui_panel_open');assert.equal(sources.length,1);assert.equal(sources[0]!.started,true,'ready cue starts in the same call');
  assert.equal(htmlPlays,0,'ready UI cue does not create a media playback request');
  a.play('ui_panel_close');assert.equal(sources.length,1);
  for(const target of [new FakeElement('关闭弹窗'),new FakeElement('收起通信面板'),new FakeElement('已了解',true)])fire('click',{isTrusted:true,target});
  assert.equal(sources.length,1,'close buttons also suppress generic click sounds');
  fire('click',{isTrusted:true,target:new FakeElement('计分板')});assert.equal(sources.length,2);
  a.setEffects(40);assert.equal(gain.gain.value,0.4);
  a.update({effectsMuted:true});assert.ok(sources.every(s=>s.stopped));assert.equal(gain.gain.value,0);
  a.play('ui_click_b');assert.equal(sources.length,2);
  a.update({effectsMuted:false});
  doc.visibilityState='hidden';fire('visibilitychange');a.play('ui_click_b');assert.equal(sources.length,2);
 }finally{for(const [key,d] of original){if(d)Object.defineProperty(globalThis,key,d);else Reflect.deleteProperty(globalThis,key);}}
});
