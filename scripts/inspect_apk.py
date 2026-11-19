"""Extract an authorized APK and inventory its contents without executing it."""
import collections
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
apk = ROOT / 'research/packages/subterfuge-latest.apk'
out = ROOT / 'research/extracted'
analysis = ROOT / 'research/analysis'
analysis.mkdir(parents=True, exist_ok=True)
out.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(apk) as archive:
    entries = archive.infolist()
    for entry in entries:
        target = (out / entry.filename).resolve()
        if not target.is_relative_to(out.resolve()):
            raise ValueError(f'Unsafe archive path: {entry.filename}')
    bad = archive.testzip()
    if bad:
        raise ValueError(f'CRC mismatch: {bad}')
    archive.extractall(out)
inventory = {
    'sha256': hashlib.sha256(apk.read_bytes()).hexdigest(),
    'size': apk.stat().st_size,
    'files': [{'path': e.filename, 'size': e.file_size} for e in entries],
    'extensions': dict(collections.Counter(Path(e.filename).suffix for e in entries)),
}
(analysis / 'inventory.json').write_text(json.dumps(inventory, indent=2), encoding='utf-8')
print(json.dumps({k: v for k, v in inventory.items() if k != 'files'}, indent=2))
