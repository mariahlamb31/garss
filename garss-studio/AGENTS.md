# AGENTS

这个文件给后续进入 `garss-studio/` 的 agent 使用。

## 开始前先看

按这个顺序建立上下文：

1. `PROJECT_MEMORY.md`
2. `README.md`
3. `src/App.tsx`
4. `src/styles.css`
5. `server/index.ts`

## 当前产品基线

- 前端：React + TypeScript + Zustand
- 后端：Express + TypeScript
- Docker 外部只暴露一个端口：`25173`
- 开发环境通过 Vite 代理 `/api` 和 `/socket.io`
- 生产环境通过 Nginx 代理 `/api` 和 `/socket.io`

## 推荐启停命令

仓库根目录有各平台统一入口，双击后选择启动、关闭、升级、查看状态或退出控制台；执行完一次操作后会返回菜单。退出控制台或关闭窗口不应停止服务，只有“关闭”动作会执行 `npm run quick:stop`：

```text
GARSS-MACOS.command
GARSS-LINUX.sh
GARSS-WINDOWS.bat
```

命令行入口：

```bash
npm run quick:start
npm run quick:stop
npm run quick:upgrade
```

默认使用 `docker-compose.dev.yml`。如果需要生产 compose，使用 `npm run quick:start -- prod` 和 `npm run quick:stop -- prod`。

## UI 约定

- 顶部 `header` 高度固定为 `62px`
- 阅读页是左右布局：
  - 左侧为单选订阅源索引
  - 右侧只显示当前选中订阅源的文章
  - 右侧支持“重新拉取当前源”
  - 左右区域都在固定高度内独立滚动
  - 后端缓存文件是 `storage/reader-cache.json`
  - 页面初始化默认读缓存，不主动触发真实 RSS 拉取
  - 自动拉取和手动重新拉取才会访问真实 RSS 源，并更新缓存
- 设置页是与“阅读 RSS”“管理订阅源”并列的一级页面：
  - 左侧为条目列表，当前固定为“拉取设置”“关于”
  - 拉取设置必须走后端持久化，存储文件是 `storage/settings.json`
  - `storage/settings.json` 需要按用户标识分桶；用户标识就是 URL 里的 `pw` 参数，当前默认是 `banana`
  - 自动拉取必须由后端按 cron 风格调度，前端不能再自己用 `setInterval` 触发真实拉取
  - “距离下一次自动拉取”必须显示后端计算出的下一次 cron 触发时间
  - “拉取设置”右侧展示自动拉取时间间隔、并行拉取数量、下一次拉取倒计时、`socket.io` 连接状态和任务进度条
  - 自动拉取时间间隔默认 `30` 分钟，使用下拉选项配置
  - 单次并行拉取数量默认 `2`，使用下拉选项配置，范围 `1-10`
  - “关于”右侧只展示项目 GitHub 地址 `https://github.com/zhaoolee/garss`
- 管理页是左右布局：
  - 左侧为分类列表
  - 左侧支持小加号就地创建新类型
  - 右侧为当前分类下的订阅源
  - 新增和编辑都通过弹窗表单完成
- 视觉方向应保持接近锤子便签，不要改成通用后台模板风格

## 订阅源约定

- 订阅源字段至少包含：
  - `id`
  - `category`
  - `name`
  - `routePath`
  - `description`
  - `enabled`
- `routePath` 同时支持：
  - RSSHub 路径，例如 `/36kr/newsflashes`
  - 完整 RSS URL，例如 `https://iao.su/feed`

## 自动导入约定

- `EditREADME.md` 是规范化来源，不要手工逐条搬运
- 同步命令：

```bash
npm run sync:editreadme
```

- 实现脚本：`scripts/sync-editreadme.mjs`
- 输入：仓库根目录 `EditREADME.md`
- 输出：
  - `storage/subscriptions.json`
  - 仓库根目录 `garssInfo.json`

## 修改时避免破坏的点

- 不要把阅读页和管理页改回上下堆叠主布局
- 不要移除 `category` 体系
- 不要把 `EditREADME.md` 导入逻辑重新做成依赖模型理解的流程
- 不要破坏单端口部署假设
