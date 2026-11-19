import React from 'react';
import type {PlayerDiplomacy,RelationView} from '../../contracts/src/index.js';
import {playerNames,colors} from './theme.js';

export function RelationsTable({value,player}:{value:PlayerDiplomacy|undefined;player:number|null}){
  if(!value)return <p role="status">关系数据暂不可用。</p>;
  const peers=[...new Set(value.relations.flatMap(r=>[r.from,r.to]))].filter(p=>p!==player).sort((a,b)=>a-b);
  const number=(n:number)=>n.toLocaleString('zh-CN',{maximumFractionDigits:2});
  const cell=(from:number,to:number)=>{
    const r=value.relations.find(r=>r.from===from&&r.to===to),diagonal=from===to;
    const tone=diagonal?'is-diagonal':!r||r.trust===0?'is-zero':r.trust>0?'trust-positive':'trust-negative';
    const intensity=r?Math.min(1,Math.abs(r.trust)/100):0;
    const title=diagonal?'不计自身信任':r?`历史信任 ${number(r.history)} · 边界 −${number(r.borderPressure)} · 竞争 −${number(r.competitionPressure)}`:'未授权或不可用';
    return <td key={`${from}:${to}`} className={tone} title={title} style={!diagonal&&r&&r.trust!==0?{backgroundColor:`hsla(${r.trust>0?155:5},55%,40%,${.16+intensity*.65})`}:undefined}><span className="battle-loss-value">{diagonal||!r?'—':number(r.trust)}</span></td>;
  };
  if(player===null){
    const players=[...new Set(value.relations.flatMap(r=>[r.from,r.to]))].sort((a,b)=>a-b);
    return <div className="battle-loss-scroll"><table className="battle-loss-table relations-table" style={{minWidth:64+players.length*32}}>
      <caption className="sr-only">全局信任矩阵：行玩家对列玩家的信任，范围负100至100，两个方向独立计算。</caption>
      <thead><tr><th scope="col" className="battle-loss-corner">信任方 ↓</th>{players.map(p=><th key={p} scope="col" style={{color:colors[p]}}>{playerNames[p]??`玩家 ${p+1}`}</th>)}</tr></thead>
      <tbody>{players.map(from=><tr key={from}><th scope="row" style={{color:colors[from]}}>{playerNames[from]??`玩家 ${from+1}`}</th>{players.map(to=>cell(from,to))}</tr>)}</tbody>
    </table></div>;
  }
  return <div className="battle-loss-scroll"><table className="battle-loss-table relations-table is-perspective">
    <caption className="sr-only">双方信任关系，范围负100至100，两个方向独立计算。</caption>
    <thead><tr><th scope="col">玩家</th><th scope="col">我对其信任</th><th scope="col">其对我信任</th></tr></thead>
    <tbody>{peers.map(peer=><tr key={peer}><th scope="row" style={{color:colors[peer]}}>{playerNames[peer]??`玩家 ${peer+1}`}</th>
      {cell(player,peer)}{cell(peer,player)}</tr>)}</tbody>
  </table></div>;
}
