import React from 'react';
import {DEFAULT_BOT_SETTINGS,BOT_SETTING_LIMITS,type BotSettingKey,type BotSettings} from '../../contracts/src/index.js';

export function AgentBotSettings({value,disabled,onChange,title='战术策略参数'}:{value?:BotSettings|undefined;disabled:boolean;onChange:(settings:BotSettings)=>void;title?:string}){
 const settings={...DEFAULT_BOT_SETTINGS,...value};
 const field=(key:BotSettingKey,label:string,help:string,step:number,scale=1)=>{
  const limits=BOT_SETTING_LIMITS[key],current=settings[key]*scale;
  return <label className="bot-setting" key={key}><span className="bot-setting-title">{label}</span><input name={key} type="number" required min={limits.min*scale} max={limits.max*scale} step={limits.integer?step:'any'} value={Number.isFinite(current)?Number(current.toFixed(6)):''} onChange={e=>{
   const amount=e.target.valueAsNumber/scale;
   onChange({...settings,[key]:limits.integer&&scale!==1?Math.round(amount):amount});
  }}/><small>{help}</small></label>;
 };
 return <section className="strategy-form bot-settings"><fieldset disabled={disabled}><legend>{title}</legend>
  <section><h3>行动选择</h3><div className="bot-settings-grid">
   {field('minActionGain','综合收益门槛（分）','普通收益占60%、压力收益占40%；所有自主行动共用门槛。',0.1)}
   {field('objectiveSwitchTolerance','目标保持容差（分）','提高后更倾向保持原目标。',0.1)}
  </div></section>
  <section><h3>兵力与未知风险</h3><div className="bot-settings-grid">
   {field('forceBufferRatio','兵力余量（%）','进攻与增援的额外兵量比例。',1,100)}
   {field('remoteUncertaintyForceFraction','远程进攻投入上限（%）','抵达结果未知时的兵力投入比例；0禁用。',1,100)}
  </div></section>
  <section><h3>评分倾向</h3><div className="bot-settings-grid">
   {field('economyWeight','经济权重（倍）','调整生产与采矿收益的评分。',0.05)}
   {field('defenseWeight','防守权重（倍）','调整防守与兵力缺口的评分。',0.05)}
   {field('territoryWeight','领土权重（倍）','调整领土与夺点收益的评分。',0.05)}
  </div></section>
  <section><h3>计算与调度</h3><div className="bot-settings-grid">
   {field('maxElapsedMs','每轮计算时间（秒）','每轮搜索的时间预算。',0.001,0.001)}
   {field('maxSimulations','每轮模拟上限（次）','每轮最多执行的模拟次数。',1)}
   {field('horizonTicks','推演范围（世界日）','每次模拟向前计算的天数。',1)}
   {field('reviewIntervalTicks','自主复查间隔（世界日）','无模型自主规划的例行复查间隔，重要事件可提前唤醒。',1)}
  </div></section>
  <div className="form-actions"><button type="button" onClick={()=>onChange({...DEFAULT_BOT_SETTINGS})}>恢复默认参数</button><span className="muted">仅重置表单，保存后生效。</span></div>
 </fieldset></section>;
}
