# 美术资源与地图呈现

## 固定参考图集

`packages/client/public/assets/original/` 保存原始资源及 manifest，包含海底纹理 Sea、游戏元素 GameElements 和专家徽章 SpecialistAtlas。manifest 记录原始路径、尺寸和 SHA-256；渲染着色不改源图。

`OriginalIcon.tsx` 与 Canvas 地图使用 GameElements 图集坐标，CSS mask 按实际 PNG 尺寸处理。SpecialistAtlas 仅保留为原始美术资产，不参与当前单位渲染。

重建使用 `node scripts/extract-art.mjs`，需要合法固定样本；运行游戏使用现有资源，不依赖 research 目录。未核实用途的帧不随意绑定新操作。据点、舰队、开矿和护盾标记来自当前 DTO，不虚构单位或可见性。

## 原创主题

大厅与控制台使用海底港湾/指挥舱主题资源，目录分别为 `packages/client/public/assets/lobby/` 和 `packages/client/agent-console-public/assets/`。这些主题资源与原始图集分别管理来源。

## 使用规范

资产来源、原始文件和渲染代码分别维护。新增资源需记录来源、用途与尺寸，不能把提取或已有文件自动解释为无限制再授权。界面以明确层级和操作表达规则，资产接入不恢复[关闭功能](feature-availability.md)。

前端资源检查、浏览器视觉检查和实际游戏规则验证是不同工作，具体结果放运行记录。
