# dsh-web-search-brave

把 [Brave Search API](https://api-dashboard.search.brave.com/) 注册为 DSH 的搜索提供方（`brave`）：模型的原生 `web_search` 工具改由 Brave 直连驱动，无模型轮次消耗，结果为结构化来源。装好密钥即为默认搜索引擎；未配置密钥时工具自动撤下。

- **配置**：插件页 → Brave 网页搜索 → 配置，填入 API 密钥（[API 控制台](https://api-dashboard.search.brave.com/) 的 API Keys 页获取），保存即时生效
- **切换 / 停用**：停用请用 bundle 级开关（自动回退官方搜索）；切换后端在用户补丁层覆盖 `searchProvider`，详见开发文档
- **机制、字段说明、安装与开发**：见 [DEVELOPMENT.md](DEVELOPMENT.md)
