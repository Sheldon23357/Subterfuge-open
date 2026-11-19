import {encodePromptSections} from '@subterfuge/bot-sdk/contracts';
import {promptMaterialSections} from './prompt-material.js';
import {presentModelNumbers} from './model-numbers.js';
import {currentModelVision} from './model-vision.js';
import {HYBRID_PROMPT_CHARACTERS} from './contracts.js';
import {contextIntents} from './intent-context.js';
import type {CommanderPromptInput} from '@subterfuge/bot-sdk/contracts/bot-mode';
import {namedBrief,mentionedOutposts} from './model-names.js';
import {hybridPlanning} from './planning.js';
import {attackConclusions} from './attack-context.js';
import {effectiveAgreement} from './agreement-active.js';
import {constraints} from './operations.js';
import {hybridCommanderInstructions} from './prompts.js';
import type {HybridState,OperationState,TacticalFeedback} from './contracts.js';
/** The discussion lane receives the actual published strategy, not stale model memory. */
export function hybridCommanderPrompt(input:CommanderPromptInput & {latest:<T>(name:string)=>T|undefined}):string {
 const {mode,state,thread,message,roster}=input,o=currentModelVision(input.observation),saved=input.latest<HybridState>('state'),d=saved?.directive;
 const discussion=(message?.text??'')+'\n'+thread.directives.text;
 const referenced=new Set([...(message?.references.map(r=>r.id)??[]),...mentionedOutposts(discussion,o)]);
 const opponents=new Set(roster.filter(p=>typeof p.displayName==='string'&&discussion.includes(p.displayName)).map(p=>p.gamePlayer));
 const planning=referenced.size||opponents.size?hybridPlanning(o,[...referenced],[...opponents]):undefined;
 const assessmentTargets=new Set([...referenced,...(planning?.candidates.filter(c=>c.owner!==null&&c.owner!==undefined&&opponents.has(c.owner)).slice(0,3).map(c=>c.target)??[])]);
 const attackAssessment=attackConclusions(planning,assessmentTargets);
 for(const target of attackAssessment?.targets??[])referenced.add(target.target);
 const instructions=hybridCommanderInstructions(mode);
 const required={mode,room:o.roomId,player:o.view.player,tick:o.view.tick,roster,currentMessage:message,confirmedDirectives:thread.directives,publishedStrategy:d?{version:d.version,summary:d.summary,commanderVersion:d.commanderVersion,agreements:d.agreements.filter(g=>effectiveAgreement(g,o.view.tick+o.secondsSinceLastTick/600)).map(g=>({players:g.players,status:g.status,jointAttack:g.jointAttack??null,summary:g.summary,internalIntent:g.internalIntent,forbiddenTargets:g.forbiddenTargets,expiresWorldDay:g.expiresWorldDay}))}:null,self:o.view.self,intel:o.intel,identities:o.view.outposts.map(p=>({id:p.id,name:o.outpostNames?.[p.id],owner:p.owner,type:p.type??null,drillers:p.drillers??null,shield:p.shield??null})),relevantFacts:o.view.outposts.filter(p=>referenced.has(p.id)||p.owner===o.view.player).map(p=>({id:p.id,drillers:p.drillers,shield:p.shield,type:p.type,production:p.metrics?{output:p.metrics.output,cycleMinutes:p.metrics.cycleMinutes}:null})),fleets:o.view.fleets.map(f=>({id:f.id,owner:f.owner,drillers:f.drillers??null,state:f.state,destination:f.destination??null})),manual:o.manualCommands,execution:{pending:input.latest<{operations:OperationState[]}>('operations')?.operations.filter(p=>['proposed','accepted','underway','review'].includes(p.status)).slice(-4).map(p=>({objective:p.objective,status:p.status,issues:p.issues})),tactical:input.latest<TacticalFeedback>('feedback')?.selected},executionRules:constraints(d??null,o,saved)};
 const history=thread.messages.filter(m=>m.id!==message?.id).slice(-6).map(m=>({role:m.role,text:m.text,tick:m.tick,proposal:m.proposal?{baseVersion:m.proposal.baseVersion,status:m.proposal.status,summary:m.proposal.summary}:null}));
 for(let count=history.length;count>=0;count--){const prompt=encodePromptSections([{id:'instructions.commander',label:'指挥官讨论与整理规则',format:'text',text:instructions},...promptMaterialSections(presentModelNumbers(namedBrief({...required,...(attackAssessment?{attackAssessment}:{}),intentTasks:contextIntents(saved,o.view.tick+o.secondsSinceLastTick/600).filter(t=>!['completed','cancelled','expired'].includes(t.status)).map(t=>({id:t.id,spec:t.spec,status:t.status,authority:t.authority,reason:t.reason})),history:history.slice(history.length-count),historyCoverage:{included:count,total:thread.messages.length,meaning:'只提供最近相关讨论；当前问题、已确认指令和已发布战略完整保留'}},o)).value)]);if(prompt.length<=HYBRID_PROMPT_CHARACTERS)return prompt;}
 throw Error(`指挥官必要材料超过${HYBRID_PROMPT_CHARACTERS}字符，请缩小当前讨论范围；未调用模型`);
}
