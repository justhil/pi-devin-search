# pi-devin-search

Pi 扩展：直接调用 Devin/Windsurf 的原生 `GetWebSearchResults` 搜索接口。

它面向快速、精准的信源定位：返回标题、URL 和上游摘要，适合先找到官方页面、仓库、issue、release note 或少量相关链接。需要综合回答、广泛调研或多来源分析时，继续使用 `pi-search` 的 `search`；详细 SDK/API 文档使用 `docs_search`；读取具体页面使用 `web_fetch`。

## 功能

- 快速、精准定位官方页面、仓库、issue、release note 和相关链接
- 与 `pi-search` 分工：本工具找信源，`search` 做综合研究，`docs_search` 查技术文档，`web_fetch` 读取页面
- 工具：`devin_search`
- 命令：`/devin-search <query>`
- 配置向导：`/devin-search-config`
- 状态：`/devin-search-status`
- 自动导入：`/devin-search-import-key`
- 连通测试：`/devin-search-config test [query]`
- 自动读取已登录的 Devin 或 Windsurf 桌面端 `state.vscdb`
- 支持项目配置和全局配置
- 两个上游 host 自动回退

## 安装

本地开发：

```bash
cd D:/workspace/pi-ext/pi-devin-search
npm install
pi -e .
```

也可以安装为本地 Pi package：

```bash
pi install D:/workspace/pi-ext/pi-devin-search
```

安装后重启 Pi，或在支持热加载的位置使用 `/reload`。

## 认证

凭证按以下顺序解析：

1. `DEVIN_SEARCH_API_KEY` / `WINDSURF_API_KEY` / `WINDSURFAPI_CODEIUM_API_KEY`
2. 项目配置 `.pi/devin-search.json`
3. 全局配置 `~/.pi/agent/devin-search.json`
4. Devin 桌面端 `state.vscdb`
5. Windsurf 桌面端 `state.vscdb`

常见 token 形态：

```text
devin-session-token$...
```

交互式导入并保存凭证：

```text
/devin-search-config
/devin-search-config import
/devin-search-import-key
```

推荐保存到全局配置。保存到项目配置前会二次确认，覆盖已有凭证前也会确认。

如果数据库不在默认位置，可在配置向导中设置，或使用：

```bash
DEVIN_SEARCH_DB_PATH=/path/to/state.vscdb
```

插件不会把完整 token 写入工具输出或状态面板。

## 使用

让模型调用：

```text
用 devin_search 搜索 Pi extension registerTool 的官方资料
```

手动命令：

```text
/devin-search Pi coding agent extension registerTool
/devin-search-status
/devin-search-config
/devin-search-config status
/devin-search-config test
/devin-search-config global
/devin-search-config project
/devin-search-config clear
```

工具参数：

- `query`：必填，搜索关键词
- `limit`：可选，1–10，默认 5
- `domain`：可选，限制域名，例如 `github.com`

## 开发验证

```bash
npm run check
```

只在人工明确测试时建议进行真实联网调用；单元测试默认不访问生产接口。

上游协议参考与归属见 [NOTICE.md](NOTICE.md)。

## 风险说明

这是非官方插件，会使用本机 Devin/Windsurf 登录会话访问云端接口。上游协议、账号策略或服务条款变化都可能导致失效。不要提交或共享 session token。
