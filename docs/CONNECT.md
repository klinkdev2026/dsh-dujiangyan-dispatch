# 接入指南：让任意 AI 客户端驱动都江堰

都江堰在本机开放一个标准的 **MCP 服务**。任何支持“HTTP 方式的 MCP 服务器 + 自定义请求头”的客户端都能接入，包括 Claude Code、Codex、Kimi Code、智谱的客户端、pi agent、Cursor、Cline 等。

各家客户端的配置方式都不一样，我们不可能逐一替你写好。所以推荐的做法是：**把下面这句话交给你正在用的 agent，让它按自己客户端的方式完成接入。**

---

## 第 0 步：确认插件在运行

1. 打开 **DeepSeek Harness 桌面版**，左侧栏应该有 **都江堰** 图标。
   - 如果没有：先按 README 的“快速开始”装好插件并配置 `workspaceRoots`，然后**完全退出桌面版**（托盘图标也要退出），再重新打开。
2. 之后整个使用过程中，**桌面版要一直开着**。插件运行在桌面版里，桌面版一关，所有客户端都连不上。

插件每次启动都会在你的用户目录下生成三个文件：

| 文件 | 内容 |
|---|---|
| `~/.dsh/dujiangyan/CONNECT.md` | **写给 agent 的接入说明**，包含这台机器上实际的地址和步骤 |
| `~/.dsh/dujiangyan/endpoint.json` | 服务地址，默认 `http://127.0.0.1:8790/mcp` |
| `~/.dsh/dujiangyan/token` | 访问令牌。**不要发给别人，也不要贴进聊天** |

`~` 指你的用户目录：Windows 上是 `C:\Users\<用户名>`，macOS 上是 `/Users/<用户名>`，Linux 上是 `/home/<用户名>`。

---

## 第 1 步：让你的 agent 自己接上（推荐）

在你要用的客户端里（Claude Code、Codex、Kimi Code、智谱、pi 等都行），把下面这段话原样发给 agent：

> 请阅读 `~/.dsh/dujiangyan/CONNECT.md`，按里面的说明把你所在的 MCP 客户端接入都江堰（服务名 djy）。不要在对话里显示令牌。接好后调用 djy_status 告诉我版本号，然后调用 djy_guide。

agent 会依次完成：
1. 判断自己运行在哪个客户端里，找到这个客户端的 MCP 配置位置；
2. 从令牌文件读出令牌，只写进配置，不在对话里显示；
3. 修改配置前先备份；
4. 重新加载连接，调用 `djy_status` 验证是否接通。

**如果 agent 说它的客户端不支持给 HTTP MCP 服务器加请求头**：说明这个客户端暂时接不上，见文末“只支持 stdio 的客户端”。

---

## 第 2 步：确认接上了

接通后，`djy_status` 会返回版本号，比如 `0.1.1`。你也可以直接看桌面版的 **都江堰** 面板：以后由这个 agent 派出的会话，标题会带上它的名字作为前缀，比如 `[claude]`、`[codex]`、`[kimi-code]`。

---

## 第 3 步：开始用

例如对 agent 说：

> 用 djy 开一个 implementer 会话，工作目录 D:/work/my-project，让它列出项目结构并写一份 NOTES.md。

- 派出去的会话会出现在桌面版的 **都江堰 → 会话与任务** 里；
- 需要审批的操作，你可以在面板的 **待审批** 页自己点“批准”或“拒绝”；
- 路径用正斜杠（`D:/work/x`），可以少碰到转义问题；
- 会话可以反复复用，不需要做完一个任务就关掉。

---

## 参考：几个已验证客户端的手动配置

如果你想自己动手，或者 agent 需要一个参考写法，可以照下面的来。`<令牌>` 指 `token` 文件里的那一行。

| 客户端 | 配置写在哪里 | 写法 |
|---|---|---|
| Claude Code | 用命令添加（用户级） | `claude mcp add --transport http --scope user djy http://127.0.0.1:8790/mcp --header "Authorization: Bearer <令牌>"` |
| Codex（CLI 和桌面版共用） | `~/.codex/config.toml` | 见下方 TOML |
| Kimi Code | `~/.kimi-code/mcp.json` | 见下方 JSON |

```toml
# ~/.codex/config.toml
[mcp_servers.djy]
url = "http://127.0.0.1:8790/mcp"
http_headers = { Authorization = "Bearer <令牌>" }
tool_timeout_sec = 120
```

```json
// ~/.kimi-code/mcp.json
{
  "mcpServers": {
    "djy": {
      "transport": "http",
      "url": "http://127.0.0.1:8790/mcp",
      "headers": { "Authorization": "Bearer <令牌>" },
      "toolTimeoutMs": 120000
    }
  }
}
```

**其他客户端**（智谱、pi、Cursor、Cline、Zed 等）：在它的 MCP 设置里新增一个服务器，填这四项：

| 项 | 值 |
|---|---|
| 类型 / transport | HTTP（也可能叫 Streamable HTTP）。**不要选 stdio，也不要选 SSE** |
| 地址 | `http://127.0.0.1:8790/mcp` |
| 请求头 | `Authorization: Bearer <令牌>` |
| 超时 | 120 秒以上 |

---

## 只支持 stdio 的客户端

有的客户端只能“本地拉起一个命令”来连接 MCP，不能连 HTTP 地址，这类客户端目前接不上。如果你需要用这样的客户端，请提 issue，我们会补一个把 stdio 转成 HTTP 的小程序。

---

## 常见问题

| 现象 | 原因和处理 |
|---|---|
| 找不到 `~/.dsh/dujiangyan/` 目录 | 桌面版没打开、插件没启用，或者没配置 `workspaceRoots`。回到第 0 步检查 |
| 连接被拒，返回 401 | 令牌不对。让 agent 重新读一遍令牌文件；令牌只有在文件被删除后才会变 |
| 连接被拒，返回 403 | 请求带了浏览器才会发的 `Origin` 头，插件出于安全考虑一律拒绝。换用非浏览器的客户端 |
| 连接被拒，或者连接超时 | 桌面版没在运行；或者端口被改过，看 `endpoint.json` 里的实际地址 |
| Codex 桌面版看不到 djy | 改完配置后要**完全退出 Codex**，再重新打开 |
| 两个客户端都在线，审批被对方先处理了 | 以先到的决定为准。建议只让一个客户端负责审批，或者你自己在面板上审批 |
| 想取消接入 | 删掉客户端配置里名为 `djy` 的那一项即可。比如 Claude 用 `claude mcp remove djy --scope user`，Codex 用 `codex mcp remove djy` |
