"""Build a versioned research specification from local data, without running game code.

Requires the previously extracted APK analysis and json5. Generated facts are a
documentation dataset, not a server implementation or a claim of live parity.
"""
import csv
import hashlib
import json
import re
from pathlib import Path

import json5

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'docs/rules'
DATA = OUT / 'data'
JS = ROOT / 'research/analysis/javascript/index-DgdyVR_2.js'


def write_json(name, value):
    (DATA / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def line_of(text, token):
    return text[:text.index(token)].count('\n') + 1


# Explicit units; identifiers retain the client's original spelling.
META = '''RulesVersion|version|规则版本号
DominationRequirementByPlayerCount|outpost_count_by_player_count|个人统治目标，数组下标为玩家数
InitialOutpostsPerPlayer|outpost|女王据点之外的初始据点数
BaseElectricalOutput|driller_capacity|基础供电
NeptuniumPercentLostWithMine|ratio|失矿损失比例
FundingElectricalOutputBonus|driller_capacity_per_funder|每位资助者供电加成
FundingDrillerProductionBonus|driller_per_cycle_per_funder|每位资助者工厂产量加成
NeptuniumLeadRequiredForFunding|kg|资助所需矿领先量
MinutesOfInactivityBeforeFirstWarning|minute|不活跃首次警告阈值
MinutesOfInactivityBetweenWarnings|minute|后续警告间隔
HoursOfInactivityBeforeAutoresign|hour|不活跃自动投降阈值
SecondsBetweenResignationAndSelfDestruct|second|投降到自毁配置延迟，具体触发待审计
GameStartingDelayInHours|hour|开局等待配置
GameStartingDelayInHoursAfterWorldRecreation|hour|重建地图后的等待配置
HoursBeforeFirstHire|effective_hour|首次招募等待，受开局有效时间影响
HoursBetweenHires|effective_hour|后续招募间隔
HoursAfterEliminationToDestroySpecialists|hour|淘汰到专家销毁配置延迟，触发待审计
MinutesToCancelAction|minute|可取消动作窗口
CostOfExtraHire|unknown|额外招募历史配置，不认定为可用机制
GameStartSpeedupTicks|tick|开局加速阈值
GameStartSpeedupFactor|multiplier|开局加速倍率，非所有系统统一加速
GiftDrillersRespectElectricalCap|boolean_int|赠兵受接收方供电上限限制
TeamDominationRequirementByPlayerCount|outpost_count_by_player_count|团队统治目标，索引语义仍需核对胜利分支
AdmiralGlobalSpeedBonus|ratio|海军上将全局速度加成
EngineerRepairBonus|ratio|工程师全局修复比例
EngineerRepairBonusIfPresent|ratio|工程师在场额外修复比例
DoubleAgentRange|world_unit|保留配置，不据此推断当前双面间谍范围技能
ForemanExtraDrillers|driller_per_cycle|每位覆盖工头的额外产量
GeneralPowerBonusForSpecialists|driller|每位将军的全局杀伤
GeneralCombatBonus|driller|保留配置，当前为零
InfiltratorDrainAmount|shield_charge|渗透者排盾配置哨兵值
InspectorShieldBonus|shield_charge|检查员护盾上限旧参数，当前为零
IntelligenceOfficerGlobalVisibilityBonus|ratio|情报官全局声呐加成
IntelligenceOfficerLocalVisibilityMultiplier|multiplier|情报官本地声呐倍率
DEPRECATED_V25_KingCombatBonus|ratio|旧国王战力参数，明确废弃
KingDestroyRatio|own_drillers_per_enemy_driller|国王每击毁一兵所需己方兵数
KingShieldPenalty|shield_charge_per_king|每位国王护盾上限惩罚
LieutenantCombatBonus|driller|中尉直接杀伤
MartyrRange|world_unit|殉道者爆炸半径
MartyrShieldThreshold|shield_charge|殉道者摧毁据点护盾阈值
MinisterOfEnergyDrillerProductionFactor|multiplier|旧版生产倍率，4300生产分支不使用
MinisterOfEnergyDrillerProductionPenalty|driller_per_cycle|名义生产惩罚；当前执行公式直接减能源部长数量
MinisterOfEnergyOutput|driller_capacity|能源部长供电加成
NavigatorChangeCourseDelayInSeconds|second|导航改向延迟配置
NavigatorCourseChangeCooldownInMinutes|minute|导航改向冷却
NavigatorSpeedPenalty|ratio|导航速度惩罚
PrincessLocalVisibilityMultiplier|multiplier|公主本地声呐倍率
QueenShieldBonus|shield_charge|女王本地护盾上限加成
SecurityChiefGlobalShieldBonus|shield_charge|安全主管全局护盾上限加成
SecurityChiefLocalShieldBonus|shield_charge|安全主管本地护盾上限加成
SentryDrillerRemovedPercentage|ratio|哨兵单发杀伤比例
SentryFirePeriodInMinutes|minute|哨兵射击间隔
ThiefTransferFactor|ratio|盗贼夺兵比例
TinkererBoostFactor|capacity_per_shield_charge|修补匠按护盾上限增加供电的系数
TinkererDischargePerHour|shield_charge_per_hour|修补匠耗盾速率
TycoonExtraDrillers|driller_per_cycle|大亨本地产量加成
TycoonProductionRateBonusFactor|ratio|大亨全局生产速率加成
WarHeroCombatBonus|driller|战争英雄直接杀伤
GeneratorElectricalOutput|driller_capacity|每座发电站供电
MinDistBetweenOutposts|world_unit|地图生成最小据点距离配置
MaxDistBetweenOutposts|world_unit|地图生成最大据点距离配置
VisibilityRange|world_unit|基础声呐半径
QueenInitialDrillers|driller|女王据点初始钻机
SecondaryOutpostInitialDrillers|driller|其余初始据点钻机
ShieldDisableDelayInMinutes|minute|关闭护盾等待
MinutesForFullShieldPower|minute|护盾恢复周期名义值，离散取整会改变实际时间
WeakShieldMaxCharge|shield_charge|弱护盾基础上限
StrongShieldMaxCharge|shield_charge|强护盾基础上限
CityShieldMaxCharge|shield_charge|城市护盾保留配置，普通模式用途未核实
MinutesBetweenDrillerProductions|minute|工厂基础生产周期
DrillersPerProduction|driller_per_cycle|工厂基础产量
BaseMineCreationCostInDrillers|driller|基础开矿费用；4300主公式含硬编码50与100
MineProductionCycleInMinutes|minute|历史采矿周期配置，4300实际按据点数计算'''

# Original Chinese summaries of mechanics; no art, flavor text or third-party code.
SPECIALISTS = {
 'Diplomat': ('外交官', '释放其据点声呐覆盖范围内、关押在据点中的己方专家。'),
 'Engineer': ('工程师', '胜方修复：全局每名25%，现场每名额外25%；合并比例最高100%，对结算记录的钻机损失向上取整。'),
 'ReveredElder': ('长老', '只有一方有可参战长老时，关闭后续双方专家参战标记；双方都有则不关闭。殉道者优先于长老。'),
 'Admiral': ('海军上将', '至少一名提供无专家潜艇50%全局加速，不按人数叠加；自身速度1.5倍。'),
 'Foreman': ('工头', '位于据点且生效时，覆盖该据点一半实际声呐范围内己方工厂，每周期每名加4。覆盖含边界。'),
 'Tycoon': ('大亨', '每名将全局生产速率系数增加0.5；本人所在工厂每周期额外3。周期按tick取整。'),
 'Pirate': ('海盗', '可指定敌方潜艇为目标，追击速度2倍，返航最近友方据点时4倍；普通据点航行不自动享受2倍。'),
 'Lieutenant': ('中尉', '参战直接摧毁最多5台敌方钻机，自身速度1.5倍。'),
 'Princess': ('公主', '所在据点声呐1.5倍；女王失去控制时最近的公主继位，距离相同的裁定待核实。'),
 'King': ('国王', '专家阶段结束己方每4兵摧毁1敌兵，向下取整；攻击加成不叠加。每名仍各减全局护盾上限20。'),
 'Infiltrator': ('渗透者', '攻据点清空护盾；潜艇战触发结束战斗并继续航行。'),
 'MinisterOfEnergy': ('能源部长', '每名增加300供电，同时每座工厂每周期少产1台钻机。'),
 'WarHero': ('战争英雄', '参战直接摧毁最多20台敌方钻机。'),
 'Sentry': ('哨兵', '据点内每120分钟尝试射击，范围为所在据点半声呐；伤害为目标钻机数5%向上取整，优先最大伤害目标。'),
 'IntelligenceOfficer': ('情报官', '增加全局声呐25%，并显示视野外据点类型；多个情报官的叠加顺序另列待确认。'),
 'Tinkerer': ('修补匠', '供电增加所在据点最大护盾的3倍，每小时消耗该据点3护盾。零盾/转移时序待确认。'),
 'Saboteur': ('破坏者', '潜艇战将对方潜艇改派至对方最近友方据点；一次招募获得2名。'),
 'Assassin': ('刺客', '杀死战场对方所属专家；一次招募获得2名。同优先级刺客可相互杀死。'),
 'Inspector': ('检查员', '到达友方据点及战后在场时补满护盾；当前不增加基础护盾上限。'),
 'DoubleAgent': ('双面间谍', '潜艇战双方钻机清零，交换双方潜艇和专家归属并结束战斗。'),
 'SecurityChief': ('安全主管', '每名全局护盾上限加10，本人据点再加10。'),
 'Queen': ('女王', '所在据点护盾上限加20；提供招募入口；额外获得的女王转为公主。'),
 'Thief': ('盗贼', '进攻据点或潜艇战夺取对方15%钻机，向上取整并限制到实际剩余兵力；防守据点不发动。'),
 'General': ('将军', '专家阶段后己方仍有未被俘且存活专家才触发全局每名10杀伤；自身速度1.5倍。'),
 'Smuggler': ('走私者', '目的地属于本人时速度3倍；不对敌方据点进攻提供3倍加速。'),
 'Navigator': ('导航员', '允许途中改向，冷却480分钟；冷却归属与首次使用边界列为待确认。'),
 'Martyr': ('殉道者', '战斗优先级1爆炸，摧毁半径1.5世界单位内潜艇及满足护盾阈值的据点，含友军；使用环面最短距离。'),
 'Helmsman': ('舵手', '自身速度2倍。'),
 'Hypnotist': ('催眠师', '将本人所在据点的俘虏转为己方专家。')
}


def main():
    DATA.mkdir(parents=True, exist_ok=True)
    text = JS.read_text(encoding='utf-8')
    versions = json.loads((ROOT / 'research/analysis/rules-versions.json').read_text())
    current = versions['v4300']
    meta = {p[0]: p[1:] for p in (row.split('|') for row in META.splitlines())}
    params = []
    for section, values in current.items():
        for key, value in values.items():
            unit, label = meta[key]  # fail on undocumented fields
            params.append({'id': f'{section}.{key}', 'section': section, 'key': key,
                           'label_zh': label, 'value': value, 'unit': unit,
                           'status': 'client_config', 'source_ids': ['client_config'],
                           'runtime_verified': False})
    write_json('parameters.json', params)
    write_json('profile-4300.json', current)
    write_json('profiles-history.json', versions)
    with (DATA / 'parameters.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.DictWriter(f, fieldnames=['id', 'label_zh', 'value', 'unit', 'status'])
        w.writeheader()
        for p in params:
            w.writerow({k: json.dumps(p[k], ensure_ascii=False) if isinstance(p[k], list) else p[k] for k in w.fieldnames})

    end = text.index('\n    Q0 = {')
    start = text.rindex('        v42: {', 0, end) + len('        v42: ')
    literal = text[start:end].rstrip().removesuffix(',').rstrip()
    literal = literal.rsplit('\n    }', 1)[0]  # outer iX closing brace
    literal = re.sub(r'`([^`]*)`', lambda m: json.dumps(m[1]), literal)
    literal = literal.replace('!0', 'true').replace('!1', 'false')
    raw = json5.loads(literal)
    assert set(raw) == set(SPECIALISTS)
    ids = {int(v['type']): k for k, v in raw.items()}
    specialists = []
    for key, r in raw.items():
        zh, summary = SPECIALISTS[key]
        specialists.append({'id': key, 'client_type_id': int(r['type']), 'name_en': r['name'],
            'name_zh': zh, 'category': r['category'], 'hire_bundle_size': int(r.get('amount', 1)),
            'base_speed_multiplier': float(r.get('speed', 1)),
            'combat_priority': int(r.get('combatPriority', 0)),
            'combat_participation_flags': {k: bool(r.get(v, False)) for k, v in
                [('invading', 'appliesWhenInvading'), ('defending', 'appliesWhenDefending'), ('transit', 'appliesInTransit')]},
            'promotes_to': ids.get(int(r.get('promotesTo', 0))), 'summary_zh': summary,
            'source_ids': ['client_specialists', 'official_specialists'],
            'status': 'client_metadata_and_reviewed_summary',
            'source_line': line_of(text, '        v42: {\n            Diplomat:')})
    write_json('specialists.json', specialists)
    diff = []
    for old, new in [('v41', 'v42'), ('v42', 'v4201'), ('v4201', 'v4300')]:
        changes = []
        for section in sorted(set(versions[old]) | set(versions[new])):
            for key in sorted(set(versions[old].get(section, {})) | set(versions[new].get(section, {}))):
                a, b = versions[old].get(section, {}).get(key), versions[new].get(section, {}).get(key)
                if a != b:
                    changes.append({'path': f'{section}.{key}', 'before': a, 'after': b})
        diff.append({'from': old, 'to': new, 'changes': changes, 'scope': 'configuration_only'})
    write_json('version-diff.json', diff)
    provenance = json.loads((ROOT / 'research/provenance.json').read_text())
    write_json('build-manifest.json', {'schema_version': '1.0.0', 'as_of': '2026-10-15',
        'profile': 'apk-12075-rules-4300', 'live_server_verified': False,
        'apk_sha256': provenance['sha256'], 'formatted_js_sha256': hashlib.sha256(JS.read_bytes()).hexdigest(),
        'parameter_count': len(params), 'specialist_count': len(specialists), 'historical_profile_count': len(versions)})
    lines = ['# 全量数值字典', '', '配置基线：APK 12075 / rules 4300。`client_config`只确认配置存在，不自动证明当前分支使用它。', '',
             '本表保留参考数据的秒、分钟、小时和有效小时；当前玩法和玩家世界日见 [基础机制](01-core-rules.md)。ratio=比例，multiplier=乘数，world_unit=抽象地图单位。', '',
             '|字段|中文含义|值|单位|', '|---|---|---|---|']
    for p in params:
        lines.append(f"|`{p['id']}`|{p['label_zh']}|`{json.dumps(p['value'])}`|{p['unit']}|")
    (OUT / '02-parameters.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    lines = ['# 专家完整目录', '', '中文名为本项目工作译名，以稳定英文ID为准。数值与标记来自固定样本元数据及 rules 4300 参考配置；当前玩法已移除专家系统，本表仅供原版研究；见 [功能范围](../development/feature-availability.md)。', '',
        '优先级0表示没有正优先级的常规战斗技能，不代表被动效果先于一切。参与标记不是被动效果开关。速度是条件性基础倍率，不能相乘叠加。category=promoted也不代表女王可通过晋升获得。', '',
        '|ID / 中文|类型ID|分类|招募包数量¹|速度倍率|战斗优先级|晋升为|', '|---|---:|---|---:|---:|---:|---|']
    for s in specialists:
        lines.append(f"|{s['id']} / {s['name_zh']}|{s['client_type_id']}|{s['category']}|{s['hire_bundle_size']}|{s['base_speed_multiplier']}|{s['combat_priority']}|{s['promotes_to'] or '—'}|")
    lines += ['', '¹晋升型及女王的数量字段只是元数据默认值，不表示可以直接招募。当前玩法不提供专家候选抽取。']
    for s in specialists:
        flags = '、'.join(k for k, v in s['combat_participation_flags'].items() if v) or '无主动参战标记'
        lines += ['', f"## {s['id']}（{s['name_zh']}）", '', s['summary_zh'], '', f'客户端参与标记：{flags}。']
    lines += ['', '来源：[官方专家手册](https://subterfuge-game.com/rulebook/Specialists.html)；本地客户端定位见 data/sources.json。未知组合交互见 06-open-questions.md。']
    (OUT / '03-specialists.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(f'Generated {len(params)} parameters, {len(specialists)} specialists, {len(versions)} profiles.')


if __name__ == '__main__':
    main()
