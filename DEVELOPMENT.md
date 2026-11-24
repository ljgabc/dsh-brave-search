# dsh-brave-search — 机制与开发文档

面向维护者的深度文档：seam 契约、选择机制、停用语义、安装与测试。插件页不渲染任何 README（已删除；locale 卡片描述是页面上唯一的说明文字），本文档是唯一的完整文档。

## 工作原理

- 注册进 `ctx.web` 搜索提供方注册表，id 为 `brave`；`dsh-tool-web` 渲染的 `web_search` 工具经 seam 调用它。
- **不钉扎**：1.1.0 起补丁层只注册提供方，不设置 `searchProvider`——提供方选择是部署决策（rc.4 起 DSH 官方即此立场），且 bundle 层钉扎会让"装了插件但没配密钥"的用户 `web_search` 整体消失。选 Brave 走设置页 / 用户补丁 / 环境变量（见 README）。
- 密钥解析遵循 harness 统一顺序：配置里的 `apiKey` → 凭据服务的 `BRAVE_API_KEY` 引用 → 启动环境快照（`BRAVE_API_KEY`，含 `~/.dsh/.env`）。每次搜索重新解析，改密钥无需重启。
- 未配置密钥时 `ready()` 返回 false，`dsh-tool-web` 自动从模型请求中撤下 `web_search`——不会让模型拿着不可用的工具空跑。
- 结果映射：`web` / `news` / `videos` / `discussions` 各组统一归一，按 URL 去重；`description` 反转义 HTML 实体并去除标记；`page_age` 仅在形如 ISO 8601 日期时透传为 `publishedAt`，其余省略不发明。
- 工具的 `maxResults` 映射为 Brave `count`（上限 20）作为请求层成本优化，seam 仍强制最终截断。
- 免费层限速 1 次/秒：429 自动重试恰好一次（约 1.1 秒退避，可被取消）；持续 429 以带指引的结构化错误失败。
- 失败以 `WebError` 稳定 code 上报：`WEB_PROVIDER_CREDENTIAL_MISSING` / `WEB_PROVIDER_ERROR` / `WEB_ABORTED`；重定向一律拒绝不跟随。

## 模型如何"选择"搜索引擎

模型不选择，也看不到提供方 id：它只看到一个统一的 `web_search` 工具。后端由 seam 在每次调用时按部署配置**确定性**解析——

| 组合配置 `searchProvider` | 结果 |
|---|---|
| 已设置、已注册且可用 | 用该提供方（当前 = `brave`） |
| 已设置但未注册 | 每次搜索以 `WEB_PROVIDER_CONFIGURED_MISSING` 失败 |
| 已设置但不可用 | `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` |
| 未设置，恰好一个可用 | 自动选它 |
| 未设置，多个可用 | `WEB_PROVIDER_AMBIGUOUS`（DeepSeek 路线除外：rc.4 起 route-assigned 提供方优先，DeepSeek 模型会话落 Messages 搜索，非 DeepSeek 路线落 `deepseek-search-api`） |
| 未设置，无可用 | `WEB_PROVIDER_UNAVAILABLE` |

另一个刻意行为：选中的提供方没有凭据时（`ready()` = false），`web_search` 整个从模型请求中撤下，**不会静默回退**到其他提供方——诚实的不可用优于隐式降级。

## 切换搜索引擎

选 Brave 的三种方式写同一个字段（详见 README）：设置页菜单 / 用户补丁钉扎 / `$DSH_WEB_SEARCH_PROVIDER`。在用户补丁层钉扎时**必须同时重申 `fetchProvider: http`**——补丁条目按"整对象替换"组合，漏写会顶掉 dsh-base 的抓取钉扎，导致两个抓取提供方（`http`、`deepseek-fetch-api`）无钉扎竞争、每次 `web_fetch` 以 `WEB_PROVIDER_AMBIGUOUS` 失败（此 bug 曾实际发生并已修复）。想换抓取后端时在用户层一并覆盖。

```yaml
# 用户补丁层钉扎（~/.dsh/profiles/web/cordis.patch.yml，用户层覆盖一切 bundle 层）
- id: web
  name: "@deepseek-ai/dsh-web"
  config:
    searchProvider: brave                # 或 deepseek-official / deepseek-search-api
    fetchProvider: http                  # 必须重申，见上
```

环境变量兜底语义是 `配置值 ?? 环境变量`（见 dsh-web 源码 `selectSearchProvider`）：设置页或补丁钉扎存在时环境变量**不生效**；只有配置未钉扎该字段时它才接管。

## 停用本插件时的两种开关，行为完全不同

- **Bundle 级开关**（Plugins 页里 `dsh-brave-search` 这一层 / `set_bundle`）：整层补丁退出组合，`brave` 提供方注销。若设置页/补丁钉在 brave，搜索以 `WEB_PROVIDER_CONFIGURED_MISSING` 失败或整体撤下；改回设置页 Automatic（或改钉）即恢复默认。依赖保留在 node_modules，随时可再启用。
- **插件条目开关**（条目上的 disable / `set_plugin`）：只给 `brave-search` 条目写 `disabled: true`，本插件不加载；若钉扎仍指向 brave，效果与上面相同——提供方未注册而选择仍在。**这是坏状态，不是回退。**

要停用 Brave 但保留插件，把设置页改回 Automatic 或在用户层改钉即可；条目/bundle 级 disable 前先解除 brave 钉扎，否则搜索直接报错。

## 配置

插件页 → Brave 网页搜索 → 配置（保存即时生效，无需重启）。表单分三节：密钥常显；高级设置默认折叠；使用情况为只读展示。保存按钮在可编辑区末尾（高级设置之后），无论折叠与否都无需回滚查找。

| 字段 | 说明 |
|---|---|
| Brave API 密钥 | [API 控制台](https://api-dashboard.search.brave.com/) API Keys 页的订阅密钥；留空回退环境变量 `BRAVE_API_KEY` |
| API 根地址 | 默认 `https://api.search.brave.com/res/v1`，留空自动；走代理时填同路径结构 |
| 国家/地区代码 | ISO 3166 两位代码（如 `cn`、`us`）；留空由 Brave 自动判定 |
| 搜索语言 | 如 `zh-hans`、`en`；留空自动 |
| 结果类型 | Brave `result_filter`，逗号分隔；默认 `web,news`，可加 `videos`、`discussions` |

> 真实密钥不要写进本仓库。等价方式：写进用户补丁层（`~/.dsh/profiles/web/cordis.patch.yml`）的 `- id: brave-search, config: { apiKey: … }`，或导出 `BRAVE_API_KEY`（含 `~/.dsh/.env`，重启后生效）。

## 使用统计

- 内存优先计数 + fire-and-forget 落盘：统计永不延迟、永不失败一次搜索；持久化失败仅记 warn。
- 存储域 `web_search_brave`（表 `days`，版本 1）：每个本地日一行 `{ date, searches, successes, failures, aborted, rateLimited, sources, updatedAt }`，严格 schema 校验，损坏即响亮失败。
- 埋点分两层：`apply` 注册的 search wrapper 记入口 / 成功（含来源数）/ 失败（记 lastError，消息截断 300 字符）/ 取消（独立计数，不覆盖 lastError）；provider 内部仅在 429 响应处记限速命中（只有该层知道）。
- 读取走只读认证路由 `GET /api/brave-search/usage`，返回 `{ today, total, last7（零填充连续 7 天）, lastSearchAt, lastError }`。
- `apply` 只注册搜索提供方；统计在嵌套 inject fiber（`ctx.inject(['storageDomain', 'connection'])`）中装配——组合可能在 web seam 释放本插件**之后**才提供这两个服务（0.2.2-rc.5 起 connection 晚于 web 激活），一次性 `ctx.get` 快照会静默错过（rc.5 更新后统计不可用的根因）。tracker 经 thunk 注入，装配前的搜索不计入。重启时从存储域恢复全部历史行。
- `storageDomain` / `connection` 始终缺席 → 统计 fiber 永不运行，统计静默停用（tracker = null）；服务中途消失 → fiber 销毁并释放 tracker，计数退回内存；打开失败 → 记 warn 后停用。三种情况搜索能力均不受影响——辅助能力降级，核心不降。

## 依赖面（升级稳定性契约，2026-11-24 审计）

目标是 prompt-dock 1.3.0 式的最小破坏面——只依赖官方 seam 与文档化服务，不碰内部实现细节：

- **服务端运行时导入恰好 4 个**，每个都不可再减：`schemastery`（Config 契约，全插件通用）、`dsh-web` 的 `WebError`（seam 错误分类法，自造 plain error 会脱离 seam 的错误归一）、`dsh-credentials` 的 `credentialRef`（单行品牌化校验，跟随 ref 格式演进——内联格式反而更脆）、`dsh-launch-environment` 的 `launchEnvironmentOf`（`~/.dsh/.env` 快照回退，`process.env` 不覆盖）。无 `node:` 导入、无 npm 运行时依赖、无构建步骤。
- **服务消费全部走文档化 seam**：`ctx.web.registerSearchProvider`、`storageDomain.open/table`、`connection.fetch.register`（`requestBody: 'buffered'` 的坑已测试固化）。统计装配用 `ctx.inject` fiber 等服务，不假设提供时序（rc.5 事故的教训）。
- **客户端零 `@deepseek-ai` 导入**：只 `require('react')`（宿主提供）；表单手写、样式只用文档化 `--dsw-*` 令牌。`dsh.client.inject` 声明的 `dsh-client-ui-plugin-manager` / `dsh-client-ui-settings` 是加载顺序声明（slots / configForms 服务来源），与 bark-notify 同款；`plugins.row.config` / `plugins.bundle.config` 插槽与 `configForms` 是社区契约（dsh-doc 未收录），实证 rc.1→rc.5 存活，属残余风险面——若未来 DSH 改动此处，退化形式是配置表单不可用，搜索功能不受影响。
- **版本声明策略**：`engines.dsh` 是 DSH 兼容预检的唯一闸门（存在时忽略 dsh peers，`includePrerelease`），故不声明 `@deepseek-ai/dsh-*` peers（避免宣称未测试的兼容区间）；schemastery 保留 peer（外部库、跨版本稳定）。升级 DSH 后需重验的检查点：本文件「开发」一节的测试命令 + 运行实例上 usage 路由 200。

## 安装（其他机器）

常规安装走 npm（见 README）；本机开发用软链接：

```sh
# 1. profile 依赖：在 ~/.dsh/profiles/web/package.json 加
#    "dsh-brave-search": "link:<本目录绝对路径>"
# 2. bundles 列表追加 "dsh-brave-search"
# 3. 在 profile 目录执行 pnpm install
# 4. 重启 dsh web
```

历史说明：本目录是开发检出（目录名已随包名改为 `dsh-brave-search`）；本机 profile 已改为直接消费 npm 包 `dsh-brave-search: ^1.1.0`，不再软链本目录——改本目录代码后需 `npm publish` 并更新 profile 依赖才能在运行实例生效（或临时切回 link 方式）。改名边界记录（2026-11-24，`@local/dsh-web-search-brave` → `dsh-brave-search`）：插件 id、locale/settings 命名空间、API 路由 `/api/brave-search/usage`、槽位键全部随新名；**存储域名 `web_search_brave` 与 CSS 前缀 `dswsb-` 保持不变**——前者保住既有统计数据，后者纯内部不可见（prompt-dock 同款先例）。seam 提供方 id `brave` 不变：它与社区插件的槽位相同，`searchProvider: brave` 的补丁写法两边通用（但同实例不可同装两者，会重复注册）。

## 开发

```sh
node --check index.js && node --check client.js      # 语法检查
node --import ./.test/register.mjs ./.test/run.mjs   # 宿主侧行为回归（本地 mock Brave 服务器）
TZ=America/New_York node --import ./.test/register.mjs ./.test/dst.mjs   # 7 天窗口的夏令时边界
node .test/client-module.mjs                         # 客户端模块注册模拟
```

`.test/hooks.mjs` 将裸导入 `@deepseek-ai/*` 映射到本机 dsh 安装目录，路径不同请自行调整。行为测试含一次刻意的在线探针（验证默认端点解析为 Brave 官方地址），离线机器上同样通过。

修改 bundle 补丁文件（`cordis.patch.yml`）后，运行中的进程不会自动重载（HMR 只监视 profile 清单与补丁层）：在 Plugins 页把 bundle 关一下再开（每次开关触发全量重组），或重启。
