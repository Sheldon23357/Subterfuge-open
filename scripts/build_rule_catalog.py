"""Generate the traceable rule catalog and numerical acceptance examples."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'docs/rules/data'
JS_PATH = 'research/analysis/javascript/index-DgdyVR_2.js'


def dump(name, data):
    (DATA / name).write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def read(name):
    return json.loads((DATA / name).read_text(encoding='utf-8'))


# Text is an independent mechanism summary. Formula fields are pseudocode, never eval'd.
RULES = '''WORLD-001|world_init|初始据点为额外据点参数加女王据点；初始钻机总数160。|initial_total = 4 + 1; initial_drillers = 4*40
WORLD-002|global_constants|地图生成目标据点数为玩家数乘10。|outpost_count = player_count * 10
WORLD-003|geometry|使用环面最短距离，跨地图边界相邻。|dx=min(abs(x1-x2),width-abs(x1-x2)); dy=min(abs(y1-y2),height-abs(y1-y2))
TIME-001|global_constants|标准tick为600秒，144tick为逻辑日。|seconds_per_tick=600; ticks_per_day=144
TIME-002|start_speed|前72tick适用1.5开局倍率；招募使用有效tick。|effective_ticks=1.5*min(t,72)+max(0,t-72)
TIME-003|event_order|移动事件先按步内时间，再按潜艇索引升序。|sort_key=(timeFraction,subIndex)
TIME-004|tick_pipeline|据点更新后提交专家，再移动/战斗，再周期能力、护盾裁剪及清理。|p3e -> y3e -> h3e -> S3e -> w3e -> C3e -> cleanup
ECON-001|production_amount|工厂产量受覆盖工头、本地大亨、资助、能源部长和供电剩余量影响。|min(max(0,6+4*F+3*T_local+2*funders-ministers),max(0,capacity-drillers))
ECON-002|production_period|大亨加快生产，按分钟和tick两次向下截断。|floor(floor(480/(1+0.5*tycoons))/10)
ECON-003|factory_tick|达到供电容量时不推进工厂生产进度；开局生产进度乘加速系数。|progress += speedup_if_can_produce
ECON-004|foreman_range|有效工头按所在据点一半实际声呐覆盖己方工厂，含边界，可叠加。|distance <= foreman_outpost_sonar * 0.5
SHIELD-001|shield_max|安全主管和女王加盾，国王每名减20，最低0。|max(0,base+10*global_chiefs+10*local_chiefs+20*local_queens-20*kings)
SHIELD-002|shield_tick|护盾离散恢复，非恒定48小时线性充满。|ticks_per_charge=floor(288/current_max_charge)
SHIELD-003|shield_tick|关盾延迟到期时盾值清零并关闭。|disable_delay_minutes=10
MINE-001|mine_cost|开矿费用使用团队历史建矿计数和正在开矿标记。|n=team_created+(team_pending?1:0); cost=(n==0?50:100*n)
MINE-002|mine_period|每矿按本人有效据点数计算生产1kg所需tick，保留小数。|ticks_per_kg=144/owned_factory_generator_mine_count
MINE-003|mine_tick|每tick采矿进度加1，达到阈值减去周期并生产1kg；不套用开局加速。|progress+=1; if progress>=period: progress-=period; np+=1
MINE-004|mine_capture|战败丢矿后剩余矿按0.8倍四舍五入，攻占者不直接获得矿。|remaining=floor(old_np*0.8+0.5)
MINE-005|mine_capture|4300占领分支不显式重置采矿计时，该重置仅在v18条件内。|preserve_mining_progress_in_reviewed_capture_branch
MINE-006|mine_convert|完成建矿清零生产和采矿进度并增加本人历史建矿次数。|mine_creation_count+=1; factory_progress=0; mining_progress=0
MOVE-001|speed_selection|有效专家航速取最大条件倍率，不进行多专家连乘。|speed=base_speed*max(eligible_specialist_multipliers)
MOVE-002|sub_constants|潜艇基础速度约0.005世界单位/分钟，赠送延迟10分钟。|base_speed=0.004999999888; gift_delay_minutes=10
MOVE-003|gift_cap|转交后超出接收方容量的部分从赠艇扣除，最多扣完赠艇钻机。|removed=min(gift_drillers,max(0,ceil(total_after_transfer-capacity)))
MOVE-004|arrival|敌方攻击据点时召回尚待发射的艇；普通空无人据点直接接管。|recall_waiting_subs_before_hostile_outpost_combat
HIRE-001|hiring|有效tick达到24首次增加机会，此后每108tick增加一次；未使用机会还须减去已消费次数。|total_unlocked=1+floor((effective_ticks-24)/108) when effective_ticks>=24 else 0
COMBAT-001|combat_entry|俘虏不可主动参战；按入侵、守点、潜艇战标记筛选。|participates = not_captive and scenario_flag
COMBAT-002|combat_entry|正优先级从小到大执行，相同级先收集双方再依缓存顺序调用。|priority_order=[1,2,3,4,5,6,7,8]
COMBAT-003|combat_power|据点战力由剩余钻机和护盾组成，艇战无盾。|attacker_power=A; defender_power=D+S
COMBAT-004|combat_entry|战力平局比较存活非俘虏专家数量，仍相同则守点胜或海上平局。|tie -> compare_owned_alive_specialists -> outpost_defender_or_sub_draw
COMBAT-005|combat_entry|国王全局攻击加成不按国王数叠加，按专家阶段后兵数快照计算。|king_damage=min(enemy_remaining,floor(snapshot_own_drillers/4))
COMBAT-006|combat_entry|将军每名10杀伤，要求己方战场存在存活未被俘专家；技能提前结束战斗时不追加。|general_damage=min(enemy_remaining,10*generals)
COMBAT-007|specialist_effects|盗贼夺取对方剩余兵力15%向上取整，守点不发动。|transfer=min(enemy_remaining,ceil(enemy_remaining*0.15))
COMBAT-008|engineer_repair|胜方工程师修复比例为全局和现场贡献之和，封顶100%，对记录损失向上取整。|repair=ceil(recorded_loss*min(1,0.25*global_engineers+0.25*local_engineers))
COMBAT-009|martyr_distance|殉道者爆炸半径使用1.5世界单位与环面距离，不用声呐20%的近似替代。|wrapped_distance_squared<=1.5*1.5
COMBAT-010|sentry_tick|哨兵按120分钟计时，每发摧毁5%钻机向上取整，无有效目标不重置计时。|damage=ceil(target_drillers*0.05)
COMBAT-011|arrival|据点战后由到达调用者执行检查员补盾及催眠师转化，不能漏掉调用者效果。|combat -> unload -> inspector -> hypnotist
FORECAST-001|forecast|未来推演克隆当前状态并移除不可见对象，不等于预知敌方未来命令。|forecast_input=visible_projection(current_state)
WIN-001|official_rulebook|默认采矿200kg获胜；统治模式按据点目标；仅剩一人也结束。|default_np_goal=200
VIS-001|official_rulebook|据点位置公开，详情依声呐；己方和来袭单位有可见例外；矿场身份全局公开。|see official visibility rules
FUND-001|official_rulebook|矿领先至少20kg可资助，每位提供50容量和每工厂每周期2钻机。|lead>=20
LOSE-001|official_rulebook|无女王且无继承、投降、不活跃达到48小时导致淘汰；现代清理时序仍待核实。|inactive_hours>=48'''


def main():
    text = (ROOT / JS_PATH).read_text(encoding='utf-8')
    sources = []
    tokens = {
        'client_config': ('client configuration versions and patches', '    il = {'),
        'client_specialists': ('v42 specialist metadata with 4201/4300 inheritance', '        v42: {\n            Diplomat:'),
        'global_constants': ('K global constants', '    K = (() => {'),
        'world_init': ('V2e initial world ownership', 'function V2e('),
        'geometry': ('V.getMinDistSquared', 'static getMinDistSquared('),
        'start_speed': ('V.getEffectiveTickCount', 'static getEffectiveTickCount('),
        'event_order': ('h3e event list and YD comparator', 'function h3e('),
        'tick_pipeline': ('V.updateTick', 'p3e(e), y3e(e)'),
        'production_amount': ('V.calculateDrillersForNextProductionAtOutpost', 'static calculateDrillersForNextProductionAtOutpost('),
        'production_period': ('V.calculateTicksBetweenDrillerProductions', 'static calculateTicksBetweenDrillerProductions('),
        'factory_tick': ('m3e factory tick', 'function m3e('),
        'foreman_range': ('n3e coverage', 'function n3e('),
        'shield_max': ('kH shield cap', 'function kH('),
        'shield_tick': ('A3e shield tick', 'function A3e('),
        'mine_cost': ('ut.getMineCreationCostForPlayer', 'static getMineCreationCostForPlayer('),
        'mine_period': ('V.calculateTicksBetweenNpProductions', 'static calculateTicksBetweenNpProductions('),
        'mine_tick': ('g3e mine tick', 'function g3e('),
        'mine_capture': ('oX mine capture branch', 'qn.getType(k, n.world.secondsSinceLastTick) == pe.Mine &&'),
        'mine_convert': ('V.convertToMine', 'static convertToMine('),
        'speed_selection': ('V.getBestSpeedWithSpecialists', 'static getBestSpeedWithSpecialists('),
        'sub_constants': ('g0 constants; Aee=1, er=1', 'const g0 = {'),
        'gift_cap': ('V.capGiftDrillersToElectricalOutput', 'static capGiftDrillersToElectricalOutput('),
        'arrival': ('V.handleSubArrival', 'static handleSubArrival('),
        'hiring': ('ut.updateTick hiring clock', 'e.tickCount % K.TicksPerDay, e.tickCount++'),
        'combat_entry': ('oX combat including lX participation', 'function oX('),
        'combat_power': ('dX combat power', 'function dX('),
        'specialist_effects': ('r2e specialist effects', 'function r2e('),
        'engineer_repair': ('oX winning side repair', 'U = $e.EngineerRepairBonus * L,'),
        'martyr_distance': ('hX blast range', 'function hX('),
        'sentry_tick': ('EMe sentry tick', 'function EMe('),
        'forecast': ('future visibility removal', 'removeAllNonVisibleItems('),
    }
    for sid, (title, token) in tokens.items():
        pos = text.index(token)
        sources.append({'id': sid, 'kind': 'local_static', 'title': title,
            'path': JS_PATH, 'line': text[:pos].count('\n') + 1, 'locator': token,
            'access_status': 'read_local', 'as_of': '2026-10-15'})
    for sid, title, url, status in [
        ('official_rulebook', 'Official Rule Book', 'https://subterfuge-game.com/rulebook/index.html', 'read_previous_turn'),
        ('official_specialists', 'Official Specialist Reference', 'https://subterfuge-game.com/rulebook/Specialists.html', 'indexed_previous_turn_direct_retry_failed'),
        ('official_videos', 'Tutorial Videos', 'https://subterfuge-game.com/rulebook/Videos.html', 'landing_page_only'),
        ('wiki_rules', 'Community Rules', 'https://subterfuge.fandom.com/wiki/Rules', 'search_index'),
        ('wiki_combat', 'Community Combat Resolution', 'https://subterfuge.fandom.com/wiki/Combat_Resolution', 'search_index_direct_failed'),
        ('wiki_puzzles', 'Community Puzzle Directory', 'https://subterfuge.fandom.com/wiki/Puzzles', 'directory_read'),
        ('wiki_strategy', 'Community Strategy', 'https://subterfuge.fandom.com/wiki/Strategy', 'index_only'),
        ('update_post', 'v42.1 announcement discussion', 'https://www.reddit.com/r/Subterfuge/comments/1wjzowl/balance_and_gameplay_changes_rules_v42_is_live/', 'read_previous_turn'),
        ('update_official', 'Linked v42.1 changelog', 'https://www.secretplan.com/subterfuge-news/rules-v42-1.html', 'unavailable'),
        ('tier_discussion', 'v42.1 player tier discussion', 'https://www.reddit.com/r/Subterfuge/comments/1x007d0/spec_tier_list_v421/', 'read_opinion_only'),
    ]:
        sources.append({'id': sid, 'kind': 'web', 'title': title, 'url': url,
                        'access_status': status, 'as_of': '2026-10-15'})
    dump('sources.json', sources)
    rules = []
    for row in RULES.splitlines():
        rid, source, summary, formula = row.split('|')
        rules.append({'id': rid, 'summary_zh': summary, 'formula': formula,
            'status': 'official_documented' if source.startswith('official_') else 'client_static',
            'profile': 'unversioned_official' if source.startswith('official_') else 'apk-12075-rules-4300',
            'source_ids': [source], 'runtime_verified': False})
    dump('rules.json', rules)
    constants = []
    for key, value, unit, source in [
        ('seconds_per_tick', 600, 'second', 'global_constants'),
        ('ticks_per_day', 144, 'tick', 'global_constants'),
        ('outposts_per_player_map', 10, 'outpost', 'global_constants'),
        ('max_players', 10, 'player', 'global_constants'),
        ('max_subs_per_player', 128, 'sub', 'global_constants'),
        ('max_specialists_per_player', 48, 'specialist', 'global_constants'),
        ('max_specialists_per_sub', 3, 'specialist', 'global_constants'),
        ('max_specialists_per_location', 128, 'specialist', 'global_constants'),
        ('default_neptunium_goal', 200, 'kg', 'global_constants'),
        ('base_sub_speed', 0.004999999888, 'world_unit_per_minute', 'sub_constants'),
        ('gift_delay', 10, 'minute', 'sub_constants'),
        ('sub_destruction_delay', 10, 'minute', 'sub_constants'),
        ('default_foreman_range_factor', 0.5, 'ratio', 'foreman_range'),
    ]:
        constants.append({'id': key, 'value': value, 'unit': unit, 'status': 'client_static', 'source_ids': [source]})
    dump('constants.json', constants)
    cases = []

    def case(cid, kind, inputs, expected, refs):
        cases.append({'id': cid, 'kind': kind, 'input': inputs, 'expected': expected, 'rule_ids': refs,
                      'evidence': 'derived_spec_example_not_runtime_test'})

    case('C01', 'production', dict(F=0,T=0,U=0,M=0,capacity=150,current=148), 2, ['ECON-001'])
    case('C02', 'production', dict(F=2,T=1,U=1,M=1,capacity=300,current=100), 18, ['ECON-001'])
    case('C03', 'production', dict(F=0,T=0,U=0,M=0,capacity=150,current=160), 0, ['ECON-001'])
    case('C04', 'factory_period', {'tycoons': 1}, 32, ['ECON-002'])
    case('C05', 'mine_cost', {'team_created': 0,'pending': False}, 50, ['MINE-001'])
    case('C06', 'mine_cost', {'team_created': 2,'pending': True}, 300, ['MINE-001'])
    case('C07', 'mine_loss', {'np': 7}, 6, ['MINE-004'])
    case('C08', 'mine_period', {'outposts': 7}, 144/7, ['MINE-002'])
    case('C09', 'gift', {'gift_drillers': 50,'total_after': 180,'capacity': 150}, 20, ['MOVE-003'])
    case('C10', 'gift', {'gift_drillers': 20,'total_after': 190,'capacity': 150}, 0, ['MOVE-003'])
    case('C11', 'engineer', {'loss': 7,'global_count': 1,'local_count': 1}, 4, ['COMBAT-008'])
    case('C12', 'engineer', {'loss': 7,'global_count': 4,'local_count': 2}, 7, ['COMBAT-008'])
    case('C13', 'thief', {'enemy': 7}, 2, ['COMBAT-007'])
    case('C14', 'sentry', {'enemy': 1}, 1, ['COMBAT-010'])
    case('C15', 'king', {'own': 15,'enemy': 9}, 3, ['COMBAT-005'])
    case('C16', 'effective_ticks', {'tick': 16}, 24, ['TIME-002'])
    case('C17', 'effective_ticks', {'tick': 73}, 109, ['TIME-002'])
    case('C18', 'shield_period', {'max_charge': 10}, 28, ['SHIELD-002'])
    case('C19', 'battle', {'A':27,'D':11,'S':8,'attacker_specs':0,'defender_specs':0,'outpost':True},
         {'A':8,'D':0,'S':0,'winner':'attacker'}, ['COMBAT-003','COMBAT-004'])
    case('C20', 'battle', {'A':5,'D':0,'S':8,'attacker_specs':0,'defender_specs':0,'outpost':True},
         {'A':0,'D':0,'S':3,'winner':'defender'}, ['COMBAT-003','COMBAT-004'])
    case('C21', 'battle', {'A':10,'D':10,'S':0,'attacker_specs':1,'defender_specs':0,'outpost':True},
         {'A':0,'D':0,'S':0,'winner':'attacker'}, ['COMBAT-003','COMBAT-004'])
    case('C22', 'battle', {'A':10,'D':10,'S':0,'attacker_specs':0,'defender_specs':0,'outpost':False},
         {'A':0,'D':0,'S':0,'winner':'draw'}, ['COMBAT-003','COMBAT-004'])
    dump('acceptance-cases.json', cases)
    manifest = read('build-manifest.json')
    catalog = {'schema_version': '1.0.0', 'profile': manifest['profile'], 'as_of': manifest['as_of'],
               'parameters': read('parameters.json'), 'specialists': read('specialists.json'),
               'constants': constants, 'rules': rules, 'sources': sources, 'acceptance_cases': cases}
    dump('catalog.json', catalog)
    # Restrict stable fields and types. Cross references are checked by validate_rulebook.py.
    def obj(properties):
        return {'type':'object','properties':properties,'required':list(properties),'additionalProperties':False}
    string = {'type':'string'}
    number = {'type':'number'}
    integer = {'type':'integer'}
    boolean = {'type':'boolean'}
    strings = {'type':'array','items':string}
    param = obj(dict(id=string,section=string,key=string,label_zh=string,value={},unit=string,
                     status={'enum':['client_config']},source_ids=strings,runtime_verified=boolean))
    spec = obj(dict(id=string,client_type_id=integer,name_en=string,name_zh=string,category=string,
        hire_bundle_size=integer,base_speed_multiplier=number,combat_priority=integer,
        combat_participation_flags=obj(dict(invading=boolean,defending=boolean,transit=boolean)),
        promotes_to={'type':['string','null']},summary_zh=string,source_ids=strings,status=string,source_line=integer))
    rule = obj(dict(id=string,summary_zh=string,formula=string,status={'enum':['client_static','official_documented']},
        profile=string,source_ids=strings,runtime_verified=boolean))
    constant = obj(dict(id=string,value=number,unit=string,status=string,source_ids=strings))
    example = obj(dict(id=string,kind=string,input={'type':'object'},expected={},rule_ids=strings,evidence=string))
    source = {'type':'object','required':['id','kind','title','access_status','as_of'],
              'properties':{k:string for k in ['id','kind','title','path','url','locator','access_status','as_of']}}
    source['properties']['line'] = integer
    source['additionalProperties'] = False
    schema = obj({'schema_version':{'const':'1.0.0'},'profile':string,'as_of':string,
        **{k:{'type':'array','items':v} for k,v in dict(parameters=param,specialists=spec,constants=constant,
            rules=rule,sources=source,acceptance_cases=example).items()}})
    schema['$schema'] = 'https://json-schema.org/draft/2020-12/schema'
    schema['title'] = 'Subterfuge normalized research catalog'
    dump('catalog.schema.json', schema)
    print(f'Generated {len(rules)} rules, {len(sources)} sources, {len(constants)} constants, {len(cases)} cases.')


if __name__ == '__main__':
    main()
