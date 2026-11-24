# dsh-brave-search

**DeepSeek Harness 的 Brave 网页搜索提供方插件** —— 让内置的 `web_search` 工具跑在 Brave Search API 上，带插件页配置表单、使用统计与限速退避。

*A Brave Search provider for the DeepSeek Harness web capability seam (`ctx.web`): the built-in `web_search` tool runs on Brave's Search API, with a Plugins-page config form, usage statistics, and bounded rate-limit retry.*

简体中文 | [English](#english)

---

## 它解决什么问题

DSH 自带的网页搜索走 DeepSeek 系路由。如果你有 Brave Search 订阅（免费层每月 2,000 次），这个插件把 `brave` 注册为 `ctx.web` 的搜索提供方——模型看到的仍是同一个 `web_search` 工具，后端换成 Brave 的独立检索端点（无模型回合，快且省）。

## 功能

- **一键接入**：安装后在 Plugins 页把 `searchProvider` 钉到 `brave`，`web_search` 即刻换后端
- **插件页配置表单**：密钥、API 根地址（可走代理）、国家/语言、结果类型，保存即时生效，无需重启
- **使用统计**：今日/累计搜索、成功/失败/取消/限速、近 7 天柱状图、最近错误——数据存 Host 侧，重启不丢
- **凭据三级回退**：配置密钥 → 凭据服务（`BRAVE_API_KEY` 引用）→ 启动环境变量（含 `~/.dsh/.env`），每次搜索重新解析，改密钥不用重启
- **限速退避**：免费层 1 次/秒，429 自动重试恰好一次（可取消），持续限速以带指引的结构化错误失败
- **诚实的工具撤下**：未配置密钥时 `web_search` 自动从模型请求撤下，不让模型拿着不可用的工具空跑
- **中英文界面**跟随 DSH 语言设置；只用官方 `--dsw-*` 主题令牌

## 安装

前置：DeepSeek Harness ≥ 0.2.2-rc.5。

**方式一：npm（推荐）**

在「插件 → 添加插件」对话框里只填包名本身：

```
dsh-brave-search
```

或在终端：

```sh
dsh plugin --profile <你的profile> add dsh-brave-search
```

**方式二：本地目录（开发者）**

```sh
git clone https://github.com/ljgabc/dsh-brave-search.git && dsh plugin --profile <你的profile> add ./dsh-brave-search
```

> 安装或更新后需重启 DSH（profile 在启动期加载）。

## 配置

**Brave API 密钥**（必填其一）：在 [api-dashboard.search.brave.com](https://api-dashboard.search.brave.com/) 的 API Keys 页获取，填进插件页表单（写入 profile 补丁），或导出环境变量 `BRAVE_API_KEY`。

高级设置（默认折叠，均可留空）：

| 字段 | 说明 |
|---|---|
| API 根地址 | 默认 `https://api.search.brave.com/res/v1`；走代理时填同路径结构的地址 |
| 国家/地区代码 | ISO 3166 两位代码（如 `cn`、`us`），留空由 Brave 判定 |
| 搜索语言 | 如 `zh-hans`、`en`，留空由 Brave 判定 |
| 结果类型 | Brave `result_filter`，逗号分隔，默认 `web,news`，可加 `videos`、`discussions` |

钉扎说明：插件补丁层会把 `searchProvider` 钉为 `brave` 并同时重申 `fetchProvider: http`（补丁按整对象替换，漏写 fetch 钉扎会让每次 `web_fetch` 因多提供方竞争而失败）。想换回 DeepSeek 搜索，在用户补丁层覆盖 `id: web` 的 `searchProvider` 即可。

## 使用统计

打开 Plugins 页本插件卡片 → 配置，页面底部的「使用情况」面板展示实时计数与近 7 天分布。数据按本地日存 Host 侧存储域，统计永远不会延迟或失败一次搜索（fire-and-forget 落盘）；统计不可用时只降级自身，搜索不受影响。

## 兼容性

- 针对 DSH 0.2.2-rc.5 开发并测试（含 rc.5 组合下统计服务晚于 web seam 激活的适配）。
- 同一 DSH 实例上不要同时安装其他注册 `brave` 提供方 id 的插件（会以重复提供方失败）。

## License

[MIT](LICENSE)
