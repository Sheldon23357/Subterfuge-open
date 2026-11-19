# 规则库

## 当前玩法与参考数据

当前产品按[功能范围](../development/feature-availability.md)运行：个人采矿/统治、普通据点与兵力舰队、世界日显示及明确的本地边界。规则引擎与协议实际校验是运行权威。

当前玩法参数为 `data/profile-diplomacy-core-v1.json`，运行入口为 `packages/rules/src/index.ts`。专家系统已移除，资产耗尽淘汰规则见[功能范围](../development/feature-availability.md)。

新局活跃规则固定为 `realtime-3h`，使用 `RealtimeHoursOfInactivityBeforeAutoresign`；未带该标识的既有对局仍按其原始 `HoursOfInactivityBeforeAutoresign` 重放。签到与库存处理见[不活跃规则](../development/realtime-clock.md#不活跃)。

原版机器可读参数与专家元数据以固定 `apk-12075-rules-4300` 参考为来源，不将其原始单位、招募时点或隐藏功能误作当前 UI 配置。参考数据不证明线上服务端一致。

## 阅读顺序

1. [基础机制](01-core-rules.md)
2. [战斗与事件顺序](04-combat-and-time.md)
3. [来源与本地差异](05-versions-and-sources.md)
4. [能力与证据限制](06-open-questions.md)
5. [实现与数据契约](07-development-contract.md)

原版研究资料另见[参考参数字典](02-parameters.md)和[专家参考目录](03-specialists.md)，不作为当前行动或规则说明。

## 数据入口

| 文件 | 用途 |
| --- | --- |
| data/profile-diplomacy-core-v1.json | 当前无专家玩法参数 |
| data/profile-4300.json | 固定原始配置，仅供研究 |
| data/parameters.json / parameters.csv | 参数、单位、来源和状态 |
| data/specialists.json | 稳定专家 ID、元数据与技能摘要 |
| data/rules.json | 参考规则条目与公式 |
| data/constants.json | 额外引擎常量 |
| data/sources.json | 来源与定位 |
| data/acceptance-cases.json | 公式算例，不是实战回放 |
| data/catalog.json / catalog.schema.json | 组合目录与结构 |
| data/build-manifest.json | 固定样本哈希及生成信息 |

同目录保留的参考配置快照仅供研究追溯，不属于当前版本变更说明。资料的来源类型不能当作运行验收状态。提取的原版实现通过reference或reference-profile规则入口访问研究数据；游戏、界面和bot使用当前玩法入口。

## 维护

使用 `scripts/build_rulebook.py` 和 `scripts/build_rule_catalog.py` 重建数据，使用 `scripts/validate_rulebook.py` 校验结构与引用。生成前需要固定研究样本；Markdown 规范按当前源码维护，生成器的标题与导言也须遵守[文档规范](../development/development-guide.md#文档规范)。

不要手改来源哈希或原始提取函数。玩法调整应写在共享玩法配置及当前规则说明，保留参考数据本身的真实性。
