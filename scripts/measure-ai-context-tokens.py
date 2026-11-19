"""Offline token counts for replayed prompt text, not provider billing usage.

Install tiktoken outside project dependencies and pass its directory if needed.
Only tokenizer vocabulary assets may be downloaded; no prompt is sent anywhere.
"""
import argparse
import json
import os
from pathlib import Path
import sqlite3
import sys
import hashlib

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--report-dir", default="runtime/ai-context-refactor-current-20261022")
parser.add_argument("--tokenizer-dir", default="runtime/ai-context-tokenizer")
args = parser.parse_args()
sys.path.insert(0, str(Path(args.tokenizer_dir).resolve()))
os.environ.setdefault("TIKTOKEN_CACHE_DIR", str(Path("runtime/ai-context-tokenizer-cache").resolve()))
import tiktoken
import requests

# Public vocabulary downloads have a finite timeout. No prompt text is included.
cache = Path(os.environ["TIKTOKEN_CACHE_DIR"])
cache.mkdir(parents=True, exist_ok=True)
for name in ["o200k_base", "cl100k_base"]:
    url = f"https://openaipublic.blob.core.windows.net/encodings/{name}.tiktoken"
    target = cache / hashlib.sha1(url.encode()).hexdigest()
    if not target.exists():
        session = requests.Session()
        session.trust_env = False
        response = session.get(url, timeout=(5, 15))
        response.raise_for_status()
        # tiktoken additionally verifies the vocabulary's expected SHA-256.
        target.write_bytes(response.content)

directory = Path(args.report_dir).resolve()
report = json.loads((directory / "report.json").read_text(encoding="utf-8"))
current_tools = report.get("workloadMode") == "current-tool-results"
workload_key = "currentReadWorkloadOffline" if current_tools else "historicalReadWorkloadOffline"
encodings = {name: tiktoken.get_encoding(name) for name in ["o200k_base", "cl100k_base"]}
def counts(text):
    return {name: len(encoding.encode(text, disallowed_special=())) for name, encoding in encodings.items()}

connection = sqlite3.connect(Path(report["database"]).resolve().as_uri() + "?mode=ro", uri=True)
rows = []
try:
    for row in report["rows"]:
        ref = row["callRef"]
        call = json.loads(connection.execute("SELECT payload FROM diagnostic_calls WHERE call_ref=?", (ref,)).fetchone()[0])
        assert len(call["promptText"].encode("utf-16-le")) // 2 == row["old"]["characters"]
        rows.append({"callRef": ref, "step": row["step"], "screeningMatched": row["screeningMatched"],
                     "historicalProviderInputTokens": row["old"]["inputTokens"],
                     "historicalPromptOffline": counts(call["promptText"]),
                     "newPermanentOffline": counts((directory / f"new-base-{ref}.txt").read_text(encoding="utf-8")),
                     workload_key: counts((directory / f"new-workload-{ref}.txt").read_text(encoding="utf-8"))})
finally:
    connection.close()

valid = [row for row in rows if row["screeningMatched"]]
summary = {section: {name: {"min": min(row[section][name] for row in valid),
                           "max": max(row[section][name] for row in valid)} for name in encodings}
           for section in ["newPermanentOffline", workload_key]}
result = {"method": "Offline prompt-text tokenization with named public encodings; not measured gpt-6.1-sol usage or billing.",
          "limitations": ["Provider model tokenizer, wrappers and generation schema may differ.",
                          "Workload measures two current read tools, not all tool scenarios or new AI behavior." if current_tools else "Workload text still contains historical-format read receipts, not all new tool outputs.",
                          "Two screening-mismatched samples are excluded from summary ranges."],
          "summary": summary, "rows": rows}
(directory / "tokens.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
table = [f"| 调用 | 旧供应方输入实测 | 新常驻 o200k / cl100k | {'新版工具重算' if current_tools else '携带旧查询负载'} o200k / cl100k | 初筛匹配 |",
         "| --- | ---: | ---: | ---: | --- |"]
for row in rows:
    fmt = lambda section: " / ".join(f"{row[section][name]:,}" for name in encodings)
    table.append(f"| {row['callRef']} | {row['historicalProviderInputTokens']:,} | {fmt('newPermanentOffline')} | {fmt(workload_key)} | {'是' if row['screeningMatched'] else '否，排除完整比较'} |")
description = "查询负载来自存档原参数与授权观察上的新版只读工具重算。" if current_tools else "查询负载仍使用历史工具正文。"
(directory / "tokens.md").write_text("# AI06 提示词离线分词\n\n新版列只统计重建文本，用两种明确命名的分词器作参考；不是gpt-6.1-sol供应方实测、账单或新AI行为。" + description + "未调用模型。\n\n" + "\n".join(table) + "\n", encoding="utf-8")
print(json.dumps({"summary": summary, "representative": [row for row in rows if row["callRef"] in [9692, 9732, 9798]]}, ensure_ascii=False, indent=2))
