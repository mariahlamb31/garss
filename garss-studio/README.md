# GARSS Studio

一个放在当前仓库内的独立子项目，结构参考 `banana` 的前后端 + Docker 组织方式，并借用了 `notes` 的锤子便签风格视觉方向。

## 项目记忆

项目级的长期约定和当前产品决策，统一记录在 `PROJECT_MEMORY.md`。

## 功能

- 前端：React + TypeScript + Zustand
- 后端：Express + TypeScript
- 鉴权：提取码登录，后端签发 Bearer Token
- RSS：通过 Docker 拉起 RSSHub 服务，后端代理并转发给前端
- 模块：
  - 阅读已订阅 RSS
  - 管理 RSS 订阅源

## 目录

- `src/` 前端
- `server/` 后端
- `storage/` 订阅源持久化数据
- `docker-compose.dev.yml` 开发环境
- `docker-compose.yml` 生产环境

## 环境变量

复制 `.env.example` 为 `.env` 后再运行：

```bash
cp .env.example .env
```

关键变量：

- `ACCESS_CODE`：前端登录使用的提取码
- `ACCESS_TOKEN_SECRET`：后端签名密钥
- `SESSION_TTL_HOURS`：登录有效期
- `RSSHUB_BASE_URL`：默认指向 Docker Compose 内部的 `rsshub` 服务
- `SCHEDULER_ENABLED`：是否启用后端自动调度，默认 `true`
- `VITE_API_PROXY_TARGET`：Vite 开发代理指向的后端内部地址，默认开发容器使用 `http://backend:3001`

## 提取码 URL

前端支持把提取码直接放到 URL 查询参数里：

```bash
http://127.0.0.1:25173/?pw=banana
```

带 `pw` 参数访问时，页面会自动尝试登录；手动登录时也会把提取码同步到 URL。

## 开发

```bash
docker compose -f docker-compose.dev.yml up --build
```

启动后：

- 统一入口：http://127.0.0.1:25173

开发环境下，浏览器只访问 `25173`。前端通过 Vite 代理 `/api` 和 `/socket.io` 到后端；后端和 RSSHub 不再暴露宿主机端口。

`docker-compose.dev.yml` 默认会注入 `SCHEDULER_ENABLED=false`，避免开发容器启动时立刻触发后端全量自动拉取导致内存暴涨。这个默认值只影响自动调度：

- 阅读页和非强制读取仍然只读取 `storage/reader-cache.json`
- 手动刷新当前订阅源仍然会真实抓取并更新缓存
- 浏览器访问方式不变，仍然只通过 `25173` 和 Vite 代理访问 `/api`、`/socket.io`

如果要在开发环境验证自动调度，再显式打开：

```bash
SCHEDULER_ENABLED=true docker compose -f docker-compose.dev.yml up --build
```

如果不走 Docker，而是在宿主机上单独运行 Vite/后端，也仍然应该只通过前端入口访问接口；需要为 Vite 显式设置代理目标，例如：

```bash
VITE_API_PROXY_TARGET=http://127.0.0.1:3001 npm run dev
```

## 生产

```bash
docker compose up --build -d
```

启动后：

- 统一入口：http://127.0.0.1:25173

生产环境下，前端 Nginx 反向代理 `/api` 到后端；整个项目同样只占用一个宿主机端口。

## API 文档

后端维护用 Swagger 文档通过现有单端口入口暴露，不需要直接访问后端 `3001`：

- 开发和生产统一使用 `http://127.0.0.1:25173/api/docs`
- 原始 OpenAPI JSON：`http://127.0.0.1:25173/api/openapi.json`

文档里对受保护接口统一标注了 Bearer Token。可以先调用 `/api/auth/login`，再把返回的 `token` 填进 Swagger UI 的 `Authorize`。

## 订阅源格式

订阅源同时支持两种格式：

- RSSHub 路径
- 完整 RSS 地址

RSSHub 路径示例：

- `/github/trending/daily/javascript`
- `/zhihu/daily`
- `/36kr/newsflashes`

完整 RSS 地址示例：

- `https://iao.su/feed`
- `https://xclient.info/feed`

前端保存的是 `routePath`。当它是 `/xxx` 这样的路径时，后端会拼接到 `RSSHUB_BASE_URL`；当它本身就是 `http(s)://` 地址时，后端会直接抓取该地址。

## 从 EditREADME.md 自动同步

仓库根目录的 `EditREADME.md` 使用稳定表格格式维护订阅源分类，例如：

```md
| <h2 id="软件工具">软件工具</h2> |  |   |  |
| <div id="S001">...</div> | 不死鸟 | 不死鸟:专注分享优质资源 | {{latest_content}} | [订阅地址](https://iao.su/feed) |
```

项目内置脚本会自动解析这些分类和订阅源，并同步到 GARSS Studio：

```bash
npm run sync:editreadme
```

同步行为：

- 解析 `../EditREADME.md`
- 刷新 `storage/subscriptions.json`
- 刷新 `../garssInfo.json`
- 自动把表格分类映射为管理页左侧类型
- 自动把 `[订阅地址](...)` 写入订阅源的 `routePath`

同步约定：

- 由 `EditREADME.md` 生成的订阅源 id 统一为 `editreadme-*`
- 再次同步时会覆盖这些生成项
- 手工在页面里新增的订阅源会保留，不会被脚本删除
- 已生成订阅源如果内容未变化，会尽量保留原有 `enabled` 和时间字段

脚本位置：

- `scripts/sync-editreadme.mjs`

## 当前界面约定

阅读页：

- 顶部栏固定高度 `62px`
- 主工作区高度固定为 `calc(100vh - 62px)`
- 左侧是单选订阅源索引，独立滚动
- 右侧是当前选中源的文章列表，独立滚动
- 右侧支持仅对当前选中订阅源执行“重新拉取当前源”
- 后端会缓存每个订阅源最近一次成功拉取的文章，缓存文件是 `storage/reader-cache.json`
- 页面刷新或重新进入阅读页时默认只读后端缓存，不主动触发真实 RSS 拉取
- 自动拉取和“重新拉取某个 RSS 源”会触发真实拉取，并把结果回写到后端缓存

管理页：

- 左侧是分类列表
- 左侧支持通过小加号就地创建新类型，空类型也会持久化保留
- 右侧是当前分类下的订阅源列表
- 新增和编辑都通过弹窗表单完成

设置页：

- 作为与“阅读 RSS”“管理订阅源”并列的第三级导航页面
- 左侧是设置条目列表，当前包含“拉取设置”和“关于”
- 拉取设置由后端持久化，保存在 `storage/settings.json`
- 设置按用户标识分桶存储，用户标识就是 URL 里的 `pw` 参数；当前默认是 `banana`
- 自动拉取时间由后端按 cron 风格计算和触发，前端不再自行定时拉取
- 例如 `5` 分钟会落在每小时的 `05/10/15/...` 分，`30` 分钟会落在每小时的 `00/30` 分，`3` 小时会落在每天的 `00/03/06/...` 时
- “拉取设置”右侧使用下拉框配置自动拉取时间间隔，默认 `30` 分钟
- “拉取设置”右侧使用下拉框配置单次并行拉取数量，默认 `2`，范围 `1-10`
- “拉取设置”右侧会显示距离下一次自动拉取的剩余时间
- 前后端通过 `socket.io` 保持连通，并在“拉取设置”右侧显示连接状态
- “拉取设置”右侧会用进度条显示当前拉取任务的“已完成 / 待完成”进度，并补充拉取中数量
- “关于”右侧只显示项目 GitHub 地址 `https://github.com/zhaoolee/garss`
