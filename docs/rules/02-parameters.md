# 全量数值字典

配置基线：APK 12075 / rules 4300。`client_config`只确认配置存在，不自动证明当前分支使用它。

本表保留参考数据的秒、分钟、小时和有效小时；当前玩法和玩家世界日见 [基础机制](01-core-rules.md)。ratio=比例，multiplier=乘数，world_unit=抽象地图单位。

|字段|中文含义|值|单位|
|---|---|---|---|
|`GameParams.RulesVersion`|规则版本号|`4300`|version|
|`GameParams.DominationRequirementByPlayerCount`|个人统治目标，数组下标为玩家数|`[0, 0, 11, 13, 14, 18, 21, 25, 28, 32, 35]`|outpost_count_by_player_count|
|`GameParams.InitialOutpostsPerPlayer`|女王据点之外的初始据点数|`4`|outpost|
|`GameParams.BaseElectricalOutput`|基础供电|`150`|driller_capacity|
|`GameParams.NeptuniumPercentLostWithMine`|失矿损失比例|`0.2`|ratio|
|`GameParams.FundingElectricalOutputBonus`|每位资助者供电加成|`50`|driller_capacity_per_funder|
|`GameParams.FundingDrillerProductionBonus`|每位资助者工厂产量加成|`2`|driller_per_cycle_per_funder|
|`GameParams.NeptuniumLeadRequiredForFunding`|资助所需矿领先量|`20`|kg|
|`GameParams.MinutesOfInactivityBeforeFirstWarning`|不活跃首次警告阈值|`960`|minute|
|`GameParams.MinutesOfInactivityBetweenWarnings`|后续警告间隔|`360`|minute|
|`GameParams.HoursOfInactivityBeforeAutoresign`|不活跃自动投降阈值|`48`|hour|
|`GameParams.SecondsBetweenResignationAndSelfDestruct`|投降到自毁配置延迟，具体触发待审计|`43200`|second|
|`GameParams.GameStartingDelayInHours`|开局等待配置|`8`|hour|
|`GameParams.GameStartingDelayInHoursAfterWorldRecreation`|重建地图后的等待配置|`8`|hour|
|`GameParams.HoursBeforeFirstHire`|首次招募等待，受开局有效时间影响|`4`|effective_hour|
|`GameParams.HoursBetweenHires`|后续招募间隔|`18`|effective_hour|
|`GameParams.HoursAfterEliminationToDestroySpecialists`|淘汰到专家销毁配置延迟，触发待审计|`24`|hour|
|`GameParams.MinutesToCancelAction`|可取消动作窗口|`10`|minute|
|`GameParams.CostOfExtraHire`|额外招募历史配置，不认定为可用机制|`20`|unknown|
|`GameParams.GameStartSpeedupTicks`|开局加速阈值|`72`|tick|
|`GameParams.GameStartSpeedupFactor`|开局加速倍率，非所有系统统一加速|`1.5`|multiplier|
|`GameParams.GiftDrillersRespectElectricalCap`|赠兵受接收方供电上限限制|`1`|boolean_int|
|`GameParams.TeamDominationRequirementByPlayerCount`|团队统治目标，索引语义仍需核对胜利分支|`[0, 0, 0, 0, 19, 24, 28, 33, 37, 42, 46]`|outpost_count_by_player_count|
|`SpecialistParams.AdmiralGlobalSpeedBonus`|海军上将全局速度加成|`0.5`|ratio|
|`SpecialistParams.EngineerRepairBonus`|工程师全局修复比例|`0.25`|ratio|
|`SpecialistParams.EngineerRepairBonusIfPresent`|工程师在场额外修复比例|`0.25`|ratio|
|`SpecialistParams.DoubleAgentRange`|保留配置，不据此推断当前双面间谍范围技能|`6`|world_unit|
|`SpecialistParams.ForemanExtraDrillers`|每位覆盖工头的额外产量|`4`|driller_per_cycle|
|`SpecialistParams.GeneralPowerBonusForSpecialists`|每位将军的全局杀伤|`10`|driller|
|`SpecialistParams.GeneralCombatBonus`|保留配置，当前为零|`0`|driller|
|`SpecialistParams.InfiltratorDrainAmount`|渗透者排盾配置哨兵值|`9999`|shield_charge|
|`SpecialistParams.InspectorShieldBonus`|检查员护盾上限旧参数，当前为零|`0`|shield_charge|
|`SpecialistParams.IntelligenceOfficerGlobalVisibilityBonus`|情报官全局声呐加成|`0.25`|ratio|
|`SpecialistParams.IntelligenceOfficerLocalVisibilityMultiplier`|情报官本地声呐倍率|`1`|multiplier|
|`SpecialistParams.DEPRECATED_V25_KingCombatBonus`|旧国王战力参数，明确废弃|`0.25`|ratio|
|`SpecialistParams.KingDestroyRatio`|国王每击毁一兵所需己方兵数|`4`|own_drillers_per_enemy_driller|
|`SpecialistParams.KingShieldPenalty`|每位国王护盾上限惩罚|`20`|shield_charge_per_king|
|`SpecialistParams.LieutenantCombatBonus`|中尉直接杀伤|`5`|driller|
|`SpecialistParams.MartyrRange`|殉道者爆炸半径|`1.5`|world_unit|
|`SpecialistParams.MartyrShieldThreshold`|殉道者摧毁据点护盾阈值|`9999`|shield_charge|
|`SpecialistParams.MinisterOfEnergyDrillerProductionFactor`|旧版生产倍率，4300生产分支不使用|`0.5`|multiplier|
|`SpecialistParams.MinisterOfEnergyDrillerProductionPenalty`|名义生产惩罚；当前执行公式直接减能源部长数量|`1`|driller_per_cycle|
|`SpecialistParams.MinisterOfEnergyOutput`|能源部长供电加成|`300`|driller_capacity|
|`SpecialistParams.NavigatorChangeCourseDelayInSeconds`|导航改向延迟配置|`0`|second|
|`SpecialistParams.NavigatorCourseChangeCooldownInMinutes`|导航改向冷却|`480`|minute|
|`SpecialistParams.NavigatorSpeedPenalty`|导航速度惩罚|`0`|ratio|
|`SpecialistParams.PrincessLocalVisibilityMultiplier`|公主本地声呐倍率|`1.5`|multiplier|
|`SpecialistParams.QueenShieldBonus`|女王本地护盾上限加成|`20`|shield_charge|
|`SpecialistParams.SecurityChiefGlobalShieldBonus`|安全主管全局护盾上限加成|`10`|shield_charge|
|`SpecialistParams.SecurityChiefLocalShieldBonus`|安全主管本地护盾上限加成|`10`|shield_charge|
|`SpecialistParams.SentryDrillerRemovedPercentage`|哨兵单发杀伤比例|`0.05`|ratio|
|`SpecialistParams.SentryFirePeriodInMinutes`|哨兵射击间隔|`120`|minute|
|`SpecialistParams.ThiefTransferFactor`|盗贼夺兵比例|`0.15`|ratio|
|`SpecialistParams.TinkererBoostFactor`|修补匠按护盾上限增加供电的系数|`3`|capacity_per_shield_charge|
|`SpecialistParams.TinkererDischargePerHour`|修补匠耗盾速率|`3`|shield_charge_per_hour|
|`SpecialistParams.TycoonExtraDrillers`|大亨本地产量加成|`3`|driller_per_cycle|
|`SpecialistParams.TycoonProductionRateBonusFactor`|大亨全局生产速率加成|`0.5`|ratio|
|`SpecialistParams.WarHeroCombatBonus`|战争英雄直接杀伤|`20`|driller|
|`OutpostParams.GeneratorElectricalOutput`|每座发电站供电|`50`|driller_capacity|
|`OutpostParams.MinDistBetweenOutposts`|地图生成最小据点距离配置|`3`|world_unit|
|`OutpostParams.MaxDistBetweenOutposts`|地图生成最大据点距离配置|`10`|world_unit|
|`OutpostParams.VisibilityRange`|基础声呐半径|`8`|world_unit|
|`OutpostParams.QueenInitialDrillers`|女王据点初始钻机|`0`|driller|
|`OutpostParams.SecondaryOutpostInitialDrillers`|其余初始据点钻机|`40`|driller|
|`OutpostParams.ShieldDisableDelayInMinutes`|关闭护盾等待|`10`|minute|
|`OutpostParams.MinutesForFullShieldPower`|护盾恢复周期名义值，离散取整会改变实际时间|`2880`|minute|
|`OutpostParams.WeakShieldMaxCharge`|弱护盾基础上限|`10`|shield_charge|
|`OutpostParams.StrongShieldMaxCharge`|强护盾基础上限|`20`|shield_charge|
|`OutpostParams.CityShieldMaxCharge`|城市护盾保留配置，普通模式用途未核实|`40`|shield_charge|
|`OutpostParams.MinutesBetweenDrillerProductions`|工厂基础生产周期|`480`|minute|
|`OutpostParams.DrillersPerProduction`|工厂基础产量|`6`|driller_per_cycle|
|`OutpostParams.BaseMineCreationCostInDrillers`|基础开矿费用；4300主公式含硬编码50与100|`50`|driller|
|`OutpostParams.MineProductionCycleInMinutes`|历史采矿周期配置，4300实际按据点数计算|`240`|minute|
