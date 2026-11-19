# 专家完整目录

中文名为本项目工作译名，以稳定英文ID为准。数值与标记来自固定样本元数据及 rules 4300 参考配置；当前玩法已移除专家系统，本表仅供原版研究；见 [功能范围](../development/feature-availability.md)。

优先级0表示没有正优先级的常规战斗技能，不代表被动效果先于一切。参与标记不是被动效果开关。速度是条件性基础倍率，不能相乘叠加。category=promoted也不代表女王可通过晋升获得。

|ID / 中文|类型ID|分类|招募包数量¹|速度倍率|战斗优先级|晋升为|
|---|---:|---|---:|---:|---:|---|
|Diplomat / 外交官|11|other|1|1.0|0|—|
|Engineer / 工程师|7|promoted|1|1.0|0|—|
|ReveredElder / 长老|17|defense|1|1.0|2|—|
|Admiral / 海军上将|3|promoted|1|1.5|0|—|
|Foreman / 工头|23|other|1|1.0|0|Engineer|
|Tycoon / 大亨|4|promoted|1|1.0|0|—|
|Pirate / 海盗|12|attack|1|2.0|0|—|
|Lieutenant / 中尉|1|attack|1|1.5|8|General|
|Princess / 公主|24|other|1|1.0|0|—|
|King / 国王|8|promoted|1|1.0|0|—|
|Infiltrator / 渗透者|14|attack|1|1.0|5|—|
|MinisterOfEnergy / 能源部长|9|promoted|1|1.0|0|—|
|WarHero / 战争英雄|2|attack|1|1.0|8|Sentry|
|Sentry / 哨兵|15|promoted|1|1.0|0|—|
|IntelligenceOfficer / 情报官|25|other|1|1.0|0|—|
|Tinkerer / 修补匠|22|other|1|1.0|0|MinisterOfEnergy|
|Saboteur / 破坏者|19|defense|2|1.0|3|—|
|Assassin / 刺客|13|attack|2|1.0|7|—|
|Inspector / 检查员|16|defense|1|1.0|0|SecurityChief|
|DoubleAgent / 双面间谍|27|defense|1|1.0|6|—|
|SecurityChief / 安全主管|5|promoted|1|1.0|0|—|
|Queen / 女王|30|promoted|1|1.0|0|—|
|Thief / 盗贼|10|attack|1|1.0|4|—|
|General / 将军|6|promoted|1|1.5|0|—|
|Smuggler / 走私者|20|defense|1|3.0|0|Tycoon|
|Navigator / 导航员|21|other|1|1.0|0|Admiral|
|Martyr / 殉道者|29|defense|1|1.0|1|—|
|Helmsman / 舵手|26|other|1|2.0|0|—|
|Hypnotist / 催眠师|28|other|1|1.0|0|King|

¹晋升型及女王的数量字段只是元数据默认值，不表示可以直接招募。当前玩法不提供专家候选抽取。

## Diplomat（外交官）

释放其据点声呐覆盖范围内、关押在据点中的己方专家。

客户端参与标记：无主动参战标记。

## Engineer（工程师）

胜方修复：全局每名25%，现场每名额外25%；合并比例最高100%，对结算记录的钻机损失向上取整。

客户端参与标记：无主动参战标记。

## ReveredElder（长老）

只有一方有可参战长老时，关闭后续双方专家参战标记；双方都有则不关闭。殉道者优先于长老。

客户端参与标记：invading、defending、transit。

## Admiral（海军上将）

至少一名提供无专家潜艇50%全局加速，不按人数叠加；自身速度1.5倍。

客户端参与标记：无主动参战标记。

## Foreman（工头）

位于据点且生效时，覆盖该据点一半实际声呐范围内己方工厂，每周期每名加4。覆盖含边界。

客户端参与标记：无主动参战标记。

## Tycoon（大亨）

每名将全局生产速率系数增加0.5；本人所在工厂每周期额外3。周期按tick取整。

客户端参与标记：无主动参战标记。

## Pirate（海盗）

可指定敌方潜艇为目标，追击速度2倍，返航最近友方据点时4倍；普通据点航行不自动享受2倍。

客户端参与标记：transit。

## Lieutenant（中尉）

参战直接摧毁最多5台敌方钻机，自身速度1.5倍。

客户端参与标记：invading、defending、transit。

## Princess（公主）

所在据点声呐1.5倍；女王失去控制时最近的公主继位，距离相同的裁定待核实。

客户端参与标记：无主动参战标记。

## King（国王）

专家阶段结束己方每4兵摧毁1敌兵，向下取整；攻击加成不叠加。每名仍各减全局护盾上限20。

客户端参与标记：无主动参战标记。

## Infiltrator（渗透者）

攻据点清空护盾；潜艇战触发结束战斗并继续航行。

客户端参与标记：invading、transit。

## MinisterOfEnergy（能源部长）

每名增加300供电，同时每座工厂每周期少产1台钻机。

客户端参与标记：无主动参战标记。

## WarHero（战争英雄）

参战直接摧毁最多20台敌方钻机。

客户端参与标记：invading、defending、transit。

## Sentry（哨兵）

据点内每120分钟尝试射击，范围为所在据点半声呐；伤害为目标钻机数5%向上取整，优先最大伤害目标。

客户端参与标记：无主动参战标记。

## IntelligenceOfficer（情报官）

增加全局声呐25%，并显示视野外据点类型；多个情报官的叠加顺序另列待确认。

客户端参与标记：无主动参战标记。

## Tinkerer（修补匠）

供电增加所在据点最大护盾的3倍，每小时消耗该据点3护盾。零盾/转移时序待确认。

客户端参与标记：defending。

## Saboteur（破坏者）

潜艇战将对方潜艇改派至对方最近友方据点；一次招募获得2名。

客户端参与标记：transit。

## Assassin（刺客）

杀死战场对方所属专家；一次招募获得2名。同优先级刺客可相互杀死。

客户端参与标记：invading、defending、transit。

## Inspector（检查员）

到达友方据点及战后在场时补满护盾；当前不增加基础护盾上限。

客户端参与标记：defending。

## DoubleAgent（双面间谍）

潜艇战双方钻机清零，交换双方潜艇和专家归属并结束战斗。

客户端参与标记：transit。

## SecurityChief（安全主管）

每名全局护盾上限加10，本人据点再加10。

客户端参与标记：defending。

## Queen（女王）

所在据点护盾上限加20；提供招募入口；额外获得的女王转为公主。

客户端参与标记：无主动参战标记。

## Thief（盗贼）

进攻据点或潜艇战夺取对方15%钻机，向上取整并限制到实际剩余兵力；防守据点不发动。

客户端参与标记：invading、transit。

## General（将军）

专家阶段后己方仍有未被俘且存活专家才触发全局每名10杀伤；自身速度1.5倍。

客户端参与标记：invading、defending、transit。

## Smuggler（走私者）

目的地属于本人时速度3倍；不对敌方据点进攻提供3倍加速。

客户端参与标记：invading、transit。

## Navigator（导航员）

允许途中改向，冷却480分钟；冷却归属与首次使用边界列为待确认。

客户端参与标记：无主动参战标记。

## Martyr（殉道者）

战斗优先级1爆炸，摧毁半径1.5世界单位内潜艇及满足护盾阈值的据点，含友军；使用环面最短距离。

客户端参与标记：invading、defending、transit。

## Helmsman（舵手）

自身速度2倍。

客户端参与标记：无主动参战标记。

## Hypnotist（催眠师）

将本人所在据点的俘虏转为己方专家。

客户端参与标记：无主动参战标记。

来源：[官方专家手册](https://subterfuge-game.com/rulebook/Specialists.html)；本地客户端定位见 data/sources.json。未知组合交互见 06-open-questions.md。
