import React,{useEffect,useRef,useState} from 'react';
import type {PlayerObservation} from '../../contracts/src/index.js';
import {DIPLOMACY_RULES,parseDiplomacyAction,type DiplomacyAction,type PlayerDiplomacy} from '../../rules/src/index.js';
import {ServerAgreements} from './ServerAgreements.js';
import {playerNames} from './theme.js';
import {Plus,X} from 'lucide-react';
import './diplomacy.css';

export function DiplomacyPanel({observation:o,disabled,onSubmit}:{observation:PlayerObservation;disabled:boolean;onSubmit:(action:DiplomacyAction)=>Promise<boolean|undefined>}){
 const self=o.view.player,other=o.intel.filter(p=>p.player!==self&&p.active);
 const [open,setOpen]=useState(false),[peer,setPeer]=useState(other[0]?.player??-1),[kind,setKind]=useState<'ceasefire'|'joint-attack'>('ceasefire'),[posts,setPosts]=useState<string[]>([]),[enemy,setEnemy]=useState(-1),[payer,setPayer]=useState<'none'|'self'|'peer'>('none'),[amount,setAmount]=useState(0),[counter,setCounter]=useState<string|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const locked=disabled||busy;
 const formRef=useRef<HTMLFormElement>(null);
 useEffect(()=>{if(open)formRef.current?.querySelector<HTMLSelectElement>('select:not(:disabled)')?.focus();},[open,counter]);
 const eligiblePosts=o.view.outposts.filter(p=>!p.destroyed&&(p.owner===self||p.owner===peer));
 async function send(action:DiplomacyAction){
  if(locked)return;setBusy(true);setError('');
  try{if(await onSubmit(parseDiplomacyAction(action))){setOpen(false);setCounter(null);}}catch(e){setError(e instanceof Error?e.message:'协议操作失败');}finally{setBusy(false);}
 }
 function counteroffer(a:PlayerDiplomacy['agreements'][number]){
  setPeer(a.players.find(p=>p!==self)!);setKind(a.terms.kind);setCounter(a.id);setError('');
  if(a.terms.kind==='ceasefire')setPosts([...a.terms.outposts]);
  else setEnemy(a.terms.enemy);
  setPayer(a.subsidy?(a.subsidy.payer===self?'self':'peer'):'none');setAmount(a.subsidy?.amount??0);setOpen(true);
 }
 if(!o.diplomacy)return null;
 return <div className="diplomacy-panel">
  <ServerAgreements value={o.diplomacy} names={o.outpostNames??{}} outposts={o.view.outposts} viewer={self} disabled={locked} onRespond={(id,response)=>{void send({kind:'respond-agreement',agreementId:id,response});}} onCounter={counteroffer}
    headerAction={!open&&<button type="button" className="agreement-primary agreement-create" disabled={locked||!other.length} title={disabled?'当前状态无法操作协议':!other.length?'没有可签约的其他玩家':undefined} onClick={()=>{setCounter(null);setError('');setOpen(true);}}><Plus size={14} aria-hidden="true"/>发起协议</button>}>
  {error&&<p className="agreement-error" role="alert">{error}</p>}
  {open&&<form ref={formRef} className="agreement-form" aria-label={counter?'反提协议':'发起协议'} onSubmit={e=>{
    e.preventDefault();void send({kind:'propose-agreement',peer,terms:kind==='ceasefire'?{kind,outposts:posts}:{kind,enemy},subsidy:payer==='none'?null:{payer:payer==='self'?self:peer,amount},counterTo:counter});
  }}>
    <div className="agreement-form-heading"><h5>{counter?'修改条款并反提':'新建提案'}</h5><button type="button" aria-label="关闭提案编辑" disabled={busy} onClick={()=>{setOpen(false);setCounter(null);setError('');}}><X size={16} aria-hidden="true"/></button></div>
    <fieldset disabled={locked}>
      <div className="agreement-form-row"><label>签约对象<select value={peer} disabled={!!counter} onChange={e=>{setPeer(Number(e.target.value));setPosts([]);setEnemy(-1);}}>{other.map(p=><option key={p.player} value={p.player}>{playerNames[p.player]}</option>)}</select></label>
      <label>协议类型<select value={kind} onChange={e=>setKind(e.target.value as typeof kind)}><option value="ceasefire">据点停战</option><option value="joint-attack">攻击第三方</option></select></label>
      </div><p className="agreement-duration">签署后固定 {kind==='ceasefire'?DIPLOMACY_RULES.ceasefireTicks:DIPLOMACY_RULES.jointAttackTicks} tick</p>
      {kind==='ceasefire'?<div className="agreement-scope-section"><div className="agreement-scope-heading"><b>停战据点</b><span>已选 {posts.length}</span></div><div className="agreement-scope" role="group" aria-label="停战据点">{eligiblePosts.length?eligiblePosts.map(p=><label key={p.id}><input type="checkbox" checked={posts.includes(p.id)} onChange={e=>setPosts(old=>e.target.checked?[...old,p.id]:old.filter(id=>id!==p.id))}/><span>{o.outpostNames?.[p.id]??p.id}</span><small>{p.owner===self?'我方':'对方'}</small></label>):<p>暂无可选择的双方据点</p>}</div><p>仅保护所选据点；在途舰队不会自动返航。</p></div>:<>
        <label>共同目标<select required value={enemy} onChange={e=>setEnemy(Number(e.target.value))}><option value={-1} disabled>选择第三方</option>{other.filter(p=>p.player!==peer).map(p=><option key={p.player} value={p.player}>{playerNames[p.player]}</option>)}</select></label>
<p>双方各自占领共同敌人的任意一个据点即达标；战损不计入履约。</p>
      </>}
      <div className="agreement-subsidy"><label>签署补贴<select value={payer} onChange={e=>setPayer(e.target.value as typeof payer)}><option value="none">无补贴</option><option value="self">我支付给对方</option><option value="peer">对方支付给我</option></select></label>
      {payer!=='none'&&<label>矿产数量<input type="number" min={0} step={1} required value={amount} onChange={e=>setAmount(Number(e.target.value))}/></label>}
      {payer!=='none'&&<p>签署时立即支付矿产，协议结束或违约不自动退还。</p>}</div>
      <div className="agreement-actions"><button className="agreement-primary" type="submit" disabled={peer<0||(kind==='ceasefire'?!posts.length:enemy<0||enemy===peer)}>{busy?'正在提交…':`发送${counter?'反提':'提案'}`}</button><button type="button" onClick={()=>{setOpen(false);setCounter(null);setError('');}}>取消</button></div>
    </fieldset>
  </form>}
  </ServerAgreements>
 </div>;
}
