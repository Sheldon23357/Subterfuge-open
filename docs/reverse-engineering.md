# 规则样本与静态提取

项目使用合法保留的 Android 客户端静态样本研究规则。来源、文件大小和 SHA-256 位于 `research/provenance.json`；固定参考为 APK 12075 内置 rules 4300。该样本不证明线上服务器、动态配置或其他发布版本一致。

## 本地目录

- `research/packages/`：原始 APK。
- `research/extracted/`：原样解包资源。
- `research/analysis/`：格式化 JavaScript、Manifest、DEX 清单与提取数据。
- `docs/rules/data/`：可提交的规范化规则数据、来源和生成清单。
- `packages/engine/src/*generated.ts`：受来源校验的规则提取产物。

原始包、解包内容和 bundle 不随 Git 分发。运行游戏不需要这些文件；重新提取和独立原版对照需要恢复完全相同的合法样本。

## 重建

在仓库根目录使用 Python 3.11+：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-research.txt
.\.venv\Scripts\python.exe scripts/inspect_apk.py
.\.venv\Scripts\python.exe scripts/analyze_client.py
.\.venv\Scripts\python.exe scripts/extract_rules.py
.\.venv\Scripts\python.exe scripts/build_rulebook.py
.\.venv\Scripts\python.exe scripts/build_rule_catalog.py
.\.venv\Scripts\python.exe scripts/validate_rulebook.py
```

脚本针对固定样本的资源结构，不能当作通用反编译器。静态分析不请求原版后台；规则提取按白名单和摘要校验，不执行完整原客户端。

## 证据含义

配置字面量、已检查执行分支、手工公式、文档来源和运行对照是不同证据。字段存在不自动代表玩法入口开放；原客户端对可信调用方的假设不取消本地身份与事务校验。

当前产品差异见[来源与本地约定](rules/05-versions-and-sources.md)，实际开放范围见[功能范围](development/feature-availability.md)。不得改写固定来源数据来掩盖本地调整，也不得把未核实组合写成原版服务端保证。
