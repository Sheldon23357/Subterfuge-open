import React from 'react';
import type {PlayerControlView} from './player-control-view.js';
export function PlayerControlStatus({value,error}:{value:PlayerControlView|null;error:string}) {
  const ai=value?.mode==='agent'||value?.controller==='hosted';
  const warning=error||(ai&&value?.manualCommandsAllowed!==true?'当前服务器尚不支持 AI 运行时手动下令。':'');
  if(!warning)return null;
  return <div className="player-controller" role="alert">{warning}</div>;
}
