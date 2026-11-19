import React, {useEffect,useRef,useState} from 'react';
import {tickTime,worldCountdown} from './time.js';

/** Booking uses an absolute integer day, never a duration added to a fractional now. */
export function parseWorldDepartureDays(text:string,minimum=0,maximum=Number.MAX_SAFE_INTEGER):number {
  if (!/^\d+$/.test(text.trim())) throw Error('预约执行日必须为整数，例如第3天。');
  const day=Number(text);
  if(!Number.isSafeInteger(day)||day<minimum||day>maximum)throw Error(`请选择第${minimum}至第${maximum}天。`);
  return day;
}
export function nextIntegerDepartureDay(now:number,previewDay=now):number {
  return Math.max(Math.floor(now)+1,Math.ceil(previewDay));
}
export function WorldDepartureInput({day,minimum,maximum,currentDay,onChange,onValidityChange}:{day:number;minimum:number;maximum:number;currentDay:number;onChange:(day:number)=>void;onValidityChange:(valid:boolean)=>void}) {
  const [text,setText]=useState(String(day)),[error,setError]=useState('');
  const validityCallback=useRef(onValidityChange);
  validityCallback.current=onValidityChange;
  useEffect(()=>{setText(String(day));setError('');validityCallback.current(Number.isSafeInteger(day)&&day>=minimum&&day<=maximum);},[day,minimum,maximum]);
  return <div className="world-departure-input">
    <label>预约出发日<input aria-label="预约出发日" type="number" inputMode="numeric" step={1} min={minimum} max={maximum} value={text} onChange={event=>{
      const value=event.target.value;setText(value);
      try {const next=parseWorldDepartureDays(value,minimum,maximum);setError('');onValidityChange(true);onChange(next);}catch {onValidityChange(false);setError(`只能预约整数世界日：第${minimum}至第${maximum}天。此输入尚未应用。`);}
    }}/></label>
    <small>预约出发：{tickTime(day)}；距当前{worldCountdown((day-currentDay)*600)}。最早可选{tickTime(minimum)}，到时直接出发。</small>
    <small>执行日期必须为整数；抵达时间仍可为小数天。</small>
    {error&&<small role="alert">{error}</small>}
  </div>;
}
