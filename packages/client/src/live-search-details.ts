import type {BotSearchProgress} from '../../contracts/src/index.js';
import {describeLiveInstruction,readableExecutionText} from './AgentPlanInstructions.js';

export function searchActionDetails(branch:BotSearchProgress['branches'][number],names:Record<string,string>):string[]{
 if(branch.actions?.length)return branch.actions.map(d=>{const item=describeLiveInstruction({...d.action},names);return `${item.kind} · ${item.description} · 计划第 ${d.issueTick} 日`;});
 if(branch.kind==='hold')return ['维持现有行动，不新增指令'];
 if(branch.routes.length)return branch.routes.map(r=>`路线 · ${readableExecutionText(names[r.source]??r.source)} → ${readableExecutionText(names[r.target]??r.target)} · ${r.drillers===null?'兵力未记录':r.drillers+' 兵'}`);
 return ['此记录未包含行动详情'];
}
