import React from 'react';
import {AI_PERSONALITIES} from '../../contracts/src/index.js';

const styles=[
 ['schemer','经营多方关系，借合作、诱导和择机背叛创造机会。'],
 ['sentinel','利用矛盾与选择性信息，引导对手互耗。'],
 ['raider','集中兵力，利用航程和抵达时间差打击薄弱据点。'],
 ['merchant','利益优先，围绕明确条件谈判与交换。'],
 ['mediator','组织互惠合作、夹击与牵制，为自身胜利保留筹码。'],
] as const satisfies readonly (readonly [keyof typeof AI_PERSONALITIES,string])[];
export function AgentPersonalityOptions({value,onChange}:{value:string;onChange:(value:string)=>void}){
 const current=(AI_PERSONALITIES as Record<string,{label:string}>)[value];
 return <label className="bot-setting personality-select"><span className="bot-setting-title">决策风格</span><select value={value} onChange={e=>onChange(e.target.value)}>
  {!styles.some(([id])=>id===value)&&<option value={value}>{current?.label??value}</option>}
  {styles.map(([id,summary])=><option key={id} value={id} title={summary}>{AI_PERSONALITIES[id].label}</option>)}
 </select></label>;
}
