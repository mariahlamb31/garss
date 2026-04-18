# Backend Maintenance

## Scope

本文档只覆盖 `server/index.ts` 为主的 GARSS Studio 后端维护约定，重点是调度、缓存、开发代理和常见修改边界。

## Runtime Model

- 后端是单进程 Express + `socket.io` 服务。
- 开发环境下，浏览器只访问前端 `25173`，前端通过 Vite 代理 `/api` 和 `/socket.io` 到后端。
- 生产环境下，浏览器同样只访问单端口入口，由 Nginx 代理 `/api` 和 `/socket.io`。
- RSS 真实抓取只能由后端执行；前端不直接访问 RSSHub，也不直接访问后端容器端口。

## Reader Invariants

- 非强制读取必须是缓存读取。
- 后端缓存文件是 `storage/reader-cache.json`。
- 显式刷新当前订阅源时，后端会真实抓取并回写该订阅源缓存。
- 定时任务负责全量真实抓取；前端不能通过定时器驱动真实拉取。

## Scheduler And Cache Safety

- 调度入口是 `refreshAllSubscriptionsIntoCache()`.
- 调度总开关是环境变量 `SCHEDULER_ENABLED`，默认按后端环境取值；开发 compose 默认注入 `false`。
- 当 `SCHEDULER_ENABLED=false` 时，只能禁用自动调度，不要影响手动刷新接口和缓存读取路径。
- 调度刷新必须按订阅源逐个持久化，不能先把整批抓取结果累计到内存里再统一写盘。
- 调度写缓存必须走 `writeReaderCache()` -> `updateReaderCacheCollection()` -> `runWithReaderCacheWriteLock()` 这条串行写路径。
- 不要绕开 `readerCacheWriteChain` 直接并发写 `storage/reader-cache.json`。
- 允许并发抓取多个源，但每个源抓取完成后要立刻写回缓存并释放结果引用。
- 如果后续继续优化调度，只能降低内存占用或失败放大面，不能破坏“抓一个写一个”的约束。

开发环境约定：

- `docker-compose.dev.yml` 默认关闭自动调度，避免后端启动时立即做全量抓取。
- 需要验证调度时，用 `SCHEDULER_ENABLED=true docker compose -f docker-compose.dev.yml up --build` 显式开启。
- 即使调度关闭，浏览器仍然只通过 `25173` 访问，前端继续经由 Vite 代理访问 `/api` 和 `/socket.io`。

## Dev Proxy Rules

- `vite.config.ts` 的代理目标应该指向后端内部地址，默认是 `http://backend:3001`。
- 不要再把 `http://127.0.0.1:3001` 当作默认浏览器访问模式写进配置或文档。
- 如果维护者在宿主机上直接跑 `npm run dev`，可以显式设置：

```bash
VITE_API_PROXY_TARGET=http://127.0.0.1:3001 npm run dev
```

- 即使这样运行，浏览器也仍然只应该访问前端入口，不直接打开后端 `3001`。

## Operational Checks

修改后至少执行：

```bash
npm run typecheck
npm run build
```

额外检查项：

- 确认 `/api/reader/subscriptions/:id?refresh=true` 仍然会真实抓取并更新缓存。
- 确认不带 `refresh=true` 的读取只返回缓存。
- 确认开发环境下 `25173` 可以正常透传 `/api` 和 `/socket.io`。
- 如果开启了自动调度，确认调度跑完整轮后，进程内存不会因为批量结果累积而持续上涨。
- 如果开发 compose 保持默认配置，确认后端启动时不会立即挂起自动调度任务。

## Files To Review Before Backend Changes

- `server/index.ts`
- `vite.config.ts`
- `docker-compose.dev.yml`
- `storage/reader-cache.json`
- `storage/settings.json`
