# Project Memory

当前仓库里持续演进的交互项目是 `garss-studio/`。

如果后续对话涉及 RSS 阅读器、订阅源管理、Docker 单端口部署、`EditREADME.md` 自动导入，请优先查看：

- `garss-studio/README.md`
- `garss-studio/PROJECT_MEMORY.md`

当前已经固化的关键约定：

- GARSS Studio 通过 Docker 只暴露一个端口：`25173`
- 订阅源支持两种输入：RSSHub 路径和完整 RSS URL
- `EditREADME.md` 的分类表格可通过 `garss-studio/scripts/sync-editreadme.mjs` 自动导入
- 管理页按“左侧分类，右侧订阅源”布局显示
