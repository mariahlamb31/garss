# RSSHub 文档参数自动自测与可选项固化 Implementation Plan

> **For Hermes:** Use subagent-driven-development / Codex execution style to implement this plan task-by-task. Hermes负责规划、监工、验收；编码交给 Codex。

**Goal:** 结合 RSSHub 官方文档、已有示例路由与 RSS 自测能力，自动发现“可用参数值”，把可成功访问的参数值沉淀为编辑界面的下拉候选项，同时保留手动输入能力。

**Architecture:** 现有前端已经能解析 `routeTemplate` 并在编辑弹窗内渲染参数输入/选择；后端已经提供单条 `/api/subscriptions/test` 自测接口。下一步新增一条“离线批量参数探测”流水线：读取 `storage/rsshub-docs-routes.snapshot.json` 与 `storage/subscriptions.json` 中的 RSSHub 文档模板，先从 description / example / route token 中推断候选值，再调用统一 RSS 测试逻辑批量验证，把成功值写回新的参数元数据字段，供前端直接渲染为 select；探测失败或无结构化候选时仍退回 text input。

**Tech Stack:** React + TypeScript + Zustand + Express + RSS Parser + Node scripts / local JSON storage.

---

## Current context / observations

1. 当前 `src/components/SubscriptionEditorModal.tsx` 已支持：
   - 根据 `routeTemplate` 提取参数
   - 对部分参数显示 `select`
   - 保存前“自测 RSS”按钮
2. 当前 `src/lib/subscription-route.ts` 已有启发式候选值推断，但主要依赖 description 文本，命中率有限。
3. 当前后端 `/api/subscriptions/test` 仅做“单条输入路径 -> 请求 RSSHub -> 返回 itemCount/sampleTitles/targetUrl”。
4. 当前 `storage/rsshub-docs-routes.snapshot.json` 保存了 RSSHub 文档快照，条目里有 `routePath`、`description`、`name`、`category`。
5. 当前 `storage/subscriptions.json` 已导入 `rsshub-doc-*` 项，但没有“参数候选项经过真实探测”的持久字段。
6. 风险点：
   - 很多参数并不是枚举，而是用户私有 id / slug / uid，不能盲目变成 select
   - 文档描述不规整，必须允许 heuristics miss
   - 需要限流与缓存，不能一次把 3000+ 路由全部打爆

## Proposed approach

### 数据模型新增
为订阅源新增参数元数据字段，例如：

- `parameterMeta?: RouteParameterMeta[]`
- 每个参数包含：
  - `name`
  - `optional`
  - `inputKind: "text" | "select"`
  - `description`
  - `options: { value: string; label: string; source: "doc" | "example" | "probe"; verified?: boolean; lastVerifiedAt?: string; itemCount?: number }[]`
  - `probeStatus?: "idle" | "partial" | "verified" | "failed"`

说明：
- `inputKind=select` 仅在有真实可用候选项时启用。
- 即使是 `select`，前端也要保留“手动输入/改完整 routePath”的逃生口。

### 统一参数探测核心
把“单条订阅源测试”抽成可复用服务函数，供：
- `/api/subscriptions/test`
- 新增批量离线探测脚本/接口
共同调用。

### 候选值来源分层
优先级从高到低：
1. 文档示例路径 `示例：/...`
2. description 中显式枚举映射（如 `whole news entertainment ...`、`0所有时间 1最近一周`）
3. route template 默认值提示（如“默认为首页”、“默认为点击榜”）
4. 历史已经通过的已保存 routePath 反推
5. 少量内置启发式（如 `type: click/follow`、`time: hour/day/week/month`）

只有“可结构化提取 + 探测成功”的值，才固化成 select 选项。

### 批量探测策略
分两阶段：

#### 阶段 A：离线预计算
新增脚本，例如：
- `scripts/probe-rsshub-parameters.mjs`

输入：
- `storage/rsshub-docs-routes.snapshot.json`
- `storage/subscriptions.json`

处理：
1. 只筛选 `rsshub-doc-*` 且含参数的模板路由
2. 为每个参数推断候选值集合
3. 组合出有限的测试 case（限制组合爆炸）
4. 调用统一测试逻辑验证
5. 仅把成功命中的候选值写回 `parameterMeta`
6. 将结果更新到 `storage/subscriptions.json`
7. 可选生成审计文件：`storage/rsshub-parameter-probe-report.json`

#### 阶段 B：编辑界面增量补探测（后续可选）
先不做实时大规模联网推断；仅保留当前“自测 RSS”按钮。后续如需要，再加“探测推荐参数”按钮。

## Step-by-step execution plan

### Task 1: 明确数据结构与兼容策略
**Objective:** 设计并落地订阅源参数元数据字段，保证旧数据不炸。

**Files:**
- Modify: `src/types.ts`
- Modify: `server/index.ts`
- Modify: `src/lib/subscription-route.ts`
- Test: `src/lib/subscription-route.test.ts`

**Steps:**
1. 在前后端共享类型里新增 `RouteParameterOptionMeta` / `RouteParameterMeta`。
2. 让 `Subscription` / `SubscriptionInput` / 服务端 `SubscriptionRecord` 支持 `parameterMeta`。
3. 读取旧数据时默认 `parameterMeta=[]`。
4. 前端模板解析逻辑优先使用持久化 `parameterMeta`，再回退 description 启发式。
5. 写测试覆盖“旧数据无字段仍可正常渲染”。

**Verification:**
- `node --test src/lib/subscription-route.test.ts`
- `npm run typecheck`

### Task 2: 抽取统一 RSS 测试核心
**Objective:** 避免 `/api/subscriptions/test` 与批量探测脚本重复造轮子。

**Files:**
- Modify: `server/index.ts` or create `server/lib/subscription-test.ts`
- Test: if project已有 server tests，新增对应测试；若暂无，至少做类型与手动验证

**Steps:**
1. 抽取 `testSubscriptionRoute(...)`，返回：`ok/targetUrl/itemCount/sampleTitles/message`。
2. `/api/subscriptions/test` 改为复用该函数。
3. 统一错误结构，方便脚本与 UI 共用。

**Verification:**
- 对现有一个可用案例手动请求应仍成功
- `npm run typecheck`

### Task 3: 实现候选值提取器
**Objective:** 从 RSSHub 文档文本提取“可能可枚举”的参数值。

**Files:**
- Create: `scripts/lib/rsshub-parameter-candidates.mjs` or `src/lib/subscription-route.ts` shared helpers
- Modify: `src/lib/subscription-route.ts`
- Test: `src/lib/subscription-route.test.ts`

**Steps:**
1. 针对几类常见文案实现解析器：
   - “A 对应 a，B 对应 b”
   - “分类：中文 中文 ... english english ...”
   - “0所有时间(默认)，1最近一周”
   - “time 参数为 day、week、month”
2. 从 `示例：/...` 中反推出某些参数值。
3. 为每个候选值打来源标签：`doc/example/heuristic`。
4. 写回归测试，至少覆盖当前已知样例：
   - `/163/news/rank/:category?/:type?/:time?`
   - `/163/exclusive/:id?`
   - `/163/music/user/playrecords/:uid/:type?`

**Verification:**
- `node --test src/lib/subscription-route.test.ts`

### Task 4: 实现离线批量探测脚本
**Objective:** 把“猜到的值”变成“验证过的值”。

**Files:**
- Create: `scripts/probe-rsshub-parameters.mjs`
- Create/Modify: `scripts/lib/subscription-import.mjs` or new helper file
- Modify: `package.json`
- Optional output: `storage/rsshub-parameter-probe-report.json`

**Steps:**
1. 读取 RSSHub 文档快照与 subscriptions。
2. 仅处理含参数模板的 `rsshub-doc-*`。
3. 生成有限测试 case：
   - 优先单参数模板
   - 多参数模板按 example/default 优先
   - 限制每参数最多 N 个候选值
   - 限制每路由最多 M 个组合
4. 调统一测试核心，加入并发限制与超时控制。
5. 成功结果写回对应订阅源的 `parameterMeta.options[]`，并标记 `verified=true`。
6. 失败项仅写报告，不污染 select。
7. 输出命令：`npm run probe:rsshub-params`

**Verification:**
- 在小样本模式运行成功
- 报告里能看到 success/fail/skipped 统计

### Task 5: 前端编辑弹窗切到“优先使用验证过选项”
**Objective:** 真正让用户在编辑界面里看到更靠谱的 select。

**Files:**
- Modify: `src/components/SubscriptionEditorModal.tsx`
- Modify: `src/lib/subscription-route.ts`
- Modify: `src/store/useAppStore.ts`
- Modify: `src/lib/api.ts` if response types changed

**Steps:**
1. 参数渲染优先读取 `form.parameterMeta` / `subscription.parameterMeta`。
2. `verified=true` 的 options 以“已验证”方式展示；未验证仅作提示，不强转 select。
3. 保留手动输入 routePath。
4. 自测成功时，如当前参数值不在 options 中，可考虑本地临时显示“当前值（刚验证成功）”。

**Verification:**
- 浏览器打开典型源时能看到 select
- `npm run typecheck`
- `npm run build`

### Task 6: 小样本实测与 Docker 验证
**Objective:** 用真实路由证明这套机制不是纸上谈兵。

**Files:**
- No code or maybe report/docs updates
- Modify: `README.md`
- Modify: `PROJECT_MEMORY.md`

**Steps:**
1. 先挑 3-8 个高价值样例：
   - 纯枚举型：`/163/news/rank/:category?/:type?/:time?`
   - 半枚举型：`/163/exclusive/:id?`
   - 单枚举型：`/163/music/user/playrecords/:uid/:type?`（type 可枚举，uid 不可枚举）
2. 跑 `npm run probe:rsshub-params -- --limit ...`。
3. 启动容器/构建，打开管理页编辑弹窗确认 select 生效。
4. 截图验收。

**Verification:**
- `npm run typecheck`
- `npm run build`
- 如项目允许：`docker compose up --build -d frontend backend`

## Likely files to change

- `src/types.ts`
- `src/lib/subscription-route.ts`
- `src/lib/subscription-route.test.ts`
- `src/components/SubscriptionEditorModal.tsx`
- `src/store/useAppStore.ts`
- `src/lib/api.ts`
- `server/index.ts` 或新增 `server/lib/subscription-test.ts`
- `scripts/probe-rsshub-parameters.mjs`
- `scripts/lib/subscription-import.mjs` 或新增脚本 helper
- `package.json`
- `README.md`
- `PROJECT_MEMORY.md`
- `storage/subscriptions.json`
- 可选：`storage/rsshub-parameter-probe-report.json`

## Testing / validation checklist

- `node --test src/lib/subscription-route.test.ts`
- `npm run test:url-routing`
- `npm run typecheck`
- `npm run build`
- 小样本探测脚本实跑
- 管理页编辑弹窗浏览器实测

## Risks / tradeoffs

1. 不能把“需要真实 uid/id/slug”的参数强行枚举化，只能针对枚举参数做 select。
2. 批量探测必须限流，否则会拖慢本地 RSSHub 或触发上游反爬。
3. 文档格式脏时，宁可保守不出 select，也不要输出错误选项。
4. 不应因为同步脚本再次运行而丢失已验证好的 `parameterMeta`；需要在同步时保留或合并。

## Open questions to resolve during execution

1. `parameterMeta` 是直接持久在 `storage/subscriptions.json`，还是同时写独立 probe report？建议两者都写：订阅源存最终态，report 存审计。
2. 探测脚本是否直接复用 server 代码，还是独立调用 HTTP `/api/subscriptions/test`？建议优先复用 server 内核心函数，减少环境依赖。
3. 是否为未验证但高可信候选值显示“建议值”？建议先不做，先只把“验证通过”的变 select。

## Immediate next action

先由 Codex 完成 Task 1-4 的第一版：数据结构、统一测试核心、候选值提取器、批量探测脚本；Hermes随后负责验收、浏览器检查和截图。