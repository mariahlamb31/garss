# GARSS Studio Project Memory

这个文件用于沉淀当前产品约定，避免后续对话重复从零恢复上下文。

## 先看哪里

- `README.md`：启动方式、同步方式、外部依赖
- `src/App.tsx`：当前主要界面结构
- `src/styles.css`：当前视觉和布局约定
- `server/index.ts`：鉴权、订阅源接口、RSS 代理逻辑
- `scripts/sync-editreadme.mjs`：从 `EditREADME.md` 自动导入分类订阅源
- `scripts/sync-rsshub-docs.mjs`：从 RSSHub 官方文档同步可编辑的模板路由，默认停用

## 当前架构

- 前端：React + TypeScript + Zustand
- 后端：Express + TypeScript
- RSS 获取：Docker 内启动 RSSHub，后端统一代理
- Docker 暴露端口：只暴露前端 `25173`
- 开发环境：Vite 代理 `/api` 和 `/socket.io` 到后端
- 生产环境：Nginx 代理 `/api` 和 `/socket.io` 到后端

## 当前产品约定

- 顶部 `header` 高度固定为 `62px`
- 阅读页高度固定为 `calc(100vh - 62px)`
- 阅读页左侧是单选订阅源索引，右侧只展示当前选中订阅源的文章
- 阅读页左右两栏都在固定高度内独立滚动
- 阅读页支持只重拉当前选中订阅源，不做全量刷新
- 后端会把每个订阅源最近一次成功拉取的文章缓存到 `storage/reader-cache.json`
- 阅读页初始化默认只读后端缓存，不主动触发真实 RSS 拉取
- 自动拉取和手动“重新拉取”才会真实访问 RSS 源，并回写缓存
- 设置是与“阅读 RSS”“管理订阅源”并列的独立一级页面
- 设置页左侧是条目列表，当前固定包含“拉取设置”和“关于”
- 拉取设置由后端持久化，文件位置是 `storage/settings.json`
- `storage/settings.json` 按用户标识分桶存储，用户标识就是 URL 里的 `pw` 参数；当前默认用户是 `banana`
- 自动拉取由后端按 cron 风格统一调度，前端不负责决定真实拉取时机
- 下一次拉取时间必须由后端计算并下发，例如 `5` 分钟对应每小时 `05/10/15/...` 分，`30` 分钟对应每小时 `00/30` 分，`3` 小时对应每天 `00/03/06/...` 时
- 自动拉取时间间隔默认 `30` 分钟，使用预设下拉选项调整
- 单次并行拉取数量默认 `2`，使用下拉选项调整，范围 `1-10`
- “拉取设置”右侧会显示下一次自动拉取倒计时
- 前后端通过 `socket.io` 保持实时连通，“拉取设置”右侧显示连接状态
- “拉取设置”右侧用进度条显示当前拉取任务进度，拆分为“已完成 / 待完成”，并补充“拉取中”数量
- “关于”右侧只显示项目 GitHub 地址 `https://github.com/zhaoolee/garss`
- 左侧阅读索引使用接近锤子便签目录栏的扁平列表风格
- 管理页是左侧分类、右侧订阅源的两栏布局
- 管理页左侧支持通过小加号就地创建新类型，交互参考锤子便签目录栏
- 管理页新增和编辑都走同一个弹窗表单

## 订阅源模型约定

订阅源核心字段：

- `id`
- `category`
- `name`
- `routePath`
- `description`
- `enabled`

`routePath` 的含义：

- 如果是 `/github/trending/daily/javascript` 这样的路径，表示 RSSHub 路径
- 如果是 `https://example.com/feed.xml` 这样的地址，表示直接抓取外部 RSS

## EditREADME.md 导入约定

目标：

- 不依赖大模型逐条提取
- 通过固定 Markdown 表格格式自动解析分类和源信息

脚本：

- `npm run sync:editreadme`
- 实现文件：`scripts/sync-editreadme.mjs`

输入：

- 仓库根目录 `EditREADME.md`

输出：

- `storage/subscriptions.json`
- `storage/categories.json`
- 仓库根目录 `garssInfo.json`

规则：

- 分类行格式：`| <h2 id="分类名">分类名</h2> | ... |`
- 订阅源行必须包含 `{{latest_content}}` 和 `[订阅地址](...)`
- 脚本会把导入项 id 统一生成为 `editreadme-*`
- 重新同步时，`editreadme-*` 项会更新
- 手工新增的非 `editreadme-*` 项会保留
- 手工创建的空类型保存在 `storage/categories.json`，不会因为当前没有订阅源而消失

## 修改时的注意点

- 不要把管理页和阅读页重新改回单页堆叠布局
- 不要重新暴露后端或 RSSHub 的宿主机端口，外部入口应保持单端口 `25173`
- 涉及 UI 调整时，优先延续锤子便签的暖色、纸面、目录式布局，而不是通用后台模板风格
- 如果新增订阅源来源渠道，优先复用 `category` 体系，避免再做一套平行分类
- `rsshub-doc-*` 属于文档同步生成项，再次同步时应更新这些项但默认保持停用
