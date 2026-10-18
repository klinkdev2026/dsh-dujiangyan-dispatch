<p align="right"><strong>简体中文</strong> · <a href="./README.en.md">English</a></p>

<p align="center">
  <img src="./assets/hero.zh.png" width="100%" alt="都江堰：用任意 AI 客户端，通过一道闸门，指挥任意数量、任意模型的 DeepSeek Harness agent">
</p>

<p align="center">
  <a href="https://github.com/klinkdev2026/dsh-dujiangyan-dispatch/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/klinkdev2026/dsh-dujiangyan-dispatch/ci.yml?branch=main&style=flat-square&label=CI" alt="CI"></a>
  <img src="https://img.shields.io/badge/version-0.1.0--alpha.1-0B7285?style=flat-square" alt="version">
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-%E2%89%A50.2.1--rc.2-4D8DFF?style=flat-square" alt="DeepSeek Harness >= 0.2.1-rc.2">
  <img src="https://img.shields.io/badge/MCP-Streamable%20HTTP-5FE0C0?style=flat-square" alt="MCP">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-6F93A6?style=flat-square" alt="platforms">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-2E8B57?style=flat-square" alt="MIT"></a>
</p>

<h3 align="center">让 Claude Code、Codex、Kimi Code……指挥一整支 DeepSeek Harness 军团。<br>每一次工具调用都过闸门，每一个 API key 都不被冲垮。</h3>

---

你在 Claude Code 里说一句：

> 开 3 个 flash 写代码，1 个 kimi 审核，干完把结果汇总给我。

**都江堰**会在你正在运行的 **DeepSeek Harness 桌面版**里拉起这些 agent，然后接管所有麻烦的事：

| | |
|---|---|
| 🧭 **任意客户端都能指挥** | Claude Code、Codex、Kimi Code、智谱、pi、Cursor……只要支持 MCP，就能派活、看进度、做审批 |
| 🌊 **任意数量、任意模型** | 会话数不设上限；每个角色配一条模型链（DeepSeek、Kimi、GLM、Qwen、任意 OpenAI 兼容中转都行），坏了自动换下一个 |
| 🛡️ **每一次工具调用都过闸门** | 安全的直接放行，危险的拒绝并说明理由，拿不准的交给 AI 审批人，AI 也拿不准再交给你。agent 自己拉起的子 agent 也逃不掉 |
| 🚰 **按 key 准入，不冲垮你的额度** | 每家 key 单独限并发、错峰发送、遇到 429 自动收窄、熔断后切备用模型、恢复后切回 |
| 🔒 **独占资源排队** | 跑基准测试时独占机器，别的 agent 的编译不会来抢 CPU |
| 👀 **全程看得见** | 桌面版左侧栏多一个“都江堰”面板：会话、任务、闸门记录、待审批、渠道健康，一目了然；每个 agent 都是普通会话，随时点开看 |

<p align="center">
  <img src="./assets/screenshots/overview.zh.png" width="100%" alt="都江堰面板：概览">
  <br><sub>桌面版里的都江堰面板（演示数据）：3 个客户端派出的 10 个会话、4 家渠道的并发和熔断状态、最近的闸门决定</sub>
</p>

## 它由两半组成

都江堰装一次，就同时有两张面孔：

| | 🏯 **DSH 这一半：插件** | 🤖 **agent 这一半：MCP 服务** |
|---|---|---|
| 给谁用 | 你，在 DeepSeek Harness 桌面版里 | 你的 AI 客户端（Claude Code、Codex、Kimi Code……） |
| 做什么 | 闸门拦截每一次工具调用、按 key 准入、模型路由、独占锁；左侧栏的审查面板 | 17 个 `djy_*` 工具：开会话、派任务、看进度、做审批、查渠道；外加写给 agent 的接入说明 `CONNECT.md` |
| 在哪里 | 运行在桌面版进程里 | 同一个进程开在 `127.0.0.1:8790/mcp`，令牌鉴权 |

两半是同一个包，不需要分开安装：MCP 服务要靠插件的钩子才能创建会话、拦截调用、限流，所以它们必须在同一个进程里。

## 目录

- [为什么叫都江堰](#为什么叫都江堰)
- [和同类项目有什么不同](#和同类项目有什么不同)
- [快速开始](#快速开始)
- [飞沙堰：权限闸门](#飞沙堰权限闸门)
- [宝瓶口：准入控制](#宝瓶口准入控制)
- [鱼嘴：多模型路由](#鱼嘴多模型路由)
- [桌面面板](#桌面面板)
- [平台与客户端支持](#平台与客户端支持)
- [配置参考](#配置参考) · [MCP 工具](#mcp-工具) · [安全](#安全) · [排错](#排错)
- [路线图](#路线图) · [从源码构建](#从源码构建) · [致谢](#致谢)

## 为什么叫都江堰

都江堰是两千多年前修建、至今仍在灌溉成都平原的水利工程。它没有用一道大坝把岷江拦死，而是**分流、排沙、限量**，这叫“无坝引水”。

**都江堰保护的是平原，不是江。** 放到这里：

- **江水**是一群 agent 同时涌出的请求和操作；
- **平原**是你自己这一侧：API key 的并发和额度、你的钱、你的电脑（编译和基准测试会互相抢 CPU）、你的项目文件，还有你的注意力（审批请求不能一下子全涌给你）。

同时开 10 个 agent 冲不垮任何一家厂商，却很容易冲垮你这一侧。

| 都江堰的部件 | 在都江堰里做什么 | 在本插件里做什么 |
|---|---|---|
| **鱼嘴** | 江心的分水堤，把岷江分成内江和外江 | **多模型路由**：每个角色一条模型链，请求走第一个健康的模型 |
| **飞沙堰** | 洪水和泥沙从这里溢出排走 | **权限闸门 + 熔断**：危险操作在这里被拦下；出故障的渠道被暂时撤下 |
| **宝瓶口** | 控制进入灌区的水量 | **准入控制**：按 key 限并发；遇到限流自动收窄，恢复后逐步放开 |
| **灌区** | 被灌溉的成都平原 | **agent 干活的地方**：会话、任务队列、独占锁 |

“无坝引水”也是闸门的设计原则：确定安全的直接放行，确定危险的直接拒绝并说明理由，只有中间的灰色地带才交给审批。**疏导，而不是拦死。**

## 和同类项目有什么不同

DeepSeek Harness 社区已经有不少优秀的多 agent 插件。都江堰不在 DSH 内部再造一个“队长”，而是解决另一件事：**让外部的 AI 客户端安全地指挥 DSH**。

| | **都江堰** | dsh-agent-teams | dsh-crew | dsh-harness-mcp-server |
|---|---|---|---|---|
| 谁来指挥 | **任意 MCP 客户端**（Claude Code、Codex、Kimi Code……），可以同时多个 | DSH 里的队长会话 | Claude / Codex | 任意 MCP 客户端 |
| agent 数量 | **不设上限**，请求在准入层统一限流 | 默认最多 8 名成员（可调） | — | 不限 |
| 多模型 | ✅ 每个角色一条模型链，自动跳过坏路由、故障切换 | ✅ 每个成员可指定模型 | — | — |
| 每次工具调用的权限闸门 | ✅ 放行 / 拒绝并说明 / 转审批，覆盖子 agent | 按成员的工具策略（其文档说明不是授权边界） | ❌ | ❌ |
| 审批 | ✅ AI 审批人 → 再交给你（面板一键决定） | 成员需要审批的操作会被自动拒绝 | ❌ | ❌ |
| 按 key 准入、429 收窄、熔断切换 | ✅ | ❌ | ❌ | ❌ |
| 独占资源锁 | ✅ | ❌ | ❌ | ❌ |
| 鉴权 | ✅ 仅本机 + Bearer 令牌 + 防 CSRF | — | ❌ HTTP 无鉴权 | ❌ |
| 任务依赖图、成员互发消息 | ❌（交给指挥方） | ✅ 这是它的强项 | — | — |
| 平台 | Windows / macOS / Linux | 跨平台 | 仅 POSIX | 跨平台 |

> 两者并不冲突：dsh-agent-teams 擅长在 DSH 内部做依赖图式的团队协作；都江堰擅长把 DSH 变成外部 agent 可以安全调用的“算力军团”。

## 快速开始

### 1. 安装

> ⏳ **npm 发布进行中。** 发布后在桌面版 **插件 → 添加插件** 输入 `dsh-dujiangyan-dispatch` 即可一键安装。在那之前，请用下面的命令行方式或[从源码构建](#从源码构建)。

**命令行安装**（先**完全退出桌面版**，包括托盘图标）：

```powershell
# Windows
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add github:klinkdev2026/dsh-dujiangyan-dispatch
```

```bash
# macOS / Linux：使用桌面版安装目录里的 resources/runtime/cli/bin/dsh
<安装目录>/resources/runtime/cli/bin/dsh plugin --profile desktop add github:klinkdev2026/dsh-dujiangyan-dispatch
```

> 必须使用桌面版自带的 `dsh`。用 npm 全局安装的 `dsh` 管不了桌面版的配置。

### 2. 指定工作区（必填）

编辑 `~/.dsh/profiles/desktop/cordis.patch.yml`，在末尾追加，指定 agent 可以写入的目录：

```yaml
- id: dujiangyan-dispatch
  name: dsh-dujiangyan-dispatch
  config:
    workspaceRoots:
      - 'D:\work\my-project'      # macOS/Linux 例如 /home/me/my-project
```

不配置 `workspaceRoots`，所有会话都会被拒绝。改完后重启桌面版，左侧栏会出现 **都江堰** 图标。

### 3. 让你的 AI 客户端接上

插件启动后，会在 `~/.dsh/dujiangyan/CONNECT.md` 生成一份**写给 agent 看的接入说明**。你只要在正在用的客户端里（Claude Code、Codex、Kimi Code、智谱、pi 都行）对 agent 说：

> 请阅读 `~/.dsh/dujiangyan/CONNECT.md`，按说明把你所在的 MCP 客户端接入都江堰（服务名 djy）。不要显示令牌。接好后调用 djy_status 告诉我版本号。

它会按自己客户端的配置方式完成接入，令牌只写进配置，不在对话里显示。想自己动手，或者想看已验证客户端的写法，见 **[docs/CONNECT.md](docs/CONNECT.md)**。

### 4. 派出第一个任务

> 用 djy 开一个 implementer 会话，工作目录 D:/work/my-project，让它列出项目结构，并写一份 NOTES.md。

agent 会先调用 `djy_guide` 读使用手册，然后创建会话、提交任务、跟踪进度、处理审批。打开桌面版的 **都江堰** 面板，就能看到它在干什么。

> 💡 **会话是长期存在的“工人”，不要做完一个任务就关掉。** 同一个会话上的任务按顺序执行并保留上下文；后续工作先用 `djy_session_list` 找到已有会话复用。

## 飞沙堰：权限闸门

<p align="center"><img src="./assets/gate.zh.png" width="100%" alt="飞沙堰：权限闸门流程"></p>

闸门只作用于**都江堰派出的会话和它们的子 agent**；你在桌面版里手动开的会话完全不受影响。

| 档位 | 内容 |
|---|---|
| ✅ **自动放行** | 读文件、搜索；在工作区内写和改文件；`cargo` / `python` / `node` / `cmake` 等构建运行；`git status/diff/add/commit` 等本地操作；只读的 shell 命令；工作区里自己的脚本 |
| ⛔ **拒绝，并告诉 agent 为什么** | 写工作区以外；读凭据文件、打印含 key 的环境变量；全局或系统级安装；改注册表、`setx`；**改 ACL、完整性标签或沙箱设置**（属于环境问题，应交给你处理）；`git push`、改远程仓库；向外上传数据；`run_code`（它的程序体不经过闸门）；agent 自行拉起子 agent；改插件或 Harness 配置；没拿到 bench 锁就跑基准测试 |
| ❓ **交给审批** | 其余所有调用：网络访问、`pip/npm install`、`git clone`、动态执行代码、目标无法确定的删除、不认识的命令 |

- **审批顺序**：先交给接入的 AI 客户端（它应当自己核实，而不是相信 worker 的说法）；也可以你自己在面板上点“批准”或“拒绝”。先到的决定生效，审计日志记录是谁做的决定。
- **审批超时**（默认 15 分钟）后：根会话交给桌面版自己的审批弹窗；子 agent 的审批策略固定为 `never`，所以直接拒绝。
- 拒绝理由会原样回给 agent，它会改用正确的做法，而不是想办法绕过去。

<p align="center"><img src="./assets/screenshots/approvals.zh.png" width="100%" alt="待审批页面"></p>

## 宝瓶口：准入控制

<p align="center"><img src="./assets/admission.zh.png" width="100%" alt="宝瓶口：准入控制"></p>

**会话数、任务数和请求并发是三件不同的事：**

- **会话数**：有多少个“工人”。**不限**，闲着的会话不花钱。
- **任务数**：每个会话上排着多少活。**不限**，同一会话上的任务按顺序执行。
- **请求并发**：同一时刻有多少个请求打到某家 API。**只有这一层需要控制。**

所以同时开 100 个会话一起干活也没问题：所有请求都经过宝瓶口，按每个 key 的承受能力放行。在个人使用的规模下，真正的瓶颈是你自己的 key，中转网关的 key 常常只允许 3–5 个并发。默认行为：

- 按 provider 限制并发：`deepseek-official` 8 个，其余默认 4 个。请按你的 key 的实际限制调整。
- 遇到 429 或过载，并发上限减半；连续成功 20 次后加 1。
- 优先遵守服务端的 `Retry-After`；请求之间默认间隔 150 ms，外加最多 250 ms 的随机抖动。
- 连续 5 次被限流或过载就熔断 2 分钟：期间请求沿模型链切到备用模型；冷却结束后先放一个请求试探，成功就切回首选模型。
- 每分钟请求数（RPM）限制、错峰预热默认关闭，需要时可以打开。

## 鱼嘴：多模型路由

每个角色一条模型链，写在前面的优先：

```yaml
roster:
  implementer:
    - { provider: deepseek-official, model: deepseek-flash }
    - { provider: my-relay, model: qwen-coder }          # 备用
  reviewer:
    - { provider: moonshot, model: kimi-latest }
    - { provider: deepseek-official, model: deepseek-v4-pro }
```

- 模型链里的 provider 和模型，就是你在桌面版里已经配好的那些，不用再配一遍 key。可以用 `djy_models` 查看。
- `djy_routes_probe` 用一个极小的真实请求逐个检查模型是否真能用。渠道目录里列出来、实际一调就失败的模型（比如 API 格式不匹配）会被停用 30 分钟，会话自动跳过它。
- 运行中遇到确定性错误（400/401/403/404/422，因上下文过长导致的 400 除外），这条路由会被停用，当前这一步沿模型链换下一个模型重试。

## 桌面面板

安装后，桌面版左侧栏会多出 **都江堰** 入口，有五个页签：

| 页签 | 内容 |
|---|---|
| **概览** | 会话数（按创建者统计）、运行中的任务、待审批数、独占锁；各渠道的并发、排队和熔断状态；最近的事件 |
| **会话与任务** | 按**批次**分组（一个客户端的一次运行算一批，也可以自己命名）；每个会话的创建者、模型链、任务、结果摘要和遗留问题；一键打开会话、取消任务 |
| **闸门记录** | 每一次拒绝、转审的工具调用及原因，可以按类型筛选 |
| **待审批** | 等待决定的调用，直接点“批准”或“拒绝”，可以附上理由 |
| **渠道与探测** | 渠道健康、被停用的路由、每次探测的结果、路由切换、各模型的用量和缓存命中率 |

<table>
<tr>
<td width="50%"><img src="./assets/screenshots/sessions.zh.png" alt="会话与任务"><br><sub>会话与任务：按批次分组，看得到每个会话走的模型链</sub></td>
<td width="50%"><img src="./assets/screenshots/archive.zh.png" alt="按批次归档"><br><sub>按批次归档：先弹窗确认，运行中的不能归档，随时可以恢复</sub></td>
</tr>
<tr>
<td width="50%"><img src="./assets/screenshots/gate.zh.png" alt="闸门记录"><br><sub>闸门记录：拦下了什么、为什么</sub></td>
<td width="50%"><img src="./assets/screenshots/routes.zh.png" alt="渠道与探测"><br><sub>渠道与探测：熔断、停用的路由、用量和缓存命中率</sub></td>
</tr>
</table>

- **归档**：每个批次有“归档本批…”，另有单独的“全部归档…”按钮（默认一个都不勾选）。归档使用桌面版自带的归档功能，侧边栏同步变化，随时可以恢复。
- 在侧边栏手动归档的会话，面板会同步标记为“已归档”，只提供“恢复”按钮，也不再接受新任务。
- 面板通过桌面版自己的登录态访问插件接口，不需要令牌，其他程序无法冒用。

> 截图由真实的面板组件渲染，填入的是演示数据。

## 平台与客户端支持

插件是纯 JavaScript，运行在 DeepSeek Harness 自带的 Node 运行时里，**不需要另外安装任何东西**，也没有原生扩展。

| 平台 | 状态 |
|---|---|
| Windows 10 / 11 | ✅ 已在真实桌面版上完整验收：闸门三档、审批、bench 锁、审计、面板；多会话跨多家渠道并发；429 识别、与 Harness 自带重试的配合、熔断后切换备用模型 |
| Linux | 🟡 平台相关逻辑（路径、bash 命令规则）有单元测试，CI 在 Linux 上运行；真实桌面版冒烟测试待完成 |
| macOS | 🟡 同 Linux |

| 客户端 | 状态 |
|---|---|
| Claude Code（CLI） | ✅ 已验证：派活、进度、审批全流程 |
| Codex CLI | ✅ 已验证：创建会话、派发任务、查看进度、回收结果 |
| Kimi Code | ✅ 已验证接入 |
| Codex 桌面版 | 🟡 与 CLI 共用 `~/.codex/config.toml`，尚未实测 |
| 其他 MCP 客户端 | 支持“HTTP 方式的 MCP 服务器 + 自定义请求头”即可，见 [docs/CONNECT.md](docs/CONNECT.md) |

## 配置参考

都写在 `cordis.patch.yml` 里 `dujiangyan-dispatch` 条目的 `config` 下，除 `workspaceRoots` 外全部可选。

| 字段 | 默认值 | 说明 |
|---|---|---|
| `workspaceRoots` | `[]` | **必填。** agent 可以写入的目录 |
| `host` / `port` | `127.0.0.1` / `8790` | MCP 服务的监听地址 |
| `stateDir` | `~/.dsh/dujiangyan` | 令牌、审计日志、任务和锁文件的位置 |
| `roster` | implementer → `deepseek-official/deepseek-flash`；reviewer、planner → `deepseek-official/deepseek-v4-pro` | 每个角色的模型链 |
| `limits.defaults` / `limits.providers.<id>` | 见[宝瓶口](#宝瓶口准入控制) | `maxConcurrent`、`rpm`、`minSpacingMs`、`jitterMs`、`increaseAfter`、`breakerThreshold`、`breakerCooldownMs` |
| `permissionPreset` | `workspace-write` | 工人会话的权限预设 |
| `agentPreset` | `standard` | 工人会话挂载的 agent 预设 |
| `approvalTimeoutMs` | `900000`（15 分钟） | 等待审批的时限 |
| `fallbackToHuman` | `true` | 审批超时后，根会话是否交给桌面版的审批弹窗 |
| `maxSessions` | `0`（不限） | 会话数上限 |
| `maxActiveSessions` | `0`（不限） | 同时在跑任务的会话数上限，**只用来限制本机负载**；对 API 的压力由宝瓶口控制 |
| `preflight` | `true` | 创建会话前是否检查工作区环境 |
| `rules.allowCommands` / `denyPatterns` / `benchPatterns` | 空 | 扩展命令规则 |
| `rules.allowWebSearch` / `allowSubagents` | `true` / `false` | 是否允许网页搜索；是否允许 agent 自己拉起子 agent |
| `stagger.enabled` | `false` | 实验功能：错峰启动，让后启动的 agent 命中厂商的前缀缓存 |

## MCP 工具

| 工具 | 作用 |
|---|---|
| `djy_guide` | **建议先读**：使用流程、审批原则、已知问题及规避方法 |
| `djy_status` | 总览：会话、任务、待审批、锁、各渠道的并发和熔断、用量和缓存命中率 |
| `djy_models` | 列出可以路由到的 provider 和模型 |
| `djy_routes_probe` | 用极小的真实请求检查模型是否能用；结果写进事件流和审计日志 |
| `djy_limits_set` | 运行时调整某个 provider 的准入参数（不写盘） |
| `djy_preflight` | 只读检查工作区环境，并给出修复建议 |
| `djy_session_create` / `_list` / `_close` | 创建、列出、关闭工人会话；创建时可以指定角色、模型链、批次名 |
| `djy_task_submit` / `_get` / `_list` / `_cancel` | 提交、查看、取消任务；可以声明独占资源，例如 `["bench"]` |
| `djy_events_watch` | 按游标长轮询事件流 |
| `djy_approvals_list` / `djy_approval_decide` | 查看待审批请求、做出决定（先到先得） |
| `djy_locks_list` | 查看锁和排队情况 |

## 安全

- 只监听 `127.0.0.1`；拒绝非本机连接，以及 Host 头不是本机地址的请求（防 DNS 重绑定）。
- 拒绝所有带 `Origin` 头的请求，网页无法发起 CSRF。
- 必须携带 Bearer 令牌，服务端用常量时间比较；POST 必须是 `application/json`。
- 交给审批人的参数摘要会屏蔽疑似密钥的字段。
- 插件不向任何外部服务发送数据；所有决定写进本机的审计日志 `~/.dsh/dujiangyan/audit/`。

## 排错

| 现象 | 处理 |
|---|---|
| `djy_session_create` 报预检问题（Windows） | 列出的目录缺少沙箱需要的 Low 完整性标签。确认后执行它给出的 `icacls` 命令（只作用于这些目录），或传 `ignorePreflight` 跳过 |
| 连接被拒（401/403） | 令牌不对，或请求带了 `Origin` 头；按[第 3 步](#3-让你的-ai-客户端接上)重新接入 |
| 端口 8790 没有监听 | 确认桌面版已启动、`workspaceRoots` 已配置；看 `~/.dsh/dujiangyan/endpoint.json` |
| 大量 429 | 调低 `limits.providers.<id>.maxConcurrent`，并给对应角色配置备用模型 |

更多真实踩过的坑见 [LESSONS.md](LESSONS.md)。

## 路线图

- [x] 闸门三档 + AI 审批 + 人工兜底
- [x] 按 key 准入、熔断切换、路由探测
- [x] 桌面面板、按批次归档
- [x] 任意 MCP 客户端由 agent 自助接入
- [ ] 发布到 npm，桌面版“添加插件”一键安装
- [ ] Linux / macOS 真实桌面版冒烟测试
- [ ] stdio → HTTP 小桥，支持只会 stdio 的客户端
- [ ] **都江堰·天府**：任务依赖图、自动审核与返工的团队调度

## 从源码构建

```bash
git clone https://github.com/klinkdev2026/dsh-dujiangyan-dispatch.git
cd dsh-dujiangyan-dispatch
npm install
npm test          # 单元测试 + 模拟宿主的端到端测试
npm run build     # 输出到 lib/
# 退出桌面版后，用 link: 方式安装本地源码（dsh 用桌面版自带的那个）
dsh plugin --profile desktop add "link:$(pwd)"
```

修改代码后重新 `npm run build`，再重启桌面版生效。欢迎提 issue 和 PR。

## 致谢

- 整体思路参考 [dsh-harness-mcp-server](https://github.com/chushixixin/dsh-harness-mcp-server)（MIT），代码为独立重写。
- 设计借鉴 [dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams)、[dsh-agent-swarm](https://github.com/TT-Wang/dsh-agent-swarm)、[dsh-swarm](https://github.com/joekytc/dsh-swarm) 以及 DeepSeek Harness 官方的 auto-review 插件，详见 [NOTICE.md](NOTICE.md)。

本项目是社区插件，与 DeepSeek 官方无隶属关系。

<p align="center">MIT License · 如果它帮到了你，点个 ⭐ 让更多人看到</p>
