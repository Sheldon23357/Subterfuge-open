# 规则实现与数据契约

## 实现入口

| 领域 | 位置 |
| --- | --- |
| 当前玩法参数与独立参考资料 | packages/rules/src |
| 世界、单位、经济、战斗和可见性 | packages/engine/src |
| 对外 DTO 与单位转换 | packages/contracts/src |
| 授权条件预测 | packages/prediction/src |
| 真实校验、事务与协议 | packages/server/src |

跨包使用公开入口，内部类型不作为第三方 wire。完整协议从[Player Protocol](../../protocol/player/v2/README.md)读取，不从研究数据反推 HTTP 接口。

## 状态与标识

玩家、据点、舰队、命令和事件保持各自稳定标识。game/lobby/chat 身份通过权威映射转换，不猜编号。

兵力与护盾按整数规则结算，计时和位置允许规则需要的精度。缺失、null、0、false 和 unknown 分别表达。时间字段保持内部单位，显示和模型输入在明确边界转换，见[世界时间](../development/world-day-time.md)。

## 执行与观察

引擎校验拥有权、资源、动作条件和时间；服务端另外校验身份、scope、控制租约、版本及幂等。提交失败不能修改权威世界。已接受命令、已提交效果和实际战果分别记录。

玩家投影在服务器生成，不先下发隐藏世界。预测只用授权观察及显式假设，不读服务器数据库。规则变更不能偷偷替换存档的规则身份，也不为失效开发存档补通用兼容字段。

## 数据与检查

data/acceptance-cases.json 是来源公式算例，结构校验不等于完整游戏回归。原版对照需固定合法样本，默认回归验证本地规则，两者分别报告，见[检查指南](../development/regression-suites.md)。

开发说明维护现行数据流与边界；具体测试和对局证据保存在运行报告，不在此记录历次实施阶段。
