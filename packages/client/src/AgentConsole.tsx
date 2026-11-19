import {AgentPlugins} from './AgentPlugins.js';
import {AgentConfigDialog} from './AgentConfigDialog.js';
import {AgentSeatBinding,seatBindingTarget} from './AgentSeatBinding.js';
import type {ConsoleStrategy,ConsoleConfiguration} from '../../contracts/src/index.js';
import {Bot,RefreshCw,Play,Pause,Unplug,Settings2} from 'lucide-react';
import React,{useEffect,useRef,useState} from 'react';
import {AgentLiveOperations} from './AgentLiveOperations.js';
import {AgentSeatFleet} from './AgentSeatFleet.js';
import {AgentDiagnostics} from './AgentDiagnostics.js';
import {defaultHallOrigin} from './AgentHallSeatPicker.js';
import {AgentProviderPanel,type ProviderView,type ProviderEditorHandle} from './AgentProviderPanel.js';
import {AgentPersonalityOptions} from './AgentPersonalityOptions.js';
import {AgentBotSettings} from './AgentBotSettings.js';
import {consoleSeatName as seatName,consoleSeatColor,consoleDetailTabs,type ConsoleDetailTab,diagnosticViewKey,seatActions,consoleStatusLabel,type ConsoleSettings,type ConsoleSeat,type ConsoleJob} from './agent-console-state.js';
type ConnectionMode='local'|'configured'|'manual';
interface Status {connectionMode?:ConnectionMode;fixedSlots?:boolean;provider:'offline'|'env';mode:'live';seats:ConsoleSeat[];jobs:ConsoleJob[]}
type ConfigSeat=import('../../contracts/src/index.js').ConsoleConfigSeat;
export const consoleSettingsActionLabel=(configured:boolean,busy:boolean)=>configured?(busy?'应用中…':'应用到本次运行'):(busy?'保存中…':'保存全部');
/** Connection controls reflect the runner mode, never infer remote identity from seat IDs. */
export function AgentConsoleConnectionControls({mode,connected,detecting,onDetect}:{mode:ConnectionMode|undefined;fixedSlots:boolean;connected:boolean;detecting:boolean;count:number;onDetect:()=>void;onConnect:()=>void}){
 if(mode==='configured')return <span className="connection" title="席位连接由配置文件管理，不检测本机游戏">配置文件模式</span>;
 return <><button className="icon-button" title="检测本机游戏" aria-label="检测本机游戏" disabled={!connected||detecting} onClick={onDetect}><RefreshCw size={16} className={detecting?'spinning':''}/></button></>;
}
export function AgentConsole(){
 const [seatBinding,setSeatBinding]=useState(()=>seatBindingTarget(location.hash));
 function openHall(){window.open(defaultHallOrigin(),'_blank','noopener,noreferrer');}
 const providerEditor=useRef<ProviderEditorHandle>(null);
 const csrf=useRef(''),alive=useRef(true),inflight=useRef(new Set<string>());
 const [status,setStatus]=useState<Status|null>(null),[config,setConfig]=useState<ConfigSeat[]>([]),[selected,setSelected]=useState('');
 const [connected,setConnected]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[pending,setPending]=useState<string[]>([]);
 const [pluginsAvailable,setPluginsAvailable]=useState(false);
 const [pluginsOpen,setPluginsOpen]=useState(false);
 const [strategyJson,setStrategyJson]=useState<string|null>(null);
 const [configOpen,setConfigOpen]=useState(false),[configError,setConfigError]=useState(''),[configNotice,setConfigNotice]=useState('');
 const [selectedDetailTab,setDetailTab]=useState<ConsoleDetailTab>('live');
 const [confirmation,setConfirmation]=useState<'disconnect'|null>(null),[manageBusy,setManageBusy]=useState(false);
 const [draft,setDraft]=useState<ConsoleSettings>({model:'',personality:'balanced'});
 const liveTab=useRef(true);liveTab.current=selectedDetailTab==='live';
 const [detecting,setDetecting]=useState(false);
 const [strategies,setStrategies]=useState<ConsoleStrategy[]>([]);
 const detectingRef=useRef(false);
 async function request<T>(path:string,data?:unknown,signal?:AbortSignal):Promise<T>{
  const response=await fetch('/api/agent/'+path,{method:data===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',redirect:'error',headers:{'X-Agent-CSRF':csrf.current,...(data===undefined?{}:{'Content-Type':'application/json'})},...(data===undefined?{}:{body:JSON.stringify(data)}),...(signal?{signal}:{})});
  if(!response.ok){const detail=await response.json().catch(()=>null);throw Error(typeof detail?.error==='string'?detail.error:response.status===401||response.status===403?'本地会话失效，请刷新控制台。':response.status===409?'席位状态已变化，请刷新后重试。':`请求未完成（HTTP ${response.status}）。`);}
  return response.json() as Promise<T>;
 }
 async function reloadConfig(signal?:AbortSignal){const c=await request<ConsoleConfiguration>('config',undefined,signal);if(alive.current&&!signal?.aborted){setConfig(current=>JSON.stringify(current)===JSON.stringify(c.seats)?current:c.seats);setStrategies(c.strategies??[]);}}
 async function detectLocal(signal?:AbortSignal){
  if(detectingRef.current)return;detectingRef.current=true;setDetecting(true);
  try{
   const result=await request<{available:number;added:string[];fixedSlots?:boolean}>('connections/local',{},signal);
   if(!alive.current||signal?.aborted)return;
   setNotice(result.fixedSlots||result.available?'':'未找到本机游戏');
  }catch{if(alive.current&&!signal?.aborted)setNotice('本机连接失败');}
  finally{detectingRef.current=false;if(alive.current&&!signal?.aborted)setDetecting(false);}
 }
 async function connectLocal(signal?:AbortSignal){if(detectingRef.current)return;try{await detectLocal(signal);if(signal?.aborted)return;await reloadConfig(signal);await refresh(signal);}catch{if(alive.current&&!signal?.aborted)setNotice('本机连接失败');}}
 async function disconnect(){if(!seat||manageBusy)return;setManageBusy(true);setError('');try{await request('disconnect',{id:seat.id});setConfirmation(null);await reloadConfig();await refresh();setNotice('已断开当前连接');}catch(e){setError(e instanceof Error?e.message:'断开连接失败。');}finally{setManageBusy(false);}}
 function openPlayer(){
  if(!seat||!mapping||seat.bound===false)return;
  const origin=new URL(mapping.serverUrl).origin;
  const nonce=Array.from(crypto.getRandomValues(new Uint8Array(24)),n=>n.toString(16).padStart(2,'0')).join('');
  let popup:Window|null=null,used=false;
  const cleanup=()=>{clearTimeout(timer);window.removeEventListener('message',receive);};
  const receive=async(event:MessageEvent)=>{
   if(used||event.source!==popup||event.origin!==origin||event.data?.nonce!==nonce||event.data?.type!=='subterfuge-player-entry-ready')return;
   used=true;
   try{
    const entry=await request<{serverUrl:string;roomId:string;code:string;playerToken:string}>('browser-entry',{id:seat.id});
    if(entry.serverUrl!==origin)throw Error('席位服务器已变化，请重试。');
    popup?.postMessage({type:'subterfuge-player-entry',nonce,code:entry.code,roomId:entry.roomId,playerToken:entry.playerToken},origin);
   }catch(e){setError(e instanceof Error?e.message:'无法打开玩家页面。');popup?.close();}
   finally{cleanup();}
  };
  window.addEventListener('message',receive);
  const timer=setTimeout(()=>{cleanup();if(!used)setError('玩家页面连接超时，请重试。');},30000);
  popup=window.open(`${origin}/#console=${encodeURIComponent(location.origin)}&nonce=${nonce}&action=return`,`subterfuge-player-entry-${nonce}`);
  if(!popup){cleanup();setError('请允许本次弹窗，然后重试。');}
 }
 async function refresh(signal?:AbortSignal){const next=await request<Status>('status',undefined,signal);if(!alive.current||signal?.aborted)return;setStatus(current=>JSON.stringify(current)===JSON.stringify(next)?current:next);setConnected(true);setError('');setSelected(v=>next.seats.some(s=>s.id===v)?v:next.seats[0]?.id??'');}
 useEffect(()=>{alive.current=true;const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
  async function poll(){try{await refresh(controller.signal);}catch(e){if(!controller.signal.aborted){setConnected(false);setError(e instanceof Error?e.message:'控制台连接中断。');}}finally{if(!controller.signal.aborted)timer=setTimeout(()=>void poll(),liveTab.current&&!document.hidden?500:1500);}}
  void(async()=>{try{const response=await fetch('/api/agent/bootstrap',{headers:{'X-Agent-Console':'1'},credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal});if(!response.ok)throw Error('无法建立本地控制台会话，请从运行器提供的本机地址重新打开。');const boot=await response.json();if(controller.signal.aborted)return;if(typeof boot.csrf!=='string')throw Error('本地控制台协议不匹配。');if(seatBinding&&!boot.capabilities?.includes('seat-binding.unbound-configuration/1'))throw Error('本机控制器仍在运行旧版本，请重新启动控制器后从房间重新绑定。');csrf.current=boot.csrf;setPluginsAvailable(boot.capabilities?.includes('bot-plugins.local/1')===true);if(boot.connectionMode!=='configured'&&!seatBinding)await detectLocal(controller.signal);if(controller.signal.aborted)return;await reloadConfig(controller.signal);
    await poll();}catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:'无法连接本地运行器。');}})();
  return()=>{alive.current=false;controller.abort();clearTimeout(timer);csrf.current='';};
 },[]);
 const seat=status?.seats.find(s=>s.id===selected),mapping=config.find(s=>s.id===selected);
 const mode=mapping?.settings.mode??'hybrid';
 const detailTabs=consoleDetailTabs(mode).filter(([key])=>key!=='config'),detailTab=selectedDetailTab;
 const draftMode=draft.mode??'hybrid';
 const selectedStrategy=strategies.find(strategy=>strategy.id===draftMode);
 useEffect(()=>{setConfigOpen(false);},[selected]);
 function openConfiguration(){setStrategyJson(null);if(mapping)setDraft({...mapping.settings});setConfigError('');setConfigNotice('');setConfigOpen(true);}
 function navigateDetail(tab:ConsoleDetailTab){if(tab==='config')openConfiguration();else setDetailTab(tab);}
 useEffect(()=>{setStrategyJson(null);if(mapping)setDraft({...mapping.settings});},[mapping]);
 async function action(id:string,kind:'start'|'pause'){
  const key=id+':'+kind;if(inflight.current.has(key))return;inflight.current.add(key);setPending([...inflight.current]);setNotice('');
  try{await request('action',{action:kind,id});if(!alive.current)return;await refresh();}catch(e){if(alive.current)setError(e instanceof Error?e.message:'操作失败。');}finally{inflight.current.delete(key);if(alive.current)setPending([...inflight.current]);}
 }
 async function save(){
  if(!seat||!mapping)return;const id=seat.id,key=id+':settings';if(inflight.current.has(key))return;
  inflight.current.add(key);setPending([...inflight.current]);setConfigError('');setConfigNotice('');
  try{const strategyConfig=strategyJson===null?draft.strategyConfig:strategyJson.trim()?JSON.parse(strategyJson):undefined;if(pluginsAvailable){const checked=await request<{valid:boolean;checks:{passed:boolean;message?:string}[]}>('plugins/validate',{id:draftMode,seat:id,config:strategyConfig});if(!checked.valid)throw Error(checked.checks.filter(c=>!c.passed).map(c=>c.message).join('；')||'插件接口校验未通过');}const provider=providerEditor.current?.configuration();await request('configuration',{id,...(provider?{provider}:{}),settings:{...mapping.settings,mode:draftMode,strategyConfig,personality:draft.personality,...(draft.bot?{bot:draft.bot}:{})}});providerEditor.current?.clearSensitive();await reloadConfig();if(alive.current)setConfigNotice(status?.connectionMode==='configured'?'已应用到本次运行。':'配置已保存。');}
  catch(e){if(alive.current)setConfigError(e instanceof Error?e.message:'保存失败');}
  finally{inflight.current.delete(key);if(alive.current)setPending([...inflight.current]);}
 }
 const actions=seat?seatActions(seat,status?.jobs??[],connected&&!manageBusy):null;
 const selectSeat=(id:string)=>{setSelected(id);setNotice('');setConfirmation(null);};
 const busyFor=(id:string,kind:string)=>pending.includes(id+':'+kind);
 const disconnectDisabled=!connected||!seat||seat.bound===false||manageBusy||!!seat.stopping||pending.some(k=>k.startsWith(seat.id+':'))||!!status?.jobs.some(j=>j.seat===seat.id&&j.status==='running');
 const providerName=(provider?:ProviderView)=>provider?.kind==='codex'?'Codex':provider?.kind==='gemini'?'Gemini · 原生':provider?.kind==='openai-compatible'?apiName(provider.baseUrl):provider?.kind==='inherited'?'启动配置':'未配置';
 function apiName(url?:string){if(!url)return 'API';try{const host=new URL(url).hostname;return host.includes('deepseek')?'DeepSeek':host.includes('openrouter')?'OpenRouter':host.includes('minimax')?'MiniMax':host.includes('googleapis')?'Gemini':host==='api.openai.com'?'OpenAI':host;}catch{return 'API';}}
 return <main className={'agent-console instrument-console'+(detailTab==='live'&&seat?' live-console':' content-console')}>
  {seatBinding&&connected&&status?.connectionMode==='configured'&&<p role="alert">当前为配置文件模式，不能从房间绑定；请启动本地固定槽位控制器。</p>}
  {seatBinding&&connected&&status?.connectionMode!=='configured'&&<AgentSeatBinding target={seatBinding} config={config} request={request} onClose={()=>setSeatBinding(null)} onBound={async id=>{setSeatBinding(null);await reloadConfig();await refresh();setSelected(id);setNotice('bot 已绑定，保持暂停。');}}/>}
      {configOpen&&mapping&&seat&&<AgentConfigDialog name={seatName(seat)} busy={pending.includes(seat.id+':settings')} onClose={()=>setConfigOpen(false)}><form className="settings-stack" onSubmit={e=>{e.preventDefault();void save();}}>
       {!actions?.settings&&<p className="settings-status">{seat.enabled||seat.busy||seat.starting?'运行中，暂停此席位后可修改配置。':seat.status==='ended'?'对局已结束，配置仅供查看。':'当前配置仅供查看。'}</p>}
       <section className="strategy-form plugin-choice"><div className="plugin-choice-row"><label>AI 实现<select aria-label="AI 实现" disabled={!actions?.settings||pending.some(k=>k.startsWith(seat.id+':'))} value={draftMode} onChange={e=>(setStrategyJson(null),setDraft({...draft,mode:e.target.value,strategyConfig:undefined}))}>{strategies.map(strategy=><option key={strategy.id} value={strategy.id}>{strategy.label}</option>)}</select></label>{pluginsAvailable&&<button type="button" disabled={!actions?.settings} onClick={()=>setPluginsOpen(true)}>扫描插件目录</button>}</div></section>
       {(pluginsAvailable||draftMode!=='hybrid')&&<details className="plugin-config-advanced"><summary>插件参数</summary><p>仅按插件作者说明填写 JSON。不需要参数时留空；模型连接与前台战术参数在下方设置。</p><label>参数（JSON）<textarea aria-label="策略配置" disabled={!actions?.settings} value={strategyJson??(draft.strategyConfig===undefined?'':JSON.stringify(draft.strategyConfig,null,2))} placeholder="不需要参数时留空" onChange={e=>setStrategyJson(e.target.value)}/></label></details>}
       {(selectedStrategy?.capabilities.model??true)&&<AgentProviderPanel ref={providerEditor} key={seat.id+':'+draftMode} id={seat.id} value={mapping.providerConfig} mode={draftMode} disabled={!actions?.settings||pending.some(k=>k.startsWith(seat.id+':'))} request={request} personalityControl={(selectedStrategy?.capabilities.personalitySettings??!selectedStrategy)?<AgentPersonalityOptions value={draft.personality} onChange={personality=>setDraft({...draft,personality})}/>:null}/>}
       {!(selectedStrategy?.capabilities.model??true)&&(selectedStrategy?.capabilities.personalitySettings??!selectedStrategy)&&<section className="strategy-form"><fieldset disabled={!actions?.settings||pending.some(k=>k.startsWith(seat.id+':'))}><legend>后台决策风格</legend><AgentPersonalityOptions value={draft.personality} onChange={personality=>setDraft({...draft,personality})}/></fieldset></section>}
       {(selectedStrategy?.capabilities.tacticalSettings??!selectedStrategy)&&<AgentBotSettings title="前台战术参数" value={draft.bot} disabled={!actions?.settings||pending.some(k=>k.startsWith(seat.id+':'))} onChange={bot=>setDraft({...draft,bot})}/>}
       {status?.connectionMode==='configured'?<section className="connection-settings"><div><h3>游戏连接</h3><p>网页执行方式与策略参数仅应用于本次运行；重启后从配置文件和启动参数重新读取。席位连接由配置文件管理，此处可启动或暂停，不检测本机游戏。</p></div></section>:<section className="connection-settings"><div><h3>游戏连接</h3><p>{seat.bound===false?'当前未连接游戏':status?.fixedSlots?'断开后将暂停此 bot 并释放当前游戏控制权，保留模型和决策风格。':'断开后将暂停此 bot 并从当前控制台移除连接。'}</p></div></section>}
       {configError&&<p className="console-error" role="alert">{configError}</p>}{configNotice&&<p className="console-notice" role="status">{configNotice}</p>}
       <div className="form-actions settings-save"><button type="submit" disabled={!actions?.settings||pending.some(k=>k.startsWith(seat.id+':'))}>{consoleSettingsActionLabel(status?.connectionMode==='configured',pending.includes(seat.id+':settings'))}</button></div>
      </form></AgentConfigDialog>}
  {pluginsOpen&&<AgentPlugins seat={selected} seatLabel={seat?seatName(seat):selected} selectedMode={draftMode} request={request} onInstalled={reloadConfig} onSelect={id=>{if(id!==draftMode){setStrategyJson(null);setDraft({...draft,mode:id,strategyConfig:undefined});}setConfigNotice('已选择插件；保存时会校验配置、实例和游戏连接。');}} onClose={()=>setPluginsOpen(false)}/>}
  {error&&<p className="console-error" role="alert">{error}</p>}{notice&&<p className="console-notice" role="status"><span>{notice}</span><button className="icon-button" aria-label="关闭提示" onClick={()=>setNotice('')}>×</button></p>}
  <div className="console-layout">
   <aside className="console-sidebar" aria-label="运行席位">
    <div className="sidebar-connection"><span role="status" title={connected?'运行器已连接':'运行器未连接'} className={'connection '+(connected?'online':'')}><i/>{connected?'已连接':'未连接'}</span>
     <AgentConsoleConnectionControls mode={status?.connectionMode} fixedSlots={!!status?.fixedSlots} connected={connected} detecting={detecting} count={status?.seats.filter(s=>s.bound!==false).length??0} onDetect={()=>void connectLocal()} onConnect={openHall}/>
    </div>
    <div className="sidebar-heading"><h2>席位</h2><span>{status?.seats.length??0}</span></div>
    <ol className="seat-list">{status?.seats.map((s,index)=>{
     const a=seatActions(s,status.jobs,connected),c=config.find(c=>c.id===s.id),active=s.enabled||s.busy||s.starting;
     const transitioning=pending.some(k=>k.startsWith(s.id+':')&&!k.endsWith(':pause'));
     return <li key={s.id} className={selected===s.id?'selected':''}>
      <button className="seat-select" aria-pressed={selected===s.id} title={s.id+' / '+s.roomId} onClick={()=>selectSeat(s.id)}>
       <span className="seat-number">{String(index+1).padStart(2,'0')}</span><span className="seat-text"><b style={{color:consoleSeatColor(s)}}>{seatName(s)}</b><small title={providerName(c?.providerConfig)+' · '+(c?.providerConfig.kind==='offline'?'无需模型':c?.providerConfig.model||c?.settings.model||'未选择模型')}>{providerName(c?.providerConfig)} · {c?.providerConfig.kind==='offline'?'无需模型':c?.providerConfig.model||c?.settings.model||'—'}</small></span>
      </button>
      <button className={'seat-status-control '+(active?'active':'')+(s.error?' has-error':'')} disabled={manageBusy||!!s.stopping||busyFor(s.id,'pause')||(!active?!a.start||transitioning:!a.pause)} onClick={()=>void action(s.id,active?'pause':'start')} title={s.error??(active?'暂停':'启动')} aria-label={`${active?'暂停':'启动'} ${seatName(s)}`}>
       {active?<Pause size={11}/>:<Play size={11}/>}<span>{s.stopping?'暂停中':s.waitingForGame?'等待开局':s.starting?'连接中':s.bound===false?'未绑定':consoleStatusLabel(s.status)}</span>
      </button>
     </li>;
    })}</ol>
    {!status&&<p className="empty-compact">连接中…</p>}
   </aside>
   <section className="console-detail" aria-label="席位详情">
    {seat?<>
     <div className="detail-top">     <nav className="detail-tabs" role="tablist" aria-label="席位内容">{detailTabs.map(([key,label])=><button key={key} id={'tab-'+key} role="tab" tabIndex={detailTab===key?0:-1} onKeyDown={e=>{const keys=detailTabs.map(([key])=>key);const index=keys.indexOf(key);const next=e.key==='ArrowRight'?keys[(index+1)%keys.length]:e.key==='ArrowLeft'?keys[(index+keys.length-1)%keys.length]:e.key==='Home'?keys[0]:e.key==='End'?keys.at(-1):undefined;if(next){e.preventDefault();setDetailTab(next);document.getElementById('tab-'+next)?.focus();}}} aria-selected={detailTab===key} aria-controls="seat-panel" onClick={()=>setDetailTab(key)}>{label}</button>)}</nav>
     <div className="live-console-controls"><button type="button" className="bot-config-trigger" aria-haspopup="dialog" onClick={openConfiguration}><Settings2 size={14}/>配置</button><button type="button" className="player-entry-button" disabled={!connected||!seat||seat.bound===false} onClick={openPlayer}>打开玩家页面</button><AgentConsoleConnectionControls mode={status?.connectionMode} fixedSlots={!!status?.fixedSlots} connected={connected} detecting={detecting} count={status?.seats.filter(s=>s.bound!==false).length??0} onDetect={()=>void connectLocal()} onConnect={openHall}/><button type="button" className="live-toggle" disabled={!!seat.stopping||busyFor(seat.id,seat.enabled||seat.busy||seat.starting?'pause':'start')||(seat.enabled||seat.busy||seat.starting?!actions?.pause:!actions?.start)} onClick={()=>void action(seat.id,seat.enabled||seat.busy||seat.starting?'pause':'start')}>{seat.enabled||seat.busy||seat.starting?<Pause size={12}/>:<Play size={12}/>}{seat.enabled||seat.busy||seat.starting?'暂停':'启动'}</button>{status?.connectionMode!=='configured'&&seat.bound!==false&&<button type="button" className="disconnect-control" disabled={disconnectDisabled} onClick={()=>setConfirmation('disconnect')}><Unplug size={13}/>{manageBusy?'断开中…':'断开连接'}</button>}</div>
     </div>
       {confirmation&&<div className="console-confirm" role="group" aria-label="确认断开连接"><span>断开{seatName(seat)}的当前连接？{status?.fixedSlots?'模型和决策风格会保留。':''}</span><div><button type="button" disabled={manageBusy} onClick={()=>void disconnect()}>{manageBusy?'断开中…':'确认断开'}</button><button type="button" disabled={manageBusy} onClick={()=>setConfirmation(null)}>取消</button></div></div>}
     {detailTab!=='live'&&<AgentSeatFleet seat={seat} seats={status?.seats??[]} connected={connected} onSelect={selectSeat}/>}<div className="detail-body" id="seat-panel" role="tabpanel" aria-labelledby={'tab-'+detailTab} tabIndex={0}>
      {detailTab==='live'&&<AgentLiveOperations seat={seat} seats={status?.seats??[]} connected={connected} request={request} onSelect={selectSeat} start={{canStart:!!actions?.start&&!pending.some(k=>k.startsWith(seat.id+':')),canConnect:status?.connectionMode!=='configured',model:mapping?.providerConfig.kind==='offline'?'自主决策 · 无需模型':providerName(mapping?.providerConfig)+(mapping?.providerConfig.model?' / '+mapping.providerConfig.model:''),onStart:()=>void action(seat.id,'start'),onConfigure:openConfiguration,onConnect:openHall}}/>}
      {detailTab!=='live'&&detailTab!=='config'&&seat.bound!==false&&<AgentDiagnostics key={diagnosticViewKey(seat,mode+':'+detailTab)} id={seat.id} mode={mode} tab={detailTab} request={request} onNavigate={navigateDetail} totals={{calls:seat.calls,tokens:seat.tokens}}/>}
      {detailTab!=='live'&&detailTab!=='config'&&seat.bound===false&&<div className="empty-state"><Bot size={28} strokeWidth={1.3}/><span>未绑定游戏</span></div>}

     </div>
    </>:<div className="empty-state"><Bot size={28} strokeWidth={1.3}/><span>{detecting?'正在连接游戏':'选择席位'}</span></div>}
   </section>
  </div>
 </main>;
}
