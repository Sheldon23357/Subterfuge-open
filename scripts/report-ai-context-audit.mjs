import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
const out=resolve(process.argv[2]??'outputs/ai-context-audit-20261030');
const read=async file=>JSON.parse(await readFile(join(out,file),'utf8'));
const [a,capture,calls,semantic,verification]=await Promise.all(['analysis.json','capture.json','per-call.json','semantic-metrics.json','verification.json'].map(read));
assert.equal(verification.passed,true);
const esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const sum=xs=>xs.reduce((n,x)=>n+x,0),fmt=n=>n.toLocaleString('en-US'),pct=n=>(100*n).toFixed(2)+'%',body=a.totals.selectedBodyCharacters;
const roles={strategy:'战略',diplomacy:'外交'},names={global:'全局局势',guidance:'战略、约束与外交材料',facts:'授权事实'};
const roleTotals=Object.values(semantic.roles),total=k=>sum(roleTotals.map(r=>r[k]));
const lexical={},blanks={};for(const s of Object.values(a.sectionTotals)){for(const [k,v] of Object.entries(s.categories))lexical[k]=(lexical[k]??0)+v;for(const [k,v] of Object.entries(s.blanks))blanks[k]=(blanks[k]??0)+v;}
const longChars=sum(Object.values(a.sectionTotals).map(s=>s.longIdCharacters)),longCount=sum(Object.values(a.sectionTotals).map(s=>s.longIdOccurrences));
const scenarios={};for(const [key,s] of Object.entries(a.scenarios)){const name=key.slice(key.indexOf(':')+1),t=scenarios[name]??={calls:0,before:0,after:0,saving:0,positive:0,negative:0};for(const k of Object.keys(t))t[k]+=s[k];}
const indexTotals={};for(const c of calls)for(const i of c.indexTables){const t=indexTotals[i.path]??={calls:0,rows:0,characters:0,withColumnNamesCharacters:0,namedObjectCharacters:0};t.calls++;for(const k of ['rows','characters','withColumnNamesCharacters','namedObjectCharacters'])t[k]+=i[k]??0;}
const judgment={
 'global.time':['保留并统一单位','世界时间、收入周期及条件 ETA 的语义必要；避免 npPerDay / drillerRate 被读成每世界日。'],
 'global.match':['保留','胜利方式、门槛、终局状态是全局目标依据。'],
 'global.self':['保留','己方资源与容量；零和 false 有意义。'],
 'global.players':['保留并解释 null','公共实力与静态胜利时间；无收入时的 null 应给出无静态收入路径的状态含义。'],
 'global.ownOutposts':['可合并摘要','己方据点数；很短，非主要负担。'],
 'global.visiblePosts':['保留','授权覆盖范围，防止把未见当作不存在。'],
 'global.mining':['保留','采矿缺口和失矿代价已由程序计算。'],
 'global.criticalAssets':['保留并补事实','矿场和来袭必需；来袭记录没有实际剩余航程/抵达时间字段。'],
 'global.economy':['保留','建矿费用与资源地点、兵力、支付缺口；可用兵力的含义不能省。'],
 'global.ownFleets':['缩短引用并补时间','保留舰队数量、方向和返航能力；原始哈希改成程序可逆代号。'],
 'global.planning':['保留计算，移出校验元数据','保留候选、来源、可调兵估算、风险及建议期限；basisRevision 和重复 worldDay 留程序校验。'],
 'global.roster':['保留小映射表','区分 gamePlayer / chatPlayer；全量内联姓名实测更长。'],
 'global.identities':['补列名','必要的名称、归属和可见性目录；隐式三元组增加理解负担。'],
 'global.feedback':['按轮聚焦','保留实际反馈、条件方案和搜索覆盖；避免重复列出不参与本轮取舍的长候选细节。'],
 'global.commanderVersion':['移出战略正文','与调用依据中的版本重复；程序继续严格校验。'],
 'global.relations':['保留摘要，按对象展开','双向信任、竞争和边境压力有价值；评分无需长小数。'],
 'guidance.intentTasks':['按任务类型表达','当前任务必要；现有通用表漏了 transfer 的 source / drillers。'],
 'guidance.recentResults':['按相关性保留','失败原因和已完成目标影响决策；用紧凑终态摘要，不复制完整任务。'],
 'guidance.reusableTaskIds':['可与可编辑任务合并','仅 6 个引用，累计值长 384 字符；收益很小，身份权限必须保留。'],
 'guidance.intentCoverage':['保留','区分列出数量和总量，避免把未列出当作不存在。'],
 'guidance.fulfillment':['按当前会话保留','未完成或阻塞的外交落实及原因；不要把计划当已执行。'],
 'guidance.fixedConversation':['保留或合入会话头','当前会话和 game/chat 身份映射很短；不得混淆身份域。'],
 'guidance.diplomacyPurpose':['保留触发证据','具体需求、威胁与条件缺口服务本轮协商；区分预测和已发生事实。'],
 'guidance.conversation':['保留认知摘要','当前会话认知，未处理原文仍在其他消息模块。'],
 'guidance.strategic':['保留并标为判断','跨轮战略记录不是当前事实；只把相关目标/重评条件常驻。'],
 'guidance.executionRules':['保留','生效限制是执行边界，不能以短为由裁掉。'],
 'guidance.agreements':['保留并区分来源','内部外交约定与服务器正式合同性质不同，不能合并冒充已签合同。'],
 'guidance.commander':['保留生效正文','指挥官要求不可任意摘要或裁剪。'],
 'guidance.serverAgreements':['拆类型并压缩历史','23 列混合停战/联合进攻且终态合同占大多数；保留当前义务和相关终态结果。'],
 'guidance.editPolicy':['严格保留边界，裁剪无效选择器','51 次无军事编辑权仍带友方目标/返航 ID；这些选择器可按能力省略。'],
 'guidance.relationAdvice':['未知按组声明','外交中五名对手重复四个未知 null 及相同解释；保留下界和一次明确未知声明。'],
 'guidance.contractResults':['当前对象详情＋全局变化摘要','无当前对象直接关联的回执较多；不能据此删除跨会话预算/信任变化，也不能删底层审计。'],
 'guidance.readOnlyIntentTasks':['保留战略摘要','只读任务影响预算；无须复制可编辑身份，运输事实同样不能遗漏。'],
 'guidance.communicationFacts':['合并确定筛选并保留直接结果','己方/对方据点及停战并集是确定性筛选；让程序给结果，避免要求模型反复连接索引。'],
 'guidance.contractFeasibility':['保留预计算','剩余额度、静态门槛和合同敌人已关联，能减少模型自行查表计算。'],
 'guidance.fulfillmentFeasibility':['保留预计算','额度、兵力上限、初筛和期限比较有价值；必须保留条件含义。'],
 'guidance.fulfillmentInterpretation':['保留一次规则','明确静态最低兵力不等于模拟结果、额度不等于出兵上限。'],
 'facts.remainingInformationPasses':['保留','补查能力边界。'],
 'facts.requestableInformation':['条件合并目录','与据点名称目录有重合，也含任务 ID；不能一律按据点目录内联。'],
 'facts.requestedInformation':['按实体类型展开','补查结果保留必要字段；outpost / fleet / intent 不适用槽位可用明确类型替代。'],
 'facts.coverage':['保留','解释当前事实覆盖而非声称全图完整。'],
 'facts.outposts':['保留选定详情','授权驻军/护盾/设施是进攻与谈判依据；不依赖模型补出未知。'],
 'facts.fleets':['缩短引用并补时间','可见外军事实必要；源点 null 可能是未知，不能改为无来源。'],
 'facts.scheduled':['仅在相关时展开','已接受安排影响资源与落实判断；空表可用紧凑明确空集合。'],
 'facts.validationError':['仅异常时提供','正常轮为 null/空值时可省；错误发生时要明确说明。']
};
for(const key of Object.keys(a.fieldTotals)){const path=key.slice(key.indexOf('$.')+2);assert.ok(judgment[path],'Missing field judgment '+path);}
const sourceRefs=[
 ['brief.ts','plugins/hybrid/src/brief.ts',64,'全局材料、公共玩家表、舰队和目录'],
 ['brief.ts','plugins/hybrid/src/brief.ts',88,'任务通用表缺少 source / drillers'],
 ['brief-projection.ts','plugins/hybrid/src/brief-projection.ts',9,'仅筛选 basis，planning 的修订仍被保留'],
 ['brief-projection.ts','plugins/hybrid/src/brief-projection.ts',18,'正式合同全量投影与23列'],
 ['diplomacy-context.ts','plugins/hybrid/src/diplomacy-context.ts',29,'会话筛选、归属、合同及消息重复引用'],
 ['diplomacy-context.ts','plugins/hybrid/src/diplomacy-context.ts',61,'对手未知容量的重复展开'],
 ['model-wire.ts','plugins/hybrid/src/model-wire.ts',57,'按当前权限生成动作及精确引用枚举'],
 ['fleet-labels.ts','packages/ai/src/controller/presentation/fleet-labels.ts',1,'已有舰队代号与碰撞检查机制可复用']
];
const evidence={scope:a.capture,totals:a.totals,lexical,blanks,longIds:{occurrences:longCount,characters:longChars,bodyShare:longChars/body},indexTotals,scenarios,semantic:semantic.roles,verification:{passed:verification.passed,spans:verification.spans,sourceFiles:verification.sourceFiles,sections:verification.selectedSections},requirements:[
 {requirement:'三部分细节组成',evidence:['analysis.json:sectionTotals/fieldTotals','field-ledger.csv','report.html:inventory']},
 {requirement:'逐字符且可还原原文',evidence:['capture.json:sha256/sections','character-spans.jsonl.gz','verification.json']},
 {requirement:'空字段数量与占用',evidence:['analysis.json:sectionTotals.blanks/blankTotals','report.html:empty']},
 {requirement:'长ID数量与占用',evidence:['analysis.json:idTotals','report.html:ids']},
 {requirement:'索引内联取舍',evidence:['per-call.json:indexTables/scenarios','report.html:indexes']},
 {requirement:'任务无关和分心材料',evidence:['semantic-metrics.json','report.html:relevance','current sourceHashes in verification.json']},
 {requirement:'理解与二次计算',evidence:['semantic-metrics.json:taskRowsMissingTransferDetails/*WithEta','report.html:understanding','brief.ts and diplomacy-context.ts']},
 {requirement:'结论边界与可执行优先级',evidence:['report.html:priorities','report.html:limits']}
]};
await writeFile(join(out,'findings.json'),JSON.stringify(evidence,null,2));
const table=(headers,rows)=>'<div class="table-wrap"><table><thead><tr>'+headers.map(h=>'<th>'+esc(h)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(row=>'<tr>'+row.map(v=>'<td>'+v+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';
const number=n=>'<span class="num">'+fmt(n)+'</span>';
const code=s=>'<code>'+esc(s)+'</code>';
const sectionRows=Object.entries(a.sectionTotals).sort().map(([key,s])=>{const [role,name]=key.split(':');return[roles[role],names[name],number(s.calls),number(s.bodyChars),number(Math.round(s.bodyChars/s.calls)),number(s.longIdCharacters),number(s.blanks.null)];});
const topRows=role=>Object.entries(a.fieldTotals).filter(([k])=>k.startsWith(role+':')).sort((a,b)=>b[1].characters-a[1].characters).slice(0,12).map(([key,v])=>[code(key.slice(key.indexOf('$.')+2)),number(v.characters),pct(v.characters/semantic.roles[role].bodyChars)]);
const inventories=['global','guidance','facts'].map(name=>{
 const paths=[...new Set(Object.keys(a.fieldTotals).filter(k=>k.includes(':$.'+name+'.')).map(k=>k.slice(k.indexOf('$.')+2)))];
 const rows=paths.map(path=>{const totals=Object.entries(a.fieldTotals).filter(([k])=>k.endsWith(':$.'+path));const cost=role=>totals.find(([k])=>k.startsWith(role+':'))?.[1].characters??0;return[code(path),number(cost('strategy')),number(cost('diplomacy')),esc(judgment[path][0]),esc(judgment[path][1])];});
 return '<h3>'+names[name]+'</h3>'+table(['一级字段','战略累计字符','外交累计字符','处理建议','含义与判断'],rows);
}).join('');
const lexicalNames={propertyName:'字段名（含引号）',stringValue:'字符串值（含引号、转义）',number:'数值',boolean:'布尔值',null:'null 字面值',punctuation:'JSON 标点',whitespace:'JSON 外部空白'};
const idRows=Object.entries(a.idTotals).sort((a,b)=>b[1].characters-a[1].characters).slice(0,16).map(([k,v])=>[code(k),number(v.count),number(v.characters)]);
const scenarioLabels={shortIds:'短引用的乐观体积估算',removeEmptyObjectMembers:'机械移除空对象成员（不安全上界）',emptyTablesToLists:'空的严格表改为 []',factorAllNullColumns:'统一全 null 列移至 allNullColumns',inlineRosterNames:'删除 roster，全量内联姓名',inlineQueryableCatalog:'将补查据点选择器并入目录'};
const scenarioRows=Object.entries(scenarios).map(([k,s])=>[esc(scenarioLabels[k]),number(s.calls),s.saving>=0?number(s.saving):'增加 '+number(-s.saving),pct(s.saving/body),number(s.positive)+' / '+number(s.negative)]);
const blanksRows=[['null',blanks.null,blanks.null*4,'需要区分未知、未适用和不存在'],['空字符串',blanks.emptyString,blanks.emptyString*2,'只有明确无语义时可省'],['空数组',blanks.emptyArray,blanks.emptyArray*2,'空集合有时说明已检查且没有项目'],['空对象',blanks.emptyObject,blanks.emptyObject*2,'按 schema 语义决定是否省']].map(([label,n,size,meaning])=>[esc(label),number(n),number(size),pct(size/body),esc(meaning)]);
const samples=calls.map(c=>{const source=capture.samples.find(s=>s.key===c.key);return '<tr data-search="'+esc(c.key+' '+c.kind+' '+c.tick)+'"><td><a href="'+esc(source.file)+'">'+esc(c.key)+'</a></td><td>'+roles[c.kind]+'</td><td>'+c.tick+'</td><td class="num">'+fmt(c.bodyChars)+'</td>'+['global','guidance','facts'].map(n=>'<td class="num">'+fmt(c.sections[n].bodyChars)+'</td>').join('')+'<td class="num">'+fmt(sum(Object.values(c.sections).map(s=>s.longIds.characters)))+'</td><td><details><summary>字段组成</summary>'+['global','guidance','facts'].map(n=>'<h4>'+names[n]+'</h4>'+table(['原文一级字段','占用','原文位置 [start,end)'],c.sections[n].topFields.map(f=>[code(f.path),number(f.memberCharacters),code((f.start+source.sections.find(s=>s.id==='brief.'+n).bodyStart)+','+(f.end+source.sections.find(s=>s.id==='brief.'+n).bodyStart))]))+'<p>外层包装/括号：'+fmt(c.sections[n].wrapperCharacters)+' 字符；标记及分隔：'+fmt(c.sections[n].markerChars)+' 字符。</p>').join('')+'</details></td></tr>';}).join('');
const representative=Object.keys(roles).map(role=>{const list=calls.filter(c=>c.kind===role).sort((x,y)=>x.bodyChars-y.bodyChars);return list[Math.floor(list.length/2)];});
const medianRows=representative.map(c=>[roles[c.kind],'<a href="'+capture.samples.find(s=>s.key===c.key).file+'">'+esc(c.key)+'</a>',number(c.tick),number(c.bodyChars)]);
const sourceList=sourceRefs.map(([label,path,line,reason])=>'<li><a href="../../'+esc(path)+'">'+esc(label)+':'+line+'</a> — '+esc(reason)+'</li>').join('');
let html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI 调用上下文逐字符审计</title><style>
:root{color-scheme:light;--ink:#172536;--muted:#536274;--navy:#122c46;--line:#ccd5de;--paper:#fff;--bg:#f0f3f6}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.7 system-ui,"Microsoft YaHei",sans-serif}main{max-width:1400px;margin:auto;padding:36px 30px 80px}header{border-top:8px solid var(--navy);padding:28px;background:var(--paper)}h1{font-size:30px;margin:0 0 12px}h2{margin:0 0 16px;font-size:23px}h3{font-size:18px;margin-top:25px}h4{margin:10px 0}section{padding:28px;background:var(--paper);border:1px solid var(--line);margin-top:20px;scroll-margin-top:18px}p{margin:12px 0}a{color:#164e80;text-underline-offset:3px}nav{display:flex;flex-wrap:wrap;gap:10px 20px;margin-top:20px}.muted{color:var(--muted)}.lead{font-size:18px}.table-wrap{overflow:auto}table{border-collapse:collapse;width:100%;font-size:14px;margin:12px 0}th,td{padding:10px 12px;vertical-align:top;border:1px solid var(--line);text-align:left}th{background:#e9eef3}tbody tr:nth-child(even){background:#f8fafc}.num{font-variant-numeric:tabular-nums;white-space:nowrap}code,pre{font:12px/1.6 Consolas,monospace}code{overflow-wrap:anywhere}pre{white-space:pre-wrap;background:#eef2f6;padding:18px;border-left:4px solid #34536e}.note{border-left:4px solid #83642d;padding:8px 18px;background:#faf6ed}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-top:20px}.card{border:1px solid var(--line);padding:14px}.card strong{display:block;font-size:25px}details{min-width:210px}summary{cursor:pointer;color:#164e80}details[open]{min-width:560px}input{width:min(100%,560px);padding:12px;border:1px solid #8091a2;font:inherit}ul,ol{padding-left:24px}li{margin:8px 0}@media(max-width:700px){main{padding:14px}section,header{padding:18px}.cards{grid-template-columns:repeat(2,1fr)}h1{font-size:25px}}
</style><main><header><p class="muted">本地冻结样本 · 逐字符核算 · 仅分析</p><h1>AI 调用上下文组成审计</h1><p class="lead">最值得优化的是长 ID、反复展开的终态历史和未按本轮权限收紧的材料。空值本身占比小；不能把所有 null 当作可删垃圾。部分格式还遗漏了任务参数，优化应同时减少冗余和补齐确定事实。</p><p>采集时间：2026-10-30 11:36（香港）；${capture.samples.length} 次完整调用，战略 91、外交 68，6 个席位，Tick 159–292。同一对局中每席位最近 30 条记录共 180 条，21 条未纳入。未含指挥官调用，结论不覆盖其他对局阶段或模型质量变化。</p><div class="cards"><div class="card">三部分正文<strong>${fmt(body)}</strong>UTF-16 字符</div><div class="card">长 ID<strong>${pct(longChars/body)}</strong>${fmt(longCount)} 次出现</div><div class="card">null 字面值<strong>${pct(lexical.null/body)}</strong>${fmt(blanks.null)} 个</div><div class="card">独立账本校验<strong>477 / 477</strong>${fmt(verification.spans)} 个连续片段</div></div><nav>${[['scope','统计口径'],['composition','内容组成'],['empty','空字段'],['ids','长 ID'],['indexes','索引与内联'],['relevance','任务相关性'],['understanding','理解与计算'],['priorities','建议顺序'],['inventory','完整一级字段'],['samples','样本原文'],['limits','验证边界']].map(([id,label])=>'<a href="#'+id+'">'+label+'</a>').join('')}</nav></header>
<section id="scope"><h2>统计口径与可追溯性</h2><p>全部已保存提示词为 ${fmt(a.totals.fullPromptCharacters)} 字符；选定三部分连同标记为 ${fmt(a.totals.selectedCharacters)}；正文为 ${fmt(body)}；本次三部分标记和分隔共 ${fmt(a.totals.selectedCharacters-body)} 字符，占选定原文 ${pct((a.totals.selectedCharacters-body)/a.totals.selectedCharacters)}。其他模块未作为本次正文分母。</p><p>按 JavaScript 字符串的 UTF-16 索引计数，emoji 可能占两个或更多单位；不是字节数或 Token 数。供应商请求中的 responseSchema、系统包装等不计入此分母。源正文均为紧凑 JSON，没有额外缩进；字符串内部的文字、空格与转义属于正文。</p><p>每个提示词保存 SHA-256；每段使用生成端的成对标记定位。独立校验逐条核对源文件哈希、原文区间、JSON 原生解析、词元类型及连续覆盖。字段成员计数含字段名、冒号、值和分配给该成员的逗号；一级字段合计再加外层包装恰好等于正文。</p><p class="note">字段账本包含父字段和嵌套子字段，它们的范围会重叠，不能把所有行直接相加。只在同一层级相加；词元账本才是完全不重叠的字符划分。长 ID 和空值是词元的子集，不能再加到 JSON 类型合计上。</p><p><a href="verification.json">独立验证结果</a> · <a href="character-spans.jsonl.gz">每个词元的原文区间（gzip JSONL）</a> · <a href="field-ledger.csv">全部嵌套字段账本（CSV）</a> · <a href="capture.json">采集与 SHA-256 清单</a> · <a href="findings.json">机器可读结论及需求证据索引</a></p></section>
<section id="composition"><h2>三部分具体由什么占据</h2>${table(['调用职责','部分','调用数','累计正文字符','平均每次','长 ID 字符','null 数量'],sectionRows)}<p>外交的材料重心明显偏向 guidance；战略的重心则在 global。不能用一套固定裁剪比例处理两种职责。</p>${table(['互斥词元类别','字符数','占正文'],Object.entries(lexical).map(([k,v])=>[esc(lexicalNames[k]),number(v),pct(v/body)]))}<p>字段名和 JSON 标点并非天然浪费：它们帮助解释结构。把所有表改成逐行具名对象，在本样本中反而增加 ${fmt(total('allTablesToObjectsDelta'))} 字符（${pct(total('allTablesToObjectsDelta')/body)}）。应该修复缺列名和稀疏混型表，而非一律对象化。</p><h3>战略调用最大的一级字段</h3>${table(['字段','累计字符','占该职责三部分正文'],topRows('strategy'))}<h3>外交调用最大的一级字段</h3>${table(['字段','累计字符','占该职责三部分正文'],topRows('diplomacy'))}</section>
<section id="empty"><h2>空字段：多少、为什么空、哪些能省</h2>${table(['空值种类','出现次数','字面值字符','占正文','处理原则'],blanksRows)}<p>所有空字面值合计 ${fmt(blanks.lexemeCharacters)} 字符（${pct(blanks.lexemeCharacters/body)}）。其中 ${fmt(blanks.objectMembers)} 个空值是对象成员，连同键名和冒号占 ${fmt(blanks.objectMemberCharacters)} 字符（未含成员逗号）。机械移除这些成员的反事实净减 ${fmt(scenarios.removeEmptyObjectMembers.saving)} 字符，但会丢失未知、无项目和未适用的区别，不能照此实施。</p><p>正式合同表共有 ${fmt(total('contractRows'))} 行、${fmt(total('contractCells'))} 个单元格，其中 ${fmt(total('nullContractCells'))} 个为 null（${pct(total('nullContractCells')/total('contractCells'))}）。这是把停战和联合进攻塞进同一张 23 列表造成的结构稀疏，适合按合同类型分组。</p>${table(['实际位置','null 的含义','建议'],[
 ['合同的 enemy / quota / subsidy 等','条款类型未适用或没有补贴','按类型分组，补贴仅在存在时展开；不要让缺失等于未知'],
 ['对手容量 actual/remaining 四字段','未授权知道实际完整合同与剩余名额','每组声明未知，逐对手只列可见下界'],
 ['facts.fleets.source','授权观察不知道起点','保留 unknown 标记，不能变成无起点'],
 ['players.staticVictoryWorldDays','采矿模式下收入为零时无当前静态收入路径；非采矿模式也不适用','用适用状态/原因解释，不能读成零天'],
 ['任务的 kind 专用列','对其他任务类型不适用','按 kind 使用紧凑专用列'],
 ['requestedInformation.outpost/fleet/intent','本条补查对象的其他类型槽位不适用','提供 type + 对应详情，保留查无/未知状态'],
 ['validationError / 正常空清单','本轮没有错误或没有项目','按 schema 明确空集合含义，正常错误字段可省']
 ].map(row=>row.map(esc)))}<p>零、false、未知、不适用和没有项目应继续区分。空表改成明确空列表累计可减 ${fmt(scenarios.emptyTablesToLists.saving)} 字符；统一全 null 列并附 allNullColumns 的实验可减 ${fmt(scenarios.factorAllNullColumns.saving)}。这两项仍需统一 schema 解释，不能靠模型猜缺列的含义。</p></section>
<section id="ids"><h2>长 ID：体积大，但应替换身份表示而非删除身份</h2><p>长 ID 共出现 ${fmt(longCount)} 次，占 ${fmt(longChars)} 字符（${pct(longChars/body)}）。统计包括 pN-64位哈希、裸64位哈希、UUID及带前缀UUID；同一 ID 在不同字段和调用中重复出现也计数。这是实际传输体积，非独立实体数。</p><p>pN-哈希既可能是舰队，也可能是正式合同，不能仅凭前缀把它们都变成舰队代号。最大来源如下；路径已把表的列号解释为列名。</p>${table(['职责 / 语义路径','出现次数','字符'],idRows)}<p>在单次提示词内按实体域换为 F/A/M/I 短引用，并复用相同身份，乐观净减 ${fmt(scenarios.shortIds.saving)} 字符（${pct(scenarios.shortIds.saving/body)}）。这只是纯文本替换估算，未计别名解释、请求 Schema 和程序映射成本，不是可直接上线的净 Token 节省。</p><p>实施应复用已有舰队稳定代号与碰撞检查，正式合同、消息、任务使用独立命名空间；同步修改 Schema 枚举、输出归一化和精确反向解析。程序及审计保留原 ID，不截断原哈希，不通过模糊匹配绑定行动。调用修订哈希可以完全留在程序校验层。</p></section>
<section id="indexes"><h2>索引和选择器：可内联的收益与代价</h2><p>本次识别 5 类目录/引用清单：roster、identities、requestableInformation、reusableTaskIds 和 fixedConversation.identities。前两项是主要映射表；后三项还承担能力或范围边界，不全是待消除的索引。</p>${table(['结构','调用数 / 行或项','累计值字符','判断'],[
 [code('global.roster'),fmt(indexTotals['global.roster'].calls)+' / '+fmt(indexTotals['global.roster'].rows),number(indexTotals['global.roster'].characters),'保留。六人表每次121字符；内联所有已识别玩家引用反增49,074字符，且需继续区分游戏/聊天身份。'],
 [code('global.identities'),'159 / 9,540',number(indexTotals['global.identities'].characters),'保留名称、归属、可见性目录，补明确列名。'],
 [code('facts.requestableInformation'),'159 / 7,709',number(indexTotals['facts.requestableInformation'].characters),'仅全为据点名时可并入目录；包含任务ID时按类型拆开。'],
 [code('guidance.reusableTaskIds'),'159 / 6',number(indexTotals['guidance.reusableTaskIds'].characters),'可与可编辑任务身份合并，样本收益很小。'],
 [code('guidance.fixedConversation.identities'),'159 / 68',number(indexTotals['guidance.fixedConversation.identities'].characters),'可合入单个会话头；当前只有2,426字符，优先级低。']
 ])}<p>据点目录现在直接发送三元组，没有 columns。每次60行、926字符；补 <code>columns:["name","owner","visibility"]</code> 后为975字符，每次只增加49字符；改成60个具名对象则增加1,680字符。推荐前者。全样本补列名增加 ${fmt(indexTotals['global.identities'].withColumnNamesCharacters-indexTotals['global.identities'].characters)} 字符。</p><pre>${esc(JSON.stringify({columns:['name','owner','visibility'],rows:[['据点甲',0,2],['据点乙',1,1]]},null,2))}</pre><p>上例仅示意建议格式，名称不是样本原文。与请求目录合并的实验只适用于69次调用，净减7,424字符；其中3次反而更长。其余调用包含任务身份等其他类型，不能强行并入据点目录。已完整展开的 capture/configure/avoid/return 任务仍有228个补查引用，约2,680字符；运输任务当前参数不全，不能按“已展开”排除。</p><p>communicationFacts 的己方/对方据点和停战候选并集虽然能从 identities 确定筛出，但直接给结果有助于减少二次查表。应由程序只产出本轮所需的一个用途明确集合，而不是删掉筛选结果后让模型自己做连接。</p></section>
<section id="relevance"><h2>哪些信息低相关，哪些只是看起来重复</h2>${table(['证据','实测体积/数量','判断与边界'],[
 ['规划修订哈希、重复世界时间及 commanderVersion',fmt(total('sourceMetadataCharacters'))+' 字符，159次均出现','可从战略正文移至程序校验；planning.worldDay 与 time.worldDay 159次相同。当前投影只裁剪 basis，planning 中修订仍泄露；文档的删除修订描述与实际不完全一致。'],
 ['无军事编辑权的外交调用仍携带友方目标/返航列表','51 / 68次；33,028字符','本轮 tasks/cancel 没有可用军事编辑入口时，这两份选择器可不发；保留谈判所需的军事态势与进攻初筛。'],
 ['每次重复展开终态合同','777 / 902行；198,016行内字符','按类型保留当前合同详情，历史改为相关结果摘要。不能全删，违约/终止影响信任，且模型没有历史 recall。'],
 ['外交回执与当前对象无直接身份关联','625 / 816条；80,462行内字符','这是按合同ID/参与者/结果from-to判定的候选低相关集合，不证明全部无用。当前对象给详情，其他对象保留预算/信任/重大事件摘要。'],
 ['对手容量重复 unknown 展开','340条；四个null字段占36,040字符，相同说明重复占13,328字符','保留明确未知及可见下界，用一条组级说明避免五次重复。'],
 ['长小数','2,225个，39,666字符','主要是回执时间、竞争分数、utility等；评分展示可缩精度。不要盲目四舍五入行动期限、状态依据或精确坐标。']
 ].map(row=>row.map(esc)))}<p class="note">上述数字有重叠：终态合同行内包含长ID和null；无效选择器包含舰队ID；容量字段也计入空对象成员。它们不能相加当作可节约总量。对注意力或决策质量的影响属于基于结构的判断，本次没有做模型 A/B 质量实验。</p><p>应保留：授权覆盖、已生效约束、未处理来信与指挥官正文、当前义务、威胁/资源/候选、实际结果与未知边界。跨会话资料不能自动对外披露；分析裁剪不能删除原始日志、查账和新鲜度检查。</p></section>
<section id="understanding"><h2>格式是否能让模型直接理解，而非补逻辑或补事实</h2><p><strong>首先补缺失事实。</strong>样本中6条运输任务（战略4、外交2）的表格缺少 source / drillers；源码通用任务表根本没有这两列。模型看到 transfer 却不知道从哪里调多少兵，无法准确比较成本或修订任务。改成按 kind 的字段组，至少完整提供当前类型的必需参数。</p><p>标准舰队记录未给实际剩余航程/抵达世界时间：己方 ${fmt(total('ownFleetRows'))} 条、外军 ${fmt(total('foreignFleetRows'))} 条、关键来袭 ${fmt(total('criticalIncomingRows'))} 条中均没有 ETA 字段。这里是跨调用重复行，不是独立舰队数，也不代表整份提示词绝无任何时间估算。源点/终点无法替代当前剩余航程；有授权数据可算时由程序给出，无法确定则标 unknown。外交 pressure 中的 earliestDeficitWorldDays 是条件缺口时点，不能冒充真实舰队抵达时间。</p><p><strong>已有预计算值得保留。</strong>目前并非把所有数学推给模型：程序已经提供静态胜利世界日、失矿扣库存、合同剩余额度/剩余时间/欠额处罚、建矿兵力缺口、初筛可用兵估算、候选航程与建议绝对期限、兵力上限不足和赶不上期限等判定。这些直接降低了模型的加减、筛选和关联负担。</p>${table(['材料','建议的直接表达','必须保留的边界'],[
 ['时间与收入','字段名或表头写明 worldDays / per144WorldDays','静态胜利时间是假设收入和领土不变，不是胜利保证'],
 ['兵力预算','按来源给 availableAfterAcceptedSchedules / reserveEstimate / availableEstimate','扣已接受安排后的余额不等于安全可调兵量'],
 ['进攻候选','目标、程序估算所需新兵、可用兵、航程、建议截止时间与条件限制在同一行','有限初筛建议不等于模型必须选择，也不等于全局最优'],
 ['合同','当前敌人、双方剩余贡献、期限、允许动作及相关任务同组','承诺贡献不是出兵上限；计划不等于实际贡献'],
 ['来袭','来源可见性、目标、兵力和实际ETA/未知状态','不从列表消失推断抵达或毁灭；预测需另标条件'],
 ['混型任务','capture/configure/transfer/return 分组并各给必要参数','来源、兵力、归属、权限及标识要完整'],
 ['覆盖与空值','组级说明已观察、未知和未适用状态','不把未列出等同不存在，不把null变成0']
 ].map(row=>row.map(esc)))}<p>模型仍需比较目标价值、谈判取舍和风险，这属于战略职责。应从模型移走的是确定性查表、单位换算、门槛加减和缺失事实猜测。</p></section>
<section id="priorities"><h2>建议实施顺序与体积实验</h2><ol><li><strong>先补完整性：</strong>修复运输任务投影；据点三元组加列名；统一收入/时间单位。对来袭和关键舰队提供可计算的授权 ETA 或明确未知。</li><li><strong>再减无战略意义的载荷：</strong>移出修订/版本元数据；无军事编辑权时省略对应动作选择器；对手未知容量用组级声明。</li><li><strong>统一身份表示：</strong>引入有类型且可逆的短引用，联动 Schema、归一化、碰撞检查和程序审计；不只改提示词字符串。</li><li><strong>按整轮组织材料：</strong>三部分顶层仍然成立。global 常驻全局摘要和当前预计算；guidance 集中生效约束、当前会话/合同和相关只读背景；facts 展开选定实体及补查结果。当前对象详情加其他对象的重要变化摘要，避免复制全量终态表。</li><li><strong>最后做小幅结构压缩：</strong>合同和任务按类型表分组、紧凑空表、条件合并补查目录；保留字段明确性、授权覆盖、原始消息和底层查账。</li></ol>${table(['独立体积实验','适用调用数','正文净减少（负值为增加）','占全样本正文','缩短 / 变长次数'],scenarioRows)}<p>每个实验都从原始正文独立变换，不能相加。空成员机械删除、所有数值统一舍入、全部合同历史删除均不作为实施方案。短ID数字是理想上界；将来应以包含Schema的完整请求及真实Token用量复测。</p><p>若实施，验收需同时证明：三部分可逆追溯；必要任务参数完整；零/false/未知语义不变；别名与输出枚举一致且碰撞拒绝；同轮权限及发布校验保持；预计算继续来自授权观察。模型效果需使用固定案例单独对比，不能用字符减少代替质量结论。</p></section>
<section id="inventory"><h2>完整一级字段清单与判断</h2><p>这里列出样本实际出现的全部 ${Object.keys(judgment).length} 种一级字段。两个职责的累计字符独立计算；某职责不存在的字段为0。每段还存在少量根包装，不属于任何一级字段；逐调用可在后面的展开项核对。</p>${inventories}</section>
<section id="samples"><h2>原文样本与定位</h2><p>按三部分正文总长选择每种职责的中位样本，便于从真实内容阅读，而非只看平均数。</p>${table(['职责','中位样本原文','Tick','三部分正文'],medianRows)}<p><a href="per-call.json">完整逐调用结构统计</a> · <a href="analysis.json">汇总统计</a> · <a href="semantic-metrics.json">语义证据逐调用记录</a> · <a href="repeated-strings.json">长字符串重复位置</a></p><label for="search">筛选席位、调用编号、strategy/diplomacy 或 Tick</label><p><input id="search" placeholder="例如 ai-04 或 diplomacy"></p><div class="table-wrap"><table id="sample-table"><thead><tr><th>调用原文</th><th>职责</th><th>Tick</th><th>正文总数</th><th>全局</th><th>约束外交</th><th>事实</th><th>长ID字符</th><th>逐字段定位</th></tr></thead><tbody>${samples}</tbody></table></div></section>
<section id="limits"><h2>验证结果、源码依据与限制</h2><p>已独立验证159份源文件SHA-256、477个目标段、${fmt(verification.spans)}个无重叠原文片段和${fmt(verification.topLevelMembers)}个一级成员。总和分别精确匹配完整提示词、选定含标记原文及正文统计。JSON还原使用原生JSON.parse核对，不依赖自定义词法解析器给自己背书。</p><p>当前代码核查位置如下，文件SHA-256已记入 <a href="verification.json">verification.json</a>。冻结原文是样本内容的依据；当前源码用于解释生成方式，不能替代过去版本的来源证明。</p><ul>${sourceList}</ul><p>没有修改生产投影、模型Schema或对局数据；本次只增加分析工具和本地报告。没有评估 Token 分词、缓存命中、模型注意力分布、胜率或删减后的行为安全。角色相关性的判断结合实际字段、权限和代码职责，无法给出一个普遍准确的“无用信息比例”。已确定低价值字段和候选低相关集合分别标注，没有混成一个看似精确的结论。</p><p class="muted">生成于 ${esc(new Date().toISOString())}；工具：collect-ai-context-audit.mjs、ai-context-audit-core.mjs、analyze-ai-context-audit.mjs、analyze-ai-context-semantics.mjs、verify-ai-context-audit.mjs、report-ai-context-audit.mjs。</p></section></main><script>document.getElementById('search').addEventListener('input',function(){const q=this.value.trim().toLowerCase();for(const row of document.querySelectorAll('#sample-table > tbody > tr'))row.hidden=!row.dataset.search.toLowerCase().includes(q);});</script></html>`;
try{
 const deep=JSON.parse(await readFile(join(out,'relevance-analysis.json'),'utf8')),d=deep.totals.diplomacy.scenarios.focusedCombined,s=deep.totals.strategy.scenarios.focusedCombined;
 const block='<section id="relevance-deep"><h2>相关性深查：材料选择与重复展开</h2><p>同一冻结样本的进一步投影试验中，外交正文净减 '+fmt(d.saving)+' 字符（'+pct(d.saving/d.before)+'），先统一短ID后仍额外净减 '+fmt(d.normalizedSaving)+' 字符（占短ID基线 '+pct(d.normalizedSaving/d.normalizedBefore)+'）。战略正文净减 '+fmt(s.saving)+' 字符。这里包含有代价的历史与军事摘要，不是可直接删除的无用比例，也未经模型质量验证。</p><p>深查同时分析了通用候选如何带入据点、来源经济和舰队明细，以及终态合同为何仍呈现当前义务式数值；保留全部候选的成本、航程、来源、评分与分类，并保护当前目标增援和合法返航舰队明细。</p><p><a href="relevance-report.html">阅读完整相关性深查、组合试验与材料组织建议</a></p></section>';
 html=html.replace('</nav>','<a href="relevance-report.html">深入相关性分析</a></nav>').replace('<section id="scope">',block+'<section id="scope">');
 evidence.deeperRelevance={report:'relevance-report.html',data:'relevance-analysis.json',verification:'relevance-verification.json',diplomacyNetSaving:d.saving,strategyNetSaving:s.saving,interpretation:'Conditional input-view experiment, not a safe-deletion percentage or quality validation'};
 await writeFile(join(out,'findings.json'),JSON.stringify(evidence,null,2));
}catch(error){if(error.code!=='ENOENT')throw error;}
await writeFile(join(out,'report.html'),html);
console.log(JSON.stringify({report:join(out,'report.html'),characters:html.length,fieldKinds:Object.keys(judgment).length,requirements:evidence.requirements.length,longChars,blankLexemeChars:blanks.lexemeCharacters,body,scenarios}));

