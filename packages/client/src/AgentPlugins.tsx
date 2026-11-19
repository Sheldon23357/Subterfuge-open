import React,{useEffect,useRef,useState} from 'react';
import {Check,FolderOpen,Search} from 'lucide-react';
import {AgentConfigDialog} from './AgentConfigDialog.js';
interface Plugin {id:string;name:string;version:string;digest:string;error?:string}
interface Candidate {directory:string;manifest?:{id:string;name:string;version:string;description?:string};error?:string}
interface Validation {valid:boolean;checks:{name:string;passed:boolean;message?:string}[]}
export function AgentPlugins({seat,seatLabel,selectedMode,request,onInstalled,onSelect,onClose}:{seat:string;seatLabel:string;selectedMode:string;request:<T>(path:string,data?:unknown)=>Promise<T>;onInstalled:()=>Promise<void>;onSelect:(id:string)=>void;onClose:()=>void}){
 const [plugins,setPlugins]=useState<Plugin[]>([]),[directory,setDirectory]=useState(()=>localStorage.getItem('bot-plugin-directory')??'');
 const [trusted,setTrusted]=useState(false),[busy,setBusy]=useState<'catalog'|'scan'|'load'|'validate'|null>('catalog'),[error,setError]=useState(''),[scanError,setScanError]=useState(''),[available,setAvailable]=useState(false);
 const [candidates,setCandidates]=useState<Candidate[]|null>(null),[scannedDirectory,setScannedDirectory]=useState(''),[validation,setValidation]=useState<(Validation&{name:string})|null>(null);
 useEffect(()=>{let active=true;void request<{available:boolean;plugins:Plugin[]}>('plugins').then(r=>{if(active){setPlugins(r.plugins);setAvailable(r.available);}},e=>{if(active)setError(e instanceof Error?e.message:'无法读取插件目录');}).finally(()=>{if(active)setBusy(null);});return()=>{active=false;};},[]);
 async function scan(){
  const path=directory.trim();localStorage.setItem('bot-plugin-directory',path);setDirectory(path);setBusy('scan');setScanError('');setError('');setTrusted(false);setValidation(null);setCandidates(null);
  try{const result=await request<{plugins:Candidate[]}>('plugins/scan',{directory:path});setCandidates(result.plugins);setScannedDirectory(path);}
  catch(e){const message=e instanceof Error?e.message:'';setScanError(message.startsWith('ENOENT:')?'目录不存在，请检查路径后重试。':message.startsWith('EACCES:')?'无法读取此目录，请检查访问权限。':message==='Choose an absolute local plugin directory'?'请输入本机目录的绝对路径。':message||'扫描失败，请检查目录后重试。');}finally{setBusy(null);}
 }
 async function choose(id:string,name:string,source?:string,replace=false){
  setBusy(source?'load':'validate');setError('');setValidation(null);
  try{
   if(source){await request('plugins/install',{directory:source,trusted,replace});const r=await request<{plugins:Plugin[]}>('plugins');setPlugins(r.plugins);await onInstalled();setBusy('validate');}
   const check=await request<Validation>('plugins/validate',{id,seat});setValidation({...check,name});onSelect(id);
  }catch(e){setError(e instanceof Error?e.message:'插件校验失败，请重试。');}finally{setBusy(null);}
 }
 const validationElement=useRef<HTMLElement>(null);
 useEffect(()=>{if(validation)validationElement.current?.scrollIntoView({block:'nearest'});},[validation]);
 const discoveredIds=new Set(candidates?.flatMap(p=>p.manifest?[p.manifest.id]:[])??[]),otherPlugins=plugins.filter(p=>!discoveredIds.has(p.id));
 const hasSources=candidates?.some(p=>p.manifest&&!p.error),working=busy!==null;
 function pluginRow(plugin:Plugin,candidate?:Candidate){
  const source=candidate?.manifest,selected=selectedMode===plugin.id;
  return <li className={'plugin-row'+(selected?' is-selected':'')} key={candidate?.directory??plugin.id}>
   <div className="plugin-row-info"><div className="plugin-row-title"><strong>{plugin.name}</strong><span className="plugin-version">v{source?.version??plugin.version}</span>{selected&&<span className="plugin-selected"><Check size={13}/>已选</span>}</div>
    <div className="plugin-row-meta"><code>{plugin.id}</code><span>{plugin.error?'加载不可用':plugin.digest?'已加载'+(source&&source.version!==plugin.version?' v'+plugin.version:''):'未加载'}</span></div>
    {source?.description&&<p className="plugin-description">{source.description}</p>}
    {candidate&&<p className="plugin-path" title={candidate.directory}>{candidate.directory}</p>}
    {plugin.error&&<p className="plugin-inline-error">{plugin.error}</p>}
   </div>
   <div className="plugin-row-actions">
    {plugin.digest&&!plugin.error&&<button type="button" className="plugin-select-button" disabled={working} onClick={()=>void choose(plugin.id,plugin.name)}>校验并选择</button>}
    {candidate&&source&&<button type="button" className={plugin.digest?'plugin-update-button':'plugin-select-button'} disabled={working||!trusted} title={!trusted?'请先勾选下方的代码运行授权':undefined} onClick={()=>void choose(plugin.id,plugin.name,candidate.directory,!!plugin.digest||!!plugin.error)}>{plugin.digest||plugin.error?'更新源码':'加载并校验'}</button>}
   </div>
  </li>;
 }
 return <AgentConfigDialog name="选择 Bot 插件" title="选择 Bot 插件" description={seatLabel+' · 选择后保存席位配置生效'} className="plugin-dialog" busy={working&&busy!=='catalog'} onClose={onClose}>
  <div className="plugin-manager">
   {available&&<section className="plugin-source" aria-label="扫描本机目录"><form onSubmit={e=>{e.preventDefault();void scan();}}>
    <label htmlFor="bot-plugin-directory">本机插件目录</label><div className="plugin-directory-controls"><div className="plugin-directory-input"><FolderOpen size={17} aria-hidden="true"/><input id="bot-plugin-directory" value={directory} disabled={working} onChange={e=>{setDirectory(e.target.value);setCandidates(null);setScannedDirectory('');setTrusted(false);setScanError('');}} placeholder="输入插件文件夹的绝对路径" required aria-describedby="plugin-directory-help" aria-invalid={!!scanError} autoComplete="off" spellCheck={false}/></div><button type="submit" className="plugin-scan-button" disabled={working||!directory.trim()}><Search size={15} aria-hidden="true"/>{busy==='scan'?'扫描中…':'扫描目录'}</button></div>
    <p id="plugin-directory-help" className="plugin-hint">可扫描单个插件文件夹，或包含多个插件的上级目录。</p>
    {scanError&&<p className="plugin-inline-error" role="alert">{scanError}</p>}
   </form></section>}
   {busy&&<p className="plugin-progress" role="status">{busy==='catalog'?'正在读取已加载插件…':busy==='scan'?'正在扫描目录…':busy==='load'?'正在编译并加载插件…':'正在校验配置、接口与游戏连接…'}</p>}
   {candidates!==null&&<section className="plugin-results" aria-label="扫描结果"><header className="plugin-section-heading"><h3>扫描结果 <span>{candidates.length}</span></h3><p className="plugin-path" title={scannedDirectory}>{scannedDirectory}</p></header>
    {candidates.length===0?<div className="plugin-empty"><FolderOpen size={24} aria-hidden="true"/><strong>没有发现插件</strong><p>请选择包含 bot-plugin.json 的插件文件夹，或它的上级目录。</p></div>:<ul className="plugin-list">{candidates.map(p=>p.manifest&&!p.error?pluginRow(plugins.find(x=>x.id===p.manifest!.id)??{...p.manifest,digest:''},p):<li className="plugin-row plugin-invalid" key={p.directory}><div className="plugin-row-info"><strong>无法读取插件</strong><p className="plugin-path">{p.directory}</p><p className="plugin-inline-error">{p.error}</p></div></li>)}</ul>}
    {hasSources&&<div className="plugin-trust"><label><input type="checkbox" checked={trusted} disabled={working} onChange={e=>setTrusted(e.target.checked)}/><span>我信任这些插件，允许它们在本机运行代码。</span></label><details><summary>加载与更新说明</summary><p>扫描不执行代码。加载和校验在控制台进程中运行，不是安全沙箱。同 ID 更新前，须将使用它的席位切换到其他插件。</p></details></div>}
   </section>}
   {otherPlugins.length>0&&<section aria-label="已加载插件"><header className="plugin-section-heading"><h3>{candidates?.length?'其他已加载插件':'已加载插件'} <span>{otherPlugins.length}</span></h3></header><ul className="plugin-list">{otherPlugins.map(p=>pluginRow(p))}</ul></section>}
   {!working&&!error&&candidates===null&&plugins.length===0&&<div className="plugin-empty"><FolderOpen size={24} aria-hidden="true"/><strong>{available?'还没有加载插件':'此运行器未启用本地插件'}</strong><p>{available?'输入目录并扫描，选择要用于此席位的插件。':'请使用支持本地插件的运行器打开控制台。'}</p></div>}
   {validation&&<section ref={validationElement} className={'plugin-validation '+(validation.valid?'is-valid':'is-invalid')} role="status"><h3>{validation.valid?<Check size={17} aria-hidden="true"/>:null}{validation.name} · {validation.valid?'基本校验通过':'校验未通过'}</h3><ul>{validation.checks.map(c=><li key={c.name}><span className={c.passed?'check-passed':'check-failed'}>{c.passed?'通过':'失败'}</span><div><strong>{c.name}</strong>{c.message&&<p>{c.message}</p>}</div></li>)}</ul><p className="plugin-hint">校验不下达游戏指令，也不代表策略强度或长期稳定性。</p></section>}
   {error&&<p className="plugin-inline-error" role="alert">{error}</p>}
  </div>
  <footer className="plugin-footer"><p>{validation?(validation.valid?'已选择 '+validation.name+'，返回后保存配置。':'已暂选 '+validation.name+'，请按校验结果完善配置。'):'仅应用于 '+seatLabel+'；其他席位可独立选择。'}</p><button type="button" disabled={working} onClick={onClose}>返回席位配置</button></footer>
 </AgentConfigDialog>;
}
