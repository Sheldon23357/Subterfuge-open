import React from 'react';
import {colors,playerNames} from './theme.js';
import {tickTime} from './time.js';

export function BattleLossMatrix({matrix,count,tick}:{matrix:number[][]|undefined;count:number;tick:number}) {
  const players=Array.from({length:count},(_,i)=>i);
  const maximum=Math.max(0,...(matrix??[]).flat());
  const player=(i:number)=>playerNames[i]??`玩家 ${i+1}`;
  return <>
    <div className="battle-loss-context"><span>全局累计兵力战损</span><time>{tickTime(tick)}</time></div>
    {!matrix?<p className="battle-loss-note" role="status">战损统计暂不可用。</p>:<>
      <div className="battle-loss-scroll">
        <table className="battle-loss-table" style={{minWidth:64+count*32}}>
          <caption className="sr-only">所有玩家累计战损矩阵。纵轴是承受损失方，横轴是造成损失方，数字为损失兵力。</caption>
          <thead><tr><th scope="col" className="battle-loss-corner">损失方 ↓</th>{players.map(i=><th scope="col" key={i}><span style={{color:colors[i]}}>{player(i)}</span></th>)}</tr></thead>
          <tbody>{players.map(row=><tr key={row}>
            <th scope="row"><span style={{color:colors[row]}}>{player(row)}</span></th>
            {players.map(col=>{
              const value=matrix[row]?.[col]??0;
              const intensity=maximum?value/maximum:0;
              return <td key={col} className={row===col?'is-diagonal':value?'has-loss':'is-zero'}
                style={row!==col&&value?{backgroundColor:`hsl(12 56% ${90-58*intensity}%)`,color:intensity<0.65?'#35140e':'#fff2ec'}:undefined}
                title={row===col?`${player(row)}：不计自身战损`:`${player(row)}被${player(col)}造成 ${value} 兵损失`}
                aria-label={row===col?'不适用':`${player(row)}被${player(col)}造成 ${value} 兵损失`}>
                <span className="battle-loss-value">{row===col?'—':value}</span>
              </td>;
            })}
          </tr>)}</tbody>
        </table>
      </div>
    </>}
  </>;
}
