# dsh-web-search-brave

DSH 插件：把 [Brave Search API](https://api-dashboard.search.brave.com/) 注册为搜索提供方，模型的原生 `web_search` 工具由 Brave 驱动——直连 REST 端点、无模型轮次消耗，结果为结构化来源（URL、标题、摘要、发布日期）。安装后即为默认搜索引擎；未配置密钥时 `web_search` 自动从模型请求中撤下，不会误导模型。

## 配置

插件 → Brave 网页搜索 → 配置（保存即时生效，无需重启）：

| 字段 | 说明 |
|---|---|
| Brave API 密钥 | [API 控制台](https://api-dashboard.search.brave.com/) API Keys 页的订阅密钥；留空回退环境变量 `BRAVE_API_KEY` |
| API 根地址 | 默认 `https://api.search.brave.com/res/v1`，留空自动；走代理时填同路径结构 |
| 国家/地区代码 | ISO 3166 两位代码（如 `cn`、`us`）；留空由 Brave 自动判定 |
| 搜索语言 | 如 `zh-hans`、`en`；留空自动 |
| 结果类型 | 逗号分隔；默认 `web,news`，可加 `videos`、`discussions` |

> 真实密钥不要写进本仓库。等价方式：写进用户补丁层（`~/.dsh/profiles/web/cordis.patch.yml`）的 `- id: web-search-brave, config: { apiKey: … }`，或导出 `BRAVE_API_KEY`（含 `~/.dsh/.env`，重启后生效）。

配置卡片底部是**使用情况**：今日与累计搜索、成功 / 失败 / 取消、限速命中、近 7 天分布、最近搜索与最近错误。统计按本地日持久保存，重启不丢；存储服务缺失时统计自动停用，搜索不受影响。

## 切换与停用

- 换回 DeepSeek 搜索：用户补丁层覆盖 `- id: web, config: { searchProvider: deepseek-official }`（或 `deepseek-search-api`）。
- 停用请用 **bundle 级开关**（整层退出、自动回退官方搜索）；**不要用插件条目级 disable**——钉扎残留会让每次搜索报错。

选择机制、停用语义的完整说明与安装、开发细节见 [DEVELOPMENT.md](DEVELOPMENT.md)。
