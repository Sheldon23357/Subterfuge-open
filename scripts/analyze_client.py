"""Decode manifest, inventory DEX classes, and format bundled JS statically."""
import hashlib
import json
from pathlib import Path
from loguru import logger
logger.remove()
from androguard.core.apk import APK
from androguard.core.dex import DEX
from lxml import etree
import jsbeautifier

ROOT = Path(__file__).resolve().parents[1]
out = ROOT / 'research/analysis'
out.mkdir(parents=True, exist_ok=True)
apk = APK(str(ROOT / 'research/packages/subterfuge-latest.apk'))
metadata = {
    'package': apk.get_package(),
    'version_name': apk.get_androidversion_name(),
    'version_code': apk.get_androidversion_code(),
    'min_sdk': apk.get_min_sdk_version(),
    'target_sdk': apk.get_target_sdk_version(),
    'main_activity': apk.get_main_activity(),
    'permissions': apk.get_permissions(),
    'signature_schemes_present': {'v1': apk.is_signed_v1(), 'v2': apk.is_signed_v2(), 'v3': apk.is_signed_v3()},
    'certificate_sha256': [hashlib.sha256(c.dump()).hexdigest() for c in apk.get_certificates()],
    'note': 'Certificate fingerprints identify this sample; publisher authenticity has not been independently verified.',
}
(out / 'apk-metadata.json').write_text(json.dumps(metadata, indent=2), encoding='utf-8')
(out / 'AndroidManifest.xml').write_bytes(etree.tostring(apk.get_android_manifest_xml(), pretty_print=True, encoding='utf-8'))
classes = []
for data in apk.get_all_dex():
    dex = DEX(data)
    classes.extend({'name': c.get_name(), 'methods': [m.get_name() for m in c.get_methods()]} for c in dex.get_classes())
(out / 'dex-classes.json').write_text(json.dumps(classes, indent=2), encoding='utf-8')
print(json.dumps(metadata, indent=2), flush=True)
jsout = out / 'javascript'
jsout.mkdir(exist_ok=True)
for source in sorted((ROOT / 'research/extracted/assets/public/assets').glob('*.js')):
    (jsout / source.name).write_text(jsbeautifier.beautify(source.read_text(encoding='utf-8')), encoding='utf-8')
print(f'Inventoried {len(classes)} DEX classes; formatted JS bundles without executing them.')
