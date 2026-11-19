import {browserRequestId} from './browser-request-id.js';
import {ManualCommandProtectionNote} from './ManualCommandProtectionNote.js';
import React,{useState} from 'react';
import type {ManualCommandView,QueuedOrderView} from '../../contracts/src/index.js';
import {tickTime} from './time.js';
import {errorMessage} from './copy.js';

const labels:Record<string,string>={launch:'派遣舰队','set-shields':'调整护盾','toggle-mine':'改建矿场','toggle-funding':'调整资助','return-fleet':'舰队返航','cancel-launch':'取消派遣',resign:'投降'};
export function OrderAgenda({view,player,busy,execute,manualCommands}: {
  view:{tick:number;orders?:QueuedOrderView[];outposts:{id:string;name:string}[];};player:number;busy:boolean;execute:(path:string,input:unknown,message:string)=>Promise<unknown>;
  manualCommands?:ManualCommandView|undefined;
}){
  const [editing,setEditing]=useState(''),[drillers,setDrillers]=useState(0);
  const rows=(view.orders??[]).filter(p=>p.player===player&&(p.status==='pending'||p.status==='failed'));
  const aligned=(p:QueuedOrderView)=>Number.isInteger(p.issueTick)&&(p.action.kind!=='launch'||p.action.delaySeconds===undefined||(typeof p.action.delaySeconds==='number'&&p.action.delaySeconds>=0&&Number.isInteger(p.action.delaySeconds/600)));
  const name=(id:unknown)=>view.outposts.find(o=>o.id===id)?.name??'目标';
  function edit(p:QueuedOrderView){setEditing(p.id);setDrillers(Number(p.action.drillers));}
  return <div className="rule-actions agenda-list">
    <p className="muted" style={{fontSize:11,lineHeight:1.5,margin:"0 0 8px"}}>预约按指定整数世界日依次执行，并重新检查单位与资源。</p>
    {!rows.length&&<p className="muted">暂无预约。</p>}
    {rows.map(p=><article className="agenda-item" key={p.id}>
      <div className="agenda-heading"><b>{labels[p.action.kind]??'对局指令'}</b><span>{tickTime(p.issueTick)}</span></div>
      {p.action.kind==='launch'&&<p className="agenda-summary">{name(p.action.source)} → {name(p.action.destination)} · {Number(p.action.drillers)} 舰</p>}
      <ManualCommandProtectionNote view={manualCommands} scopes={[`schedule:${p.id}`]}/>
      <div className="agenda-footer">
      <span className="agenda-status">{p.status==='pending'?(p.failed?'关联修改未生效，本条仍等待执行':'等待执行'):`未生效：${errorMessage(p.reason??'无法执行')}`}</span>
      {p.status==='pending'&&<div className="agenda-actions">
        {p.action.kind==='launch'&&p.issueTick>view.tick&&<button disabled={busy||!aligned(p)} title={aligned(p)?undefined:"原预约不在整数世界日，请取消后重新预约"} onClick={()=>edit(p)}>修改舰数</button>}
        <button disabled={busy} onClick={()=>void execute('cancel-schedule',{id:p.id,player},'关联预约已取消')}>取消预约</button>
      </div>}
      </div>
      {p.id===editing&&p.status==='pending'&&<form className="agenda-edit" onSubmit={e=>{
        e.preventDefault();if(!aligned(p))return;const action={...p.action,drillers,fleetId:p.action.fleetId??p.id};
        void execute('schedule-order',{order:{id:browserRequestId(),player,action},issueTick:p.issueTick},'派遣修改已预约').then(ok=>{if(ok)setEditing('');});
      }}>
        <label>派遣舰数<input type="number" min={1} max={1000000000} step={1} required value={drillers} onChange={e=>setDrillers(e.target.valueAsNumber)}/></label>

        <p>保留原出发时间。修改会在同一整数预约日依次生效。</p><div className="two-buttons"><button type="submit" disabled={busy||!Number.isInteger(drillers)||drillers<1}>保存修改</button><button type="button" onClick={()=>setEditing('')}>返回</button></div>
      </form>}
    </article>)}
  </div>;
}
