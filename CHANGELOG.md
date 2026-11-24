# Changelog

## 1.1.0

- **补丁层不再钉扎 `searchProvider`**：安装只注册 `brave` 提供方，不改任何全局默认。此前 bundle 层自带钉扎会让"装了插件但没配密钥"的用户 `web_search` 整体撤下（`ready()=false` → 工具撤下契约），且提供方选择按 DSH rc.4 起的立场属于部署决策而非包决策。选 Brave：设置页菜单（推荐）/ 用户补丁（须同时重申 `fetchProvider`）/ `$DSH_WEB_SEARCH_PROVIDER`。从 1.0.0 升级且依赖自带钉扎的用户：在设置页选一次 Brave，或把钉扎写进用户补丁。

## 1.0.0

首次公开发布（此前为自用包 `@local/dsh-web-search-brave`；npm 上 `dsh-web-search-brave` 已有社区的同类插件，公开名故取 `dsh-brave-search`）。

- Brave Search 提供方：注册 `brave` 搜索提供方，`web_search` 走 Brave 独立检索端点；按 URL 去重，HTML 实体反转义，`page_age` 仅在 ISO 8601 形态时透传。
- 插件页配置表单：密钥常显 + 高级设置折叠（API 根地址/国家/语言/结果类型），保存即时生效。
- 使用统计：今日/累计/近 7 天面板，Host 侧存储域持久化（域名 `web_search_brave`，改名后延续既有数据），只读认证路由供客户端读取。
- 凭据三级回退：配置密钥 → 凭据服务 → 启动环境（`BRAVE_API_KEY`），每次搜索重新解析。
- 限速处理：429 自动重试恰好一次（约 1.1s 退避、可取消），命中即计数，持续限速以结构化错误失败并附指引。
- 适配 DSH 0.2.2-rc.5：组合中 `connection` 晚于 web seam 激活，统计装配改为 `ctx.inject(['storageDomain', 'connection'])` 等待式 fiber（修复更新后统计不可用），服务始终缺席时按契约静默停用，搜索不受影响。
- 未配置密钥时 `web_search` 自动撤下（`ready()` 契约），不做隐式回退。
