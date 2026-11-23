# dsh-web-search-brave — 机制与开发文档

面向维护者的深度文档：seam 契约、选择机制、停用语义、安装与测试。插件页不渲染任何 README（已删除；locale 卡片描述是页面上唯一的说明文字），本文档是唯一的完整文档。

## 工作原理

- 注册进 `ctx.web` 搜索提供方注册表，id 为 `brave`；`dsh-tool-web` 渲染的 `web_search` 工具经 seam 调用它。
- `dsh-base` 默认把 `searchProvider` 钉在 `deepseek-official`；本插件发布的补丁层把 `web` 实例改钉为 `brave`（后列 bundle 层覆盖先列，profile 用户补丁层覆盖一切）。
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
| 未设置，多个可用 | `WEB_PROVIDER_AMBIGUOUS`（本 profile 注册了 3 个搜索提供方，钉扎因此必要） |
| 未设置，无可用 | `WEB_PROVIDER_UNAVAILABLE` |

另一个刻意行为：选中的提供方没有凭据时（`ready()` = false），`web_search` 整个从模型请求中撤下，**不会静默回退**到其他提供方——诚实的不可用优于隐式降级。

## 切换搜索引擎

本插件的补丁层把 `searchProvider` 钉到了 `brave`，并**同时重申 `fetchProvider: http`**——补丁条目按"整对象替换"组合，漏写会把 dsh-base 的抓取钉扎顶掉，导致两个抓取提供方（`http`、`deepseek-fetch-api`）无钉扎竞争、每次 `web_fetch` 以 `WEB_PROVIDER_AMBIGUOUS` 失败（此 bug 曾实际发生并已修复）。想换抓取后端时在用户层一并覆盖。三种切换方式写的都是同一个字段：

```yaml
# 方式一：用户补丁层覆盖（~/.dsh/profiles/web/cordis.patch.yml，用户层覆盖一切 bundle 层）
- id: web
  name: "@deepseek-ai/dsh-web"
  config:
    searchProvider: deepseek-official   # 或 deepseek-search-api（建议同时 fetchProvider: deepseek-fetch-api）
```

方式二：GUI 的 **Plugins > 内置插件配置 > 网页搜索** 设置页切换（保存写回同一配置；开关仅在 Host 同时服务 `web` 与 `web-deepseek-api` 命名空间时显示）。

方式三：`DSH_WEB_SEARCH_PROVIDER=deepseek-official dsh web`。注意其兜底语义是 `配置值 ?? 环境变量`（见 dsh-web 源码 `selectSearchProvider`）：本插件的补丁层已把字段钉为 `brave`，配置值存在时环境变量**不生效**；只有组合配置未钉扎该字段时它才接管。

## 停用本插件时的两种开关，行为完全不同

- **Bundle 级开关**（Plugins 页里 `@local/dsh-web-search-brave` 这一层 / `set_bundle`）：整层补丁退出组合——**连同 `searchProvider: brave` 钉扎一起消失**，`dsh-base` 的 `deepseek-official` 钉扎重新生效，自动回退。依赖保留在 node_modules，随时可再启用。已实测验证。
- **插件条目开关**（条目上的 disable / `set_plugin`）：只给 `web-search-brave` 条目写 `disabled: true`，本插件不加载；但补丁层里**独立的 `id: web` 钉扎条目仍然生效**——`searchProvider: brave` 指向一个未注册的提供方，每次 `web_search` 以 `WEB_PROVIDER_CONFIGURED_MISSING` 结构化失败（且工具仍会出现：选择失败时 `searchReady` 按契约回答 true）。**这是坏状态，不是回退。**

要停用 Brave 但保留插件，用方式一在用户层改钉 `searchProvider` 即可；条目级 disable 前必须同时改钉，否则搜索直接报错。

## 配置

插件页 → Brave 网页搜索 → 配置（保存即时生效，无需重启）。表单分三节：密钥常显；高级设置默认折叠；使用情况为只读展示。保存按钮在可编辑区末尾（高级设置之后），无论折叠与否都无需回滚查找。

| 字段 | 说明 |
|---|---|
| Brave API 密钥 | [API 控制台](https://api-dashboard.search.brave.com/) API Keys 页的订阅密钥；留空回退环境变量 `BRAVE_API_KEY` |
| API 根地址 | 默认 `https://api.search.brave.com/res/v1`，留空自动；走代理时填同路径结构 |
| 国家/地区代码 | ISO 3166 两位代码（如 `cn`、`us`）；留空由 Brave 自动判定 |
| 搜索语言 | 如 `zh-hans`、`en`；留空自动 |
| 结果类型 | Brave `result_filter`，逗号分隔；默认 `web,news`，可加 `videos`、`discussions` |

> 真实密钥不要写进本仓库。等价方式：写进用户补丁层（`~/.dsh/profiles/web/cordis.patch.yml`）的 `- id: web-search-brave, config: { apiKey: … }`，或导出 `BRAVE_API_KEY`（含 `~/.dsh/.env`，重启后生效）。

## 使用统计

- 内存优先计数 + fire-and-forget 落盘：统计永不延迟、永不失败一次搜索；持久化失败仅记 warn。
- 存储域 `web_search_brave`（表 `days`，版本 1）：每个本地日一行 `{ date, searches, successes, failures, aborted, rateLimited, sources, updatedAt }`，严格 schema 校验，损坏即响亮失败。
- 埋点分两层：`apply` 注册的 search wrapper 记入口 / 成功（含来源数）/ 失败（记 lastError，消息截断 300 字符）/ 取消（独立计数，不覆盖 lastError）；provider 内部仅在 429 响应处记限速命中（只有该层知道）。
- 读取走只读认证路由 `GET /api/web-search-brave/usage`，返回 `{ today, total, last7（零填充连续 7 天）, lastSearchAt, lastError }`。
- `apply` 只注册搜索提供方；统计在嵌套 inject fiber（`ctx.inject(['storageDomain', 'connection'])`）中装配——组合可能在 web seam 释放本插件**之后**才提供这两个服务（0.2.2-rc.5 起 connection 晚于 web 激活），一次性 `ctx.get` 快照会静默错过（rc.5 更新后统计不可用的根因）。tracker 经 thunk 注入，装配前的搜索不计入。重启时从存储域恢复全部历史行。
- `storageDomain` / `connection` 始终缺席 → 统计 fiber 永不运行，统计静默停用（tracker = null）；服务中途消失 → fiber 销毁并释放 tracker，计数退回内存；打开失败 → 记 warn 后停用。三种情况搜索能力均不受影响——辅助能力降级，核心不降。

## 安装（其他机器）

```sh
# 1. profile 依赖：在 ~/.dsh/profiles/web/package.json 加
#    "@local/dsh-web-search-brave": "link:<本目录绝对路径>"
# 2. bundles 列表追加 "@local/dsh-web-search-brave"
# 3. 在 profile 目录执行 pnpm install
# 4. 重启 dsh web
```

## 开发

```sh
node --check index.js && node --check client.js      # 语法检查
node --import ./.test/register.mjs ./.test/run.mjs   # 宿主侧行为回归（本地 mock Brave 服务器）
TZ=America/New_York node --import ./.test/register.mjs ./.test/dst.mjs   # 7 天窗口的夏令时边界
node .test/client-module.mjs                         # 客户端模块注册模拟
```

`.test/hooks.mjs` 将裸导入 `@deepseek-ai/*` 映射到本机 dsh 安装目录，路径不同请自行调整。行为测试含一次刻意的在线探针（验证默认端点解析为 Brave 官方地址），离线机器上同样通过。

修改 bundle 补丁文件（`cordis.patch.yml`）后，运行中的进程不会自动重载（HMR 只监视 profile 清单与补丁层）：在 Plugins 页把 bundle 关一下再开（每次开关触发全量重组），或重启。
