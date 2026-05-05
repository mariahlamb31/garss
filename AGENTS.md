# AGENTS

本仓库当前主要维护的交互项目是 `garss-studio/`。

## 工作入口

- 如果任务和 RSS 阅读器、订阅源管理、Docker 部署、`EditREADME.md` 自动导入有关，优先进入 `garss-studio/`
- 进入后先看：
  - `garss-studio/AGENTS.md`
  - `garss-studio/PROJECT_MEMORY.md`
  - `garss-studio/README.md`

## 当前全局约定

- 不要把后端或 RSSHub 直接暴露到宿主机，外部入口应保持单端口
- `EditREADME.md` 是规范化的数据源，不要用大模型人工提取替代脚本解析
- 如果要同步 `EditREADME.md`，优先使用 `garss-studio/scripts/sync-editreadme.mjs`

## garss-studio 启动方式

开发环境：

```bash
cd garss-studio
cp .env.example .env
docker compose -f docker-compose.dev.yml up --build
```

开发环境默认只暴露单端口入口：

```text
http://127.0.0.1:25173/reader?pw=banana
```

开发 compose 默认会按设置页时间间隔自动触发拉取。

生产环境：

```bash
cd garss-studio
cp .env.example .env
docker compose up --build -d
```

生产环境入口同样是：

```text
http://127.0.0.1:25173/reader?pw=banana
```

停止命令：

```bash
docker compose -f docker-compose.dev.yml down
docker compose down
```

## 文档分工

- `PROJECT_MEMORY.md`：记录长期产品决策和上下文
- `AGENTS.md`：记录后续 agent 的工作入口、约束和推荐动作
