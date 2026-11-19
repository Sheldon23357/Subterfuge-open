"""Validate the checked-in catalog and derived examples, not the original game.

Standard library only. The schema checker supports exactly the keywords used by
catalog.schema.json; unsupported validation keywords fail instead of being ignored.
"""
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'docs/rules/data'


def read(name):
    return json.loads((DATA / name).read_text(encoding='utf-8'))


def check_schema(value, schema, path='$'):
    known = {'$schema','title','type','properties','required','additionalProperties','items','enum','const'}
    assert not set(schema) - known, (path, 'unsupported schema keywords', set(schema) - known)
    if 'const' in schema:
        assert value == schema['const'], (path, 'const')
    if 'enum' in schema:
        assert value in schema['enum'], (path, 'enum')
    if 'type' in schema:
        types = schema['type'] if isinstance(schema['type'], list) else [schema['type']]
        matches = {'object':isinstance(value,dict), 'array':isinstance(value,list),
                   'string':isinstance(value,str), 'boolean':type(value) is bool,
                   'integer':type(value) is int, 'number':type(value) in (int,float), 'null':value is None}
        assert any(matches[t] for t in types), (path, 'type', types)
    if isinstance(value, dict):
        assert set(schema.get('required', [])) <= set(value), (path, 'missing fields')
        props = schema.get('properties', {})
        if schema.get('additionalProperties') is False:
            assert set(value) <= set(props), (path, 'extra fields')
        for key, sub in props.items():
            if key in value:
                check_schema(value[key], sub, f'{path}.{key}')
    if isinstance(value, list) and 'items' in schema:
        for i, item in enumerate(value):
            check_schema(item, schema['items'], f'{path}[{i}]')


def evaluate(case):
    p = case['input']
    kind = case['kind']
    if kind == 'production':
        return min(max(0,6+4*p['F']+3*p['T']+2*p['U']-p['M']), max(0,p['capacity']-p['current']))
    if kind == 'factory_period':
        return math.floor(math.floor(480/(1+.5*p['tycoons']))/10)
    if kind == 'mine_cost':
        n = p['team_created'] + int(p['pending'])
        return 50 if n == 0 else 100*n
    if kind == 'mine_loss':
        return math.floor(p['np']*.8+.5)
    if kind == 'mine_period':
        return 144/p['outposts']
    if kind == 'gift':
        return p['gift_drillers'] - min(p['gift_drillers'],max(0,math.ceil(p['total_after']-p['capacity'])))
    if kind == 'engineer':
        return math.ceil(p['loss']*min(1,.25*(p['global_count']+p['local_count'])))
    if kind == 'thief':
        return min(p['enemy'],math.ceil(p['enemy']*.15))
    if kind == 'sentry':
        return math.ceil(p['enemy']*.05)
    if kind == 'king':
        return min(p['enemy'],p['own']//4)
    if kind == 'effective_ticks':
        return 1.5*min(p['tick'],72)+max(0,p['tick']-72)
    if kind == 'shield_period':
        return 288//p['max_charge']
    if kind == 'battle':
        # Plain combat only: no specialist abilities/repair, only specialist tiebreak.
        attack_after_shield = max(0,p['A']-p['S'])
        shield_left = max(0,p['S']-p['A'])
        a = max(0,attack_after_shield-p['D'])
        d = max(0,p['D']-attack_after_shield)
        power_delta = p['A']-p['D']-p['S']
        if power_delta:
            winner = 'attacker' if power_delta > 0 else 'defender'
        elif p['attacker_specs'] != p['defender_specs']:
            winner = 'attacker' if p['attacker_specs'] > p['defender_specs'] else 'defender'
        else:
            winner = 'defender' if p['outpost'] else 'draw'
        return dict(A=a,D=d,S=shield_left,winner=winner)
    raise AssertionError(f'Unknown acceptance case type: {kind}')


def main():
    for file in DATA.glob('*.json'):
        json.loads(file.read_text(encoding='utf-8'))
    catalog = read('catalog.json')
    check_schema(catalog, read('catalog.schema.json'))
    for key, filename in [('parameters','parameters.json'),('specialists','specialists.json'),
                          ('constants','constants.json'),('rules','rules.json'),('sources','sources.json'),
                          ('acceptance_cases','acceptance-cases.json')]:
        assert catalog[key] == read(filename), f'stale catalog: {key}'
        ids = [r['id'] for r in catalog[key]]
        assert len(ids) == len(set(ids)), f'duplicate IDs in {key}'
    source_ids = {s['id'] for s in catalog['sources']}
    rule_ids = {r['id'] for r in catalog['rules']}
    spec_ids = {s['id'] for s in catalog['specialists']}
    type_ids = [s['client_type_id'] for s in catalog['specialists']]
    assert len(type_ids) == len(set(type_ids))
    for key in ['parameters','specialists','constants','rules']:
        for record in catalog[key]:
            assert record['source_ids'] and set(record['source_ids']) <= source_ids, (key, record['id'])
    for spec in catalog['specialists']:
        assert spec['promotes_to'] is None or spec['promotes_to'] in spec_ids
        assert spec['hire_bundle_size'] >= 1 and spec['base_speed_multiplier'] >= 1
        assert 0 <= spec['combat_priority'] <= 8
        seen, current = set(), spec
        while current['promotes_to'] is not None:
            assert current['id'] not in seen, 'promotion cycle'
            seen.add(current['id'])
            current = next(s for s in catalog['specialists'] if s['id'] == current['promotes_to'])
    profile = read('profile-4300.json')
    flat = {f'{section}.{key}':value for section, values in profile.items() for key,value in values.items()}
    assert flat == {p['id']:p['value'] for p in catalog['parameters']}
    assert profile == read('profiles-history.json')['v4300']
    for case in catalog['acceptance_cases']:
        assert set(case['rule_ids']) <= rule_ids and case['rule_ids']
        assert evaluate(case) == case['expected'], (case['id'],evaluate(case),case['expected'])
    manifest = read('build-manifest.json')
    assert manifest['parameter_count'] == len(catalog['parameters']) == 73
    assert manifest['specialist_count'] == len(catalog['specialists']) == 29
    assert manifest['historical_profile_count'] == len(read('profiles-history.json')) == 29
    # Evidence line checks are optional so the committed rules stay portable.
    checked = 0
    for source in catalog['sources']:
        if source['kind'] == 'local_static':
            path = ROOT / source['path']
            if path.exists():
                line = path.read_text(encoding='utf-8').splitlines()[source['line']-1]
                assert source['locator'].splitlines()[0] in line, source['id']
                checked += 1
    print(f"PASS: catalog schema, unique IDs, cross-references, promotion graph, {len(flat)} parameters,")
    print(f"29 specialists, 29 profiles, {len(catalog['acceptance_cases'])} derived examples, {checked} local evidence anchors.")
    print('No original client/server execution or gameplay parity claim.')


if __name__ == '__main__':
    main()
