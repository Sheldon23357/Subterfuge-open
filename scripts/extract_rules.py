"""Parse data literals, never evaluate downloaded JavaScript."""
import copy
import json
import re
from pathlib import Path
import json5

root = Path(__file__).resolve().parents[1]
out = root / 'research/analysis'
source = (out / 'javascript/index-DgdyVR_2.js').read_text(encoding='utf-8')
start = source.index('eX = {') + len('eX = ')
end = source.index(',\n    il = {', start)
# This exact bundle declares er = 1. Normalize only numeric division by it.
assert 'const er = 1,' in source
literal = re.sub(r'(\d+(?:\.\d+)?) / er\b', r'\1', source[start:end])
rules = json5.loads(literal)
start = source.index('...Qte(eX.v42, [') + len('...Qte(eX.v42, ')
end = source.index('\n        ])', start) + len('\n        ]')
patches = json5.loads(source[start:end])
current = copy.deepcopy(rules['v42'])
for version, patch in patches:
    for section, values in patch.items():
        current[section].update(values)
    current['GameParams']['RulesVersion'] = version
    rules[f'v{version}'] = copy.deepcopy(current)
(out / 'rules-versions.json').write_text(json.dumps(rules, indent=2), encoding='utf-8')
(out / 'rules-current-4300.json').write_text(json.dumps(current, indent=2), encoding='utf-8')
print('Extracted rule versions:', ', '.join(rules))
print(json.dumps(current, indent=2))
