import React,{forwardRef,useEffect,useImperativeHandle,useState} from 'react';
import {AGENT_PROVIDER_PRESETS,type AgentProviderPreset} from '../../contracts/src/index.js';
import type {ConsoleRequest} from './AgentConnectionWizard.js';
import type {ConsoleProvider as ProviderView} from '../../contracts/src/index.js';
export type {ConsoleProvider as ProviderView} from '../../contracts/src/index.js';
export function providerSaveConfig(draft:ProviderView,key:string,clearKey:boolean){
 const {hasKey,keySource,...config}=draft;
 if(draft.kind==='gemini')return {kind:'gemini' as const,preset:'gemini' as const,model:draft.model??'',timeoutMs:draft.timeoutMs??120000};
 return {...config,...(draft.kind==='openai-compatible'?{apiStyle:draft.apiStyle??'chat',responseFormat:draft.responseFormat??'json_schema',timeoutMs:draft.timeoutMs??120000}:{}),...(clearKey?{apiKey:''}:key?{apiKey:key}:{})};
}
export interface ProviderEditorHandle {configuration:()=>ReturnType<typeof providerSaveConfig>|undefined;clearSensitive:()=>void}
function modelProvider(value:ProviderView,mode?:string):ProviderView {
 return value;
}
export const AgentProviderPanel=forwardRef<ProviderEditorHandle,{id:string;value:ProviderView;disabled:boolean;request:ConsoleRequest;mode?:string;personalityControl?:React.ReactNode;onKindChange?:(kind:ProviderView['kind'])=>void}> (function AgentProviderPanel({id,value,disabled,request,mode,personalityControl,onKindChange},ref){
 const [draft,setDraft]=useState(()=>modelProvider(value,mode)),[key,setKey]=useState(''),[clearKey,setClearKey]=useState(false),[models,setModels]=useState<string[]>([]),[codexModels,setCodexModels]=useState<string[]>([]),[loadingModels,setLoadingModels]=useState(false),[modelMessage,setModelMessage]=useState(''),[presets,setPresets]=useState<{id:AgentProviderPreset;hasKey:boolean;model?:string}[]>([]);
 useEffect(()=>{setDraft(modelProvider(value,mode));setKey('');setClearKey(false);setModels([]);},[id,value,mode]);
 useEffect(()=>{onKindChange?.(draft.kind);},[draft.kind,onKindChange]);
 useImperativeHandle(ref,()=>({configuration:()=>draft.kind==='inherited'?undefined:providerSaveConfig(draft,key,clearKey),clearSensitive:()=>{setKey('');setClearKey(false);}}),[draft,key,clearKey]);
 useEffect(()=>{
  if(disabled)return;
  const abort=new AbortController();
  void request<{presets:{id:AgentProviderPreset;hasKey:boolean;model?:string}[]}>('provider-presets',undefined,abort.signal).then(result=>{if(!abort.signal.aborted)setPresets(result.presets);}).catch(()=>{});
  void request<{models:string[]}>('models',{id,config:{kind:'codex'}},abort.signal).then(result=>{if(!abort.signal.aborted)setCodexModels(result.models);}).catch(()=>{});
  return()=>abort.abort();
 },[id,disabled]);
 const presetKeyAvailable=!!(draft.preset&&presets.find(p=>p.id===draft.preset)?.hasKey);
 useEffect(()=>{
  setModels([]);setModelMessage('');
  if(disabled||!['openai-compatible','gemini'].includes(draft.kind)||draft.kind==='openai-compatible'&&!draft.baseUrl||clearKey||(!key&&!presetKeyAvailable&&!(value.kind===draft.kind&&value.hasKey&&value.baseUrl===draft.baseUrl)))return;
  const abort=new AbortController();
  const timer=setTimeout(()=>{
   setLoadingModels(true);
   const config=providerSaveConfig({...draft,model:draft.model||'model-list'},key,clearKey);
   void request<{models:string[]}>('models',{id,config},abort.signal).then(result=>{
    if(abort.signal.aborted)return;
    setModels(result.models);setModelMessage(result.models.length?'':'未发现模型');
    if(result.models.length)setDraft(current=>current.model?current:{...current,model:result.models[0]!});
   }).catch(()=>{if(!abort.signal.aborted)setModelMessage('模型列表不可用');}).finally(()=>{if(!abort.signal.aborted)setLoadingModels(false);});
  },600);
  return()=>{clearTimeout(timer);abort.abort();setLoadingModels(false);};
 },[id,disabled,draft.kind,draft.baseUrl,key,clearKey,value.kind,value.hasKey,value.baseUrl,draft.preset,presetKeyAvailable]);
 const executionValue=draft.kind==='gemini'&&models.includes(draft.model??'')?'gemini:'+draft.model:draft.kind==='codex'&&codexModels.includes(draft.model??'')?'codex:'+draft.model:draft.kind==='openai-compatible'&&models.includes(draft.model??'')?'api:'+draft.model:draft.preset?'preset:'+draft.preset:draft.kind;
 function selectExecution(selected:string){
  if(selected.startsWith('preset:')){const preset=selected.slice(7) as AgentProviderPreset;if(preset==='gemini'){setDraft({kind:'gemini',preset,model:presets.find(p=>p.id===preset)?.model??AGENT_PROVIDER_PRESETS.gemini.model,hasKey:!!presets.find(p=>p.id===preset)?.hasKey});setKey('');setClearKey(false);return;}setDraft({kind:'openai-compatible',preset,baseUrl:AGENT_PROVIDER_PRESETS[preset].baseUrl,model:AGENT_PROVIDER_PRESETS[preset].model,apiStyle:AGENT_PROVIDER_PRESETS[preset].apiStyle,responseFormat:AGENT_PROVIDER_PRESETS[preset].responseFormat,hasKey:!!presets.find(p=>p.id===preset)?.hasKey});setKey('');setClearKey(false);return;}
  if(selected==='openai-compatible'){setDraft({kind:'openai-compatible',model:'',hasKey:false});setKey('');setClearKey(false);return;}
  const kind=selected.startsWith('gemini:')?'gemini':selected.startsWith('codex:')?'codex':selected.startsWith('api:')?'openai-compatible':selected as ProviderView['kind'];
  const model=selected.startsWith('gemini:')?selected.slice(7):selected.startsWith('codex:')?selected.slice(6):selected.startsWith('api:')?selected.slice(4):'';
  if(kind===draft.kind){setDraft({...draft,model});return;}
  setDraft({...((kind===value.kind)?value:{}),kind,model,hasKey:kind===value.kind&&value.hasKey});setKey('');setClearKey(false);
 }
 return <section className="provider-form"><fieldset disabled={disabled}><legend>模型连接</legend><div className="provider-primary-fields"><label className="bot-setting"><span className="bot-setting-title">模型来源</span><select value={executionValue} onChange={e=>selectExecution(e.target.value)}><option value="inherited" disabled>启动时配置（当前）</option><option value="offline">不配置模型 · 自主决策</option>{codexModels.length>0&&<optgroup label="Codex">{codexModels.map(m=><option key={m} value={'codex:'+m}>{m}</option>)}</optgroup>}{models.length>0&&<optgroup label={draft.preset?AGENT_PROVIDER_PRESETS[draft.preset].label:"API"}>{models.map(m=><option key={m} value={(draft.kind==='gemini'?'gemini:':'api:')+m}>{m}</option>)}</optgroup>}<optgroup label="供应方">{Object.entries(AGENT_PROVIDER_PRESETS).map(([id,p])=><option key={id} value={"preset:"+id}>{p.label}</option>)}</optgroup><option value="codex">Codex · 自定义模型</option><option value="openai-compatible">API · 自定义接口</option></select></label>{personalityControl}</div>{loadingModels&&<p className="muted" role="status">读取模型中…</p>}{modelMessage&&<p className="muted" role="status">{modelMessage}</p>}{draft.kind!=='offline'&&draft.kind!=='inherited'&&<label>模型<input value={draft.model??''} maxLength={100} list={'models-'+id} onChange={e=>setDraft({...draft,model:e.target.value})}/><datalist id={'models-'+id}>{(draft.kind==='codex'?codexModels:models).map(m=><option key={m} value={m}/>)}</datalist></label>}{draft.kind==='gemini'&&<><p className="muted">{presetKeyAvailable||draft.hasKey?'已读取环境密钥':'未发现 GEMINI_API_KEY 或 GOOGLE_API_KEY'}</p><label>超时（毫秒）<input type="number" min={1000} max={600000} step={1000} value={draft.timeoutMs??120000} onChange={e=>setDraft({...draft,timeoutMs:e.target.valueAsNumber})}/></label></>}{draft.kind==='openai-compatible'&&<>{!draft.preset&&<><label>常用地址<select value="" onChange={e=>{if(e.target.value){setDraft({...draft,baseUrl:e.target.value});setKey('');setClearKey(false);}}}><option value="">选择预设或填写自定义地址</option><option value="https://api.deepseek.com/v1">DeepSeek</option><option value="https://openrouter.ai/api/v1">OpenRouter</option><option value="https://generativelanguage.googleapis.com/v1beta/openai">Gemini（兼容 API）</option></select></label><label>API 地址<input type="url" required value={draft.baseUrl??''} placeholder="https://服务商/v1" onChange={e=>{setDraft({...draft,baseUrl:e.target.value});setKey('');setClearKey(false);}}/></label></>}<label>API Key<input type="password" value={key} autoComplete="off" spellCheck={false} placeholder={presetKeyAvailable?'已读取环境密钥':value.hasKey?'已配置，留空保留同地址密钥':'填写密钥'} onChange={e=>{setKey(e.target.value);setClearKey(false);}}/></label>{value.hasKey&&<label className="check-label"><input type="checkbox" checked={clearKey} onChange={e=>setClearKey(e.target.checked)}/>清除已有密钥</label>}<section className="provider-advanced"><h3>协议与超时</h3><div className="settings-field-grid"><label>API 协议<select value={draft.apiStyle??'chat'} onChange={e=>setDraft({...draft,apiStyle:e.target.value as NonNullable<ProviderView['apiStyle']>})}><option value="chat">Chat completions</option><option value="responses">Responses</option></select></label><label>输出格式<select value={draft.responseFormat??'json_schema'} onChange={e=>setDraft({...draft,responseFormat:e.target.value as NonNullable<ProviderView['responseFormat']>})}><option value="json_schema">JSON schema</option><option value="json_object">JSON object</option><option value="none">不指定</option></select></label><label>超时（毫秒）<input type="number" min={1000} max={300000} step={1000} value={draft.timeoutMs??120000} onChange={e=>setDraft({...draft,timeoutMs:e.target.valueAsNumber})}/></label></div></section></>}</fieldset></section>;
});
