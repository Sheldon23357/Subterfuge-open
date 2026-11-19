import {commanderOutputInstruction,permanentRules,phaseRuleGuidance} from '@subterfuge/bot-sdk/presentation/game-prompts';
import {encodePromptSections,type PromptSection} from '@subterfuge/bot-sdk/contracts';
import {promptMaterialSections} from './prompt-material.js';
import {MODEL_MATERIAL_RULES} from './model-material.js';
import {MODEL_NUMBER_RULES} from './model-numbers.js';
import {MODEL_VISION_RULES} from './model-vision.js';
/** Fixed hybrid model instructions. Dynamic observations stay in brief.ts/commander.ts.
 * Sections: response format, diplomacy, background roles, private discussion,
 * shared commander output contract, ordinary mechanics and phase guidance. */
import {DIPLOMACY_RULES,RULES} from '@subterfuge/bot-sdk/rules';
import {COMMANDER_VOICES} from '@subterfuge/bot-sdk/contracts';
import type {CommanderThread,CommanderMessage,PlayerObservation} from '@subterfuge/bot-sdk/contracts';
import type {AiState,AiSnapshot,NotebookEntry} from '@subterfuge/bot-sdk/contracts/types';
import type {SituationBrief} from './contracts.js';
import {DEFAULT_INTENT_PRIORITY} from './intent-schema.js';
import {BOT_RELATION_POLICY} from './relation-policy.js';
import {commanderReplyRules,type CommanderMode} from '@subterfuge/bot-sdk/contracts/commander-protocol';
import {MANUAL_COMMAND_POLICY,commanderManualObservation} from '@subterfuge/bot-sdk/execution/manual-coordination';
import {roundMapBlocks,activeNotesTable,ROUND_TERMINOLOGY} from '@subterfuge/bot-sdk/presentation/round-map';
import {fleetReferenceRenderer} from '@subterfuge/bot-sdk/presentation/fleet-labels';
import {presentOutpostNames} from '@subterfuge/bot-sdk/presentation/outpost-references';
import {miningPhaseContext,phaseLabel,type MiningPhase} from '@subterfuge/bot-sdk/analysis/mining-phase';

// ── 模型输出与任务字段 ──
type ResponseSchema=Record<string,any>;
const taskKinds=(schema:ResponseSchema)=>schema.properties?.tasks?.maxItems===0?[]:
 (schema.properties?.tasks?.items?.anyOf??[]).flatMap((branch:ResponseSchema)=>branch.properties?.kind?.enum??[]);

/** Select protocol explanations from the same capabilities used for generation.
 * The host still validates every reply; no error feedback changes these rules. */
export function modelWireInstructionsFor(kind:SituationBrief['kind'],schema:ResponseSchema={}){
 const kinds=taskKinds(schema),has=(value:string)=>kinds.includes(value),properties=schema.properties??{};
 const priority=kinds.filter((value:string)=>['capture','configure','transfer'].includes(value));
 return [
  '输出一个浅层JSON对象，不输出Markdown。summary、tasks、cancel、reviewOn始终返回；没有内容时summary为空字符串，其余为空数组。其他未使用的可选字段省略。字段结构遵守固定Schema；引用和动作只能选择facts.permissions给出的本轮授权范围。Schema中存在某种动作不代表本轮有执行权限，程序仍逐项校验。',
  ...(kinds.length?[
   'tasks为扁平对象数组，每项直接填写id、kind及所需参数，不套upsert或task。新增id可省略或填null；修改只能复制permissions.editableTaskIds中的已有ID，不能自造ID。未提及的意图继续有效，不重复创建同一任务。reason仅说明，不代替参数。',
   '所有任务的until为绝对世界日，必须严格大于本轮brief.global中time.worldDay；合同任务参考合同deadline设置战略有效期，不预测具体出航时间。程序在发布前依据当前时间再次校验。',
   ...(has('avoid')?['avoid填target完整据点名，指定本方战略禁攻目标。']:[]),
   ...(has('capture')?['capture填target完整据点名；maxDrillersPerPlan限制单个完整方案的新增兵力总量，不是累计投入。']:[]),
   ...(has('configure')?['configure仅配置当前己方据点，填target和minDrillers/maxDrillers至少一侧，maintain表示持续留守。']:[]),
   ...(has('transfer')?['transfer填source、target、drillers（正整数或null表示执行时安全可调量），两端必须是不同的当前己方据点；在途占领不能当作已归属。']:[]),
   ...(has('return-fleet')?['return-fleet仅填当前可返航的fleetId及期限，不填据点target；取消其他任务不会撤回在途舰队。']:[]),
   ...(has('focus')?['focus填target和rally，仅转译已确认指挥官要求。']:[]),
   ...(priority.length?[priority.join('/')+'无论新增还是更新都必须填写priority，取0到100的数值，不能为null；新增普通优先级为'+DEFAULT_INTENT_PRIORITY+'，保持原优先级时复制当前任务值；其他任务不填priority。']:[]),
  ]:['本轮tasks必须为空数组。']),
  properties.cancel?.maxItems>0?'cancel只填写permissions.cancelTaskIds中的已有任务ID；maxCancel为0时必须为空数组；取消不会撤回在途舰队。':'本轮cancel必须为空数组。',
  '战略只比较少量目标、投入与止损；summary保存判断，不能当作执行指令。reviewOn保存简短复查条件，数量和长度按Schema限制。tasks和cancel同时遵守permissions.maxTasks/maxCancel；每种任务的targets、sources、rallies、fleetIds分别限定引用。空列表不授予任何引用权限，缺失的任务种类禁止使用。',
  ...(kind==='commander'?['顶层forbiddenPlayers、protectedSources、reserves（每项source、drillers）必须完整提供，空数组明确表示无该限制；只转译已确认要求。protectedSources禁止来源的所有新出兵，不能包含同轮transfer的source；保持其他自主安排照常不构成新的来源保护或最低留兵要求。']:[]),
  ...(kind==='diplomacy'?[diplomacyActionInstructions(schema)]:[]),
  '前台程序与模型并行，前台自主完成战术选择和执行，不等待模型审批。程序提供当前事实、执行反馈及本轮相关目标的初筛结论；模型制定战略方向、投入边界和止损条件，不重做配兵、路线和战斗计算。实际结果以程序反馈为准，高信任不代表盟友已出兵。已有矿场和真实防守优先，开矿支付当地兵力，不消耗矿量。',
  MODEL_NUMBER_RULES,MODEL_VISION_RULES,
 ].join('\n');
}

function diplomacyActionInstructions(_schema:ResponseSchema){
 return [
  '外交有共同利益时比较两线夹击、边界停战和补贴交换，只处理固定会话。message（对外发言）与action（正式服务器操作）分别决定；聊天中的同意不是签署回执。action只选permissions.diplomacy.actions，peer可省略，由程序绑定当前会话唯一对手；显式peer只能使用该清单peer；没有正式操作时action为none或省略，内部判断用agreementSummary、internalIntent。',
  '签约评估以本方胜利路径为准，先分清本方所得、对方所得、本方代价及不签约的选择。停战按当前授权归属核对保护清单：只纳入对方据点，直接保护的是对方资产，不等于本方矿场或边界得到保护，也不约束清单外的反击。夹击核对本方实际占领义务与对方牵制的价值；补贴核对付款方向及对手更接近胜利的代价。不得把对方的求和理由、共同利益措辞或“避免消耗”直接当作本方获益证据。',
  '比较签约与最佳可行的不签方案：继续现有行动、独立撤军止损、暂缓、拒绝或反提。能通过单独撤军保住的兵力，不全部记成签约新增收益；已发生损失属于沉没成本，不因已经撤军就必须签约。评估新增撤军损兵、放弃攻势或谈判筹码、保护竞争对手收入、履约投入及名额占用。复用程序提供的事实和条件估算；缺少作战对照时保留未知，不编造必胜、必败、损失、成功概率或净收益分数。',
  '不要求收益对等、必须互保己方据点或必须收补贴。非对称让利也可签，但须说明本方因此新增的具体战略利益及其依据，例如有实际威胁支持的减线、可执行的转兵机会或可核对的对价，并解释为何优于独立止损。签约信任奖励、对方善意或回收点安全本身不足以证明值得大额让利。仅能确认对方得益、本方获益没有依据时，不以默认同意填补判断，优先反提、暂缓或拒绝；不因资料不完备一概禁止有依据的合作。',
  '待签提案与可响应动作由permissions.diplomacy.responses逐条给出。对方提案才可accept/reject，本方提案仅可withdraw；本方发起时已同意，保持条款应等待对方正式接受。agreementId必须复制对应提案身份，不能对已生效或已终止合同再次签署。没有待签提案则不输出响应动作。',
  '检查serverAgreements中的当前生效范围与双方待签版本。同一双方、同一保护范围已有生效停战时，不重复签约或把重复提案当作新增收益；双方同时提出相同条款时优先收束到一份可操作提案，不再另起第三份。已有本方待签版本时不换新身份重复发布。未知命令结果先等回执，不因尚未看见生效就再次签署。',
  '新停战填outposts，只能从permissions.diplomacy.ceasefireOutposts选择；新夹击只需填enemy，不填写战损或额度，enemy只能从权限清单enemies选择。补贴使用subsidy对象，payer与amount必须成对填写，payer只能选subsidyPayers；不补贴省略subsidy或填null，不能只填金额。反提counterTo只能复制权限清单counterTo中的所收提案ID，双方占领目标固定且相同。',
  `夹击目标固定：双方在签署后的${DIPLOMACY_RULES.jointAttackTicks} tick内，各自实际占领共同敌人的任意一个据点；不预先指定据点，不按战损计分，不填写个人额度。保持主动接触、提案及接受机会；初筛不完备不自动禁止协商。结合可投入兵力、集结和抵达期限判断是否签约，不要求盟友先出兵；不可承担时调整共同敌人或条款，来源安全、指挥官禁攻和服务器名额仍须遵守。`,
  '发起或接受停战前读取ceasefireSigningAssessment，按所选据点核对双方在途攻击、本方可撤回舰队、返航减半损兵、回收点归属及可见来袭。提交提案或accept表示已把这些撤军成本计入取舍；程序会先确认本方撤回，再提交协议，提案被拒也不会退还损失。损失过大时缩小停战范围或等待结算，不盲目签约。对方在途舰队未确认撤回仍是实际风险，不能认为签约会自动阻止抵达；无法返航、回收点失守或人工保护冲突时不得假定能安全撤回。',
  '决定发起、接受、拒绝或反提时，在internalIntent简要保留“本方新增利益及依据—主要代价—为何优于不签—重新评估条件”；agreementSummary只概括确切条款，不用它代替收益判断。对外message可讨价还价或保留真实目的，但内部记录不能只复述对方需求、条款、安全检查通过或“促进合作”。不新增响应字段，不要求长篇逐步推理。',
  '接受夹击是承诺本方主动进攻，不是同意旁观或等待盟友先动。签署生效后优先围绕该enemy、本方占领目标是否完成及deadline评估可达进攻、必要集结与增兵；internalIntent写明本方攻击方向及受阻后的调整条件，不能只说支持、等待或保持沟通。待签时没有军事编辑权限就只提交合法accept，生效后程序自动展开履约目标，再依据新权限调整任务。对方先达标不会解除本方占领义务；本方已达标后停止以履约名义新增进攻，保留来源安全与指挥官约束。',
  '履约军事任务只编辑当前合同给定范围；fulfillAgreementId优先填顶层，唯一可编辑合同时可省略，多份须从permissions.fulfillmentAgreementIds精确选择，一轮不混用合同。无可编辑合同时tasks和cancel为空，签约后的目标由程序依合同派生。假意接受可以只发言而不提交操作，真实签署仍承担服务器义务和后果。',
  '已知但不适用的外交参数忽略并审计，不改变原条款；背叛意图不免除服务器后果。betrayAgreements只能复制permissions.betrayalAgreementIds中的本人有效合同。',
 ].join('\n');
}

// ── 外交规则与关系策略 ──
export const relationInstructions=`服务器每席同时生效的停战最多${DIPLOMACY_RULES.maxActiveCeasefires}份、夹击最多${DIPLOMACY_RULES.maxActiveJointAttacks}份，适用于签约双方。个人已达标但合同仍active也占名额，待签提案不预占；签署时服务器重新检查双方，满额则失败且不转补贴。relationAdvice提供本方完整占用和剩余名额；对方只列本方有权知道的合同下界，不能推断其剩余名额。查看serverAgreements后再决定回复，满额优先拒绝、暂缓或履行现有合同，不能用反提绕过名额。
关系策略：双向信任分别判断，达到${BOT_RELATION_POLICY.highTrust}才视为较高信任，低于${BOT_RELATION_POLICY.lowTrust}应增加风险折价但不禁谈；负信任可能来自边界和竞争，不能直接认定背叛。高信任也不能当作已出兵。通常并行未完成承诺不超过${BOT_RELATION_POLICY.maxOpenJointContracts}份、敌对方向不超过${BOT_RELATION_POLICY.maxEnemyFronts}个。夹击双方各占领共同敌人任意一个据点，不计算个人额度；结合现有战线、兵力、来源安全和期限判断，不新增提案或签约频率限制。补贴建议不超过库存${BOT_RELATION_POLICY.subsidyStockFraction*100}%且最多${BOT_RELATION_POLICY.maxSubsidy}矿，检查对方收款后的获胜距离；策略建议可因明确收益调整，服务器名额不可突破。已有自动履约目标不重复创建多份capture；最多保留两个新增进攻重点，取消无进展的模型旧意图，不能取消服务器合同。`;

const dialogueRules={
 military:"外交任务严格按editPolicy分工：intentTasks及各合同editableTaskIds才可更新或取消，readOnlyIntentTasks仅作全局背景，不修复、取消或复制其中的独立战略、指挥官和其他合同任务。唯一已签合同时fulfillAgreementId可省略，由程序绑定；多份合同时只复制所选合同的精确身份，不改写或猜测。",
 assessment:"外交评审与对外发言分别决定。可以完整阅读来信、修复任务和更新内部判断，同时message=null或省略。沉默是正常结果；不是每轮都要回复，也不为已读、已确认、保持现状再发确认。",
 silence:"先比较最新双方发言：没有新条件、可核实结果、需要回答的具体问题、改变的立场或明确战略信号，就不发message。对方只说收到/维持/等回执时，通常内部记下并停止往返。主动评审、局势压力或自己调了任务，也不自动需要向对方报告。不要重复“暂不新增夹击、停战、补贴；等回执再评估”，不要每轮换词重述同一立场。",
 proposal:"没有新来信或待签提案不妨碍主动提出新协议。first-contact或尚未提出过的具体共同利益，应比较可执行停战/夹击/条件交换；不要让双方都等对方先提；自己提出可执行新条款本身就是信息增量。militaryEditsAllowed=false只禁止军事任务编辑，不禁止合法外交提案或回答问题。正式停战只能选communicationFacts.ceasefireOutpostsByOwner中按归属列出的双方据点；中立或第三方据点不能签停战，不因有意争夺就当作已归属。夹击满额不等于停战满额。仅抑制重复立场，不压制首次有具体条款的有价值提议。",
 questions:"对方提出边界清单、共同敌人或协防条件等具体问题时，应回答、给可承担的反案或明确拒绝；不能以“没有待签提案”回避。收束时说明一次具体条件，之后等该条件变化。确有威慑、欺骗、讨价还价等新战略目的可发信号，在internalIntent说明目的，不把程序限制当外交理由。",
 fulfillment:"serverAgreements.current按停战/夹击列出当前条款、edits权限和feasibility/taskFeasibility；history及otherHistory仅为已终止结果，不是当前义务，不可复活。履约先看当前合同内的可行性、executionFeasibility与真实回执：只有实际占领合同enemy据点才履约，不能把其他敌人的在途行动当作该合同履约。已有任务上限明显不足时，本轮应修改/取消该不可行任务，或在internalIntent明确保留它的条件与止损，不能只在summary说等待。履约要求实际占领共同敌人任意一个据点；杀伤、守军消耗、舰队战和单纯出兵均不算完成。一个据点不等于一兵上限。上限不足以突破当前护盾/驻军、长期pending/blocked、航程超出期限时，比较提高可承担投入、改选同一敌人的可行目标、集结或承担未占领的失约后果；不要只是延长期限、复制低上限或继续等待并不存在的出发/抵达。投入应结合screenedNewForceEstimate、航行期间产兵与来源安全，不能仅提到当前静态最低值就声称可执行。静态和初筛估算都不等于未来保证，实际占领只看服务器结算。",
 claims:"对外发送前核对：我方/你方由communicationFacts及归属确定，不能把盟友说的“我方防守X”复制成本方行动。说将做某事须有本方明确意图或相应任务；任务已创建/上限提高不等于舰队已出发。己方已达标、对方尚欠多少、合同是否生效/到期均用服务器事实，不从旧聊天沿用；到期后克制不是正式停战。",
 disclosure:"complete=false或remaining=null的对方名额是未知，不能声称对方有空位或满额。仅在本方可见合同下界已经达到服务器上限时，才能确认至少已满。对方名额未知不影响本合同peerProgress/peerCapturesRemaining是服务器已知事实，不要把两者混为未知。其他会话合同用于内部预算，未经明确的情报交易或战略披露目的不对外透露。固定会话、Schema、editPolicy、任务ID、编辑权限等只放内部，message用玩家能理解的自然语言。",
 capacity:"发起新提案前再次核对本方该类型剩余名额：remainingJointAttacks=0时本轮不发起joint-attack，个人目标固定为一个据点也不会释放名额；可比较仍有名额的停战或内部等待。不要用反提绕过容量。对方未知名额不等于不可谈判；本方已知满额不能冒充可立即签署。",
 ceasefire:"停战清单中纳入保护与排除不保护要明确区分，不把同一清单同时写成纳入和排除。正式停战只保护清单内双方对彼此的实际交战，不禁止向己方据点增援、不保护第三方；若另谈口头不进入条件，要与正式保护范围分开说明，不能声称服务器会执行额外限制。",
 names:"对外按roster.name称呼玩家，用完整据点名称，不把据点名当玩家，不使用enemy编号或内部任务编号作为对方称呼。",
 wording:"正式动作和措辞一致：新发joint-attack/ceasefire是提议，命令未结算前不宣称合同已经生效。正式动作可以不附聊天，不能为凑回复伪造新提案。",
};
function diplomacyDialogueInstructionsFor(_schema:ResponseSchema){
 return [dialogueRules.military,'capture只选当前合同captureTargets，其他合同和独立战略任务不在本轮编辑范围。',
  dialogueRules.assessment,dialogueRules.silence,dialogueRules.proposal,dialogueRules.questions,dialogueRules.fulfillment,
  dialogueRules.claims,dialogueRules.disclosure,dialogueRules.capacity,dialogueRules.ceasefire,dialogueRules.names,dialogueRules.wording].join('\n');
}

// ── 后台：战略、外交、指挥官转译 ──
export function hybridBriefPrompt(kind:SituationBrief['kind'],hasDiplomacy:boolean,_opening:boolean,_noEditableAgreements:boolean,brief:unknown,responseSchema:ResponseSchema={}){
 const role=kind==='diplomacy'?'评估当前会话的合作、正式提案与履约；是否发言、是否提交正式操作分别决定。':kind==='commander'?'只转译完整已确认指挥官要求，保留原文范围。':'统筹胜利路径、少量目标与止损，战略/外交不能修改指挥官任务。';
 const rules=hasDiplomacy?`正式停战固定 ${DIPLOMACY_RULES.ceasefireTicks} tick，夹击固定 ${DIPLOMACY_RULES.jointAttackTicks} tick，均从实际签署起算且期限不可更改，待签提案${DIPLOMACY_RULES.proposalTicks}tick。夹击双方各自实际占领共同敌人任意一个据点；不按兵损计分，普通据点与矿点相同；个人达标奖励与未完成处罚使用简报中的固定值，多占不追加奖励。补贴签署时立即支付，不自动退款；口头承诺不受约束。停战可背叛，攻击照常结算。\n`+relationInstructions:'';
 const sections:PromptSection[]=[
  {id:'instructions.output',label:'模型输出与任务字段',format:'text',text:modelWireInstructionsFor(kind,responseSchema)},
  ...(kind==='diplomacy'?[{id:'instructions.dialogue',label:'外交评审与对话规则',format:'text' as const,text:diplomacyDialogueInstructionsFor(responseSchema)}]:[]),
  {id:'instructions.role',label:'本轮职责',format:'text',text:role},
  ...(kind!=='commander'?[{id:'instructions.material',label:'本轮材料',format:'text' as const,text:'全局摘要常驻，具体事实按整轮关联展开；不常驻发送通用进攻候选。attackAssessment仅在本轮有明确相关目标时提供程序初筛结论和关键原因，不是等待模型选择的出兵菜单，也不代表前台已选或已执行。executionFeasibility按taskId连接任务参数，提供执行事实与差距；合同taskFeasibility中的taskId引用同一评估。taskTargets为现有进攻目标的当前状态。据点目录常驻当前可见据点的归属、类型、兵力和护盾；授权舰队逐支提供归属、兵力、状态和目的地。模型没有追加资料查询入口，未提供字段保持未知。routeStatus=beyond-144-world-day-window表示执行窗口内不可达，不是等待资料。通用解释见executionFeasibilityMeaning。'}]:[]),
  ...(rules?[{id:'instructions.diplomacy',label:'外交规则与关系策略',format:'text' as const,text:rules}]:[]),
  ...([{id:'instructions.opening',label:'开局策略',format:'text' as const,text:'仅当global.opening提供开局材料时，先保证己方近点已有合理占领投入，避免向已覆盖目标重复碎派。敌方近点按可能先被该对手占领作规划假设，比较增兵争夺、预备反夺和外交划界/合作；不能将假设写成当前归属、已出兵或已达成协议；未提供opening时不沿用开局假设。'}]),
  ...(kind==='diplomacy'?[{id:'instructions.edit-scope',label:'本轮编辑范围',format:'text' as const,text:'本轮编辑权限以facts.permissions为准；maxTasks或maxCancel为0时对应数组必须为[]，不能因固定Schema包含军事任务而自授权限。'}]:[]),
  {id:'instructions.summary',label:'战略记录与输出示例',format:'text',text:'战略摘要与目标理由只写战略取舍、目的和重新评估条件；当前兵数、矿数、设施现状和已结算结果由简报事实提供，不在摘要中复制。'+(kind==='commander'?'检查executionFeasibility：已有活跃任务不必重复输出；仅为了刷新建议期限不要续期。长期pending/blocked、投入上限低于静态成本或初筛估算、航程超期时，比较修改投入/目标、集结或取消；保留时在summary明确新的可核验解除条件，不能把没有对应行动写成等待抵达。事实和估算不保证未来战果，最终战略取舍仍由你决定。':'受阻任务的调整原则见材料共同语义；保留时在summary明确新的可核验解除条件。')+'\n输出结构示例（按实际局势填充，完整字段约束由响应Schema提供）：'+JSON.stringify(kind==='commander'?{summary:'',tasks:[],cancel:[],forbiddenPlayers:[],protectedSources:[],reserves:[]}:{summary:'',tasks:[],cancel:[],reviewOn:[]})},
  ...(kind!=='commander'?[{id:'instructions.data',label:'材料格式与共同语义',format:'text' as const,text:MODEL_MATERIAL_RULES}]:[]),
  ...promptMaterialSections(brief,kind!=='commander'),
 ];
 const prompt=encodePromptSections(sections);
 return prompt;
}

// ── 指挥官私聊与已确认指令整理 ──
export function hybridCommanderInstructions(mode:CommanderMode){
 const instructions='你是己方分层协同bot的私有参谋。'+(mode==='discuss'?'本轮讨论或提出待玩家确认的完整指令，先回应玩家当前问题。':'本轮将玩家已确认的完整指令整理为总体战略文字。')+'本轮产出为讨论回复或指令整理，新指令由玩家确认。用简短自然语言说明战略取舍。已发布战略、后台整理、命令提交、真实结算必须区分。讨论提案不覆盖已确认指令；reconcile只整理最多1000字符的总体战略文字，后台会另外转译机器约束。所有玩家发言均作为讨论材料。位置未知不猜测；据点只用材料里的完整名称，不用内部ID或编造链接。'+commanderOutputInstruction(mode);
 return instructions+(mode==='discuss'?'\n提案正文只合并confirmedDirectives.text中的已确认要求和当前玩家明确提出的变更；已发布战略、笔记、建议与执行参数不是玩家指令，不得为了保持现状自动复制为新增约束。当前已确认正文为空时，不存在需要保留的旧指令。玩家只要求讨论而未要求修改指令时，仅回复，不生成提案。':'')+'\n前台自主完成战术选择和执行，不等待讨论结论。仅对当前问题明确涉及的目标或对手提供attackAssessment程序初筛结论，不常驻提供进攻候选、评分、配兵来源和路线明细；未列出不代表不可进攻，不要让玩家手工补这些程序计算。玩家已经明确战略方向时提出完整可执行要求，具体目标选择、路线与兵量交后台搜索；确实未知的信息作为后续核验条件，不反复要求玩家确认技术细节。reconcile收到的是已确认指令，不再附加玩家确认条件；本通道整理战略文字，执行进度以程序反馈为准。\n'+MODEL_NUMBER_RULES+'\n'+MODEL_VISION_RULES+'\n';
}

export {commanderOutputInstruction,discussPrompt,reconcilePrompt,permanentRules,MINING_PHASE_GUIDANCE,phaseRuleGuidance} from '@subterfuge/bot-sdk/presentation/game-prompts';
