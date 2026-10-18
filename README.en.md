<p align="right"><a href="./README.md">简体中文</a> · <strong>English</strong></p>

<p align="center">
  <img src="./assets/hero.en.png" width="100%" alt="Dujiangyan: command any number of mixed-model DeepSeek Harness agents from any AI client, through one gate">
</p>

<p align="center">
  <a href="https://github.com/klinkdev2026/dsh-dujiangyan-dispatch/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/klinkdev2026/dsh-dujiangyan-dispatch/ci.yml?branch=main&style=flat-square&label=CI" alt="CI"></a>
  <img src="https://img.shields.io/badge/version-0.1.0--alpha.1-0B7285?style=flat-square" alt="version">
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-%E2%89%A50.2.1--rc.2-4D8DFF?style=flat-square" alt="DeepSeek Harness >= 0.2.1-rc.2">
  <img src="https://img.shields.io/badge/MCP-Streamable%20HTTP-5FE0C0?style=flat-square" alt="MCP">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-6F93A6?style=flat-square" alt="platforms">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-2E8B57?style=flat-square" alt="MIT"></a>
</p>

<h3 align="center">Let Claude Code, Codex, Kimi Code… command a whole DeepSeek Harness legion.<br>Every tool call goes through the gate; no API key gets flooded.</h3>

---

Say this in Claude Code:

> Open 3 flash coders and 1 kimi reviewer, then give me a combined summary.

**Dujiangyan** starts those agents inside the **DeepSeek Harness desktop app** you already run, and takes care of everything that makes this hard:

| | |
|---|---|
| 🧭 **Any client can command** | Claude Code, Codex, Kimi Code, Zhipu, pi, Cursor… anything that speaks MCP can dispatch work, follow progress and approve calls |
| 🌊 **Any number, any model** | No session cap. Each role gets a model chain (DeepSeek, Kimi, GLM, Qwen, any OpenAI-compatible gateway); a broken model is skipped automatically |
| 🛡️ **Every tool call is gated** | Safe calls pass, dangerous ones are denied with a reason, grey ones go to an AI approver and then to you. Sub-agents the workers spawn are gated too |
| 🚰 **Per-key admission** | Each key gets its own concurrency cap, spaced sends, automatic narrowing on 429, a circuit breaker with failover, and a return to the preferred model once it recovers |
| 🔒 **Exclusive resources** | A benchmark holds the machine to itself; other agents' builds wait instead of stealing CPU |
| 👀 **Visible end to end** | A "Dujiangyan" panel in the desktop sidebar shows sessions, tasks, gate log, pending approvals and route health; every agent is an ordinary session you can open |

<p align="center">
  <img src="./assets/screenshots/overview.en.png" width="100%" alt="Dujiangyan panel: overview">
  <br><sub>The Dujiangyan panel in the desktop app (demo data): 10 sessions from 3 clients, concurrency and breaker state for 4 providers, recent gate decisions</sub>
</p>

## Two halves, one install

| | 🏯 **The DSH half: plugin** | 🤖 **The agent half: MCP server** |
|---|---|---|
| For | You, inside the DeepSeek Harness desktop app | Your AI client (Claude Code, Codex, Kimi Code…) |
| Does | Gates every tool call, per-key admission, model routing, leases; the review panel in the sidebar | 17 `djy_*` tools to open sessions, dispatch tasks, follow progress, approve and probe routes; plus an agent-facing `CONNECT.md` |
| Runs | Inside the desktop app's process | Same process, on `127.0.0.1:8790/mcp`, token-authenticated |

It is one package on purpose: the MCP server needs the plugin's hooks to create sessions, intercept calls and meter requests, so both halves must live in the same process.

## Contents

- [Why "Dujiangyan"](#why-dujiangyan)
- [How it differs](#how-it-differs)
- [Quick start](#quick-start)
- [Flying Sand: the permission gate](#flying-sand-the-permission-gate)
- [Bottle Neck: admission control](#bottle-neck-admission-control)
- [Fish Mouth: multi-model routing](#fish-mouth-multi-model-routing)
- [Desktop panel](#desktop-panel)
- [Platforms and clients](#platforms-and-clients)
- [Configuration](#configuration) · [MCP tools](#mcp-tools) · [Security](#security) · [Troubleshooting](#troubleshooting)
- [Roadmap](#roadmap) · [Build from source](#build-from-source) · [Acknowledgements](#acknowledgements)

## Why "Dujiangyan"

Dujiangyan is an irrigation system built in Sichuan over 2,200 years ago and still in use. It does not dam the Min River; it **splits, spills and meters** the flow. This is called "irrigation without a dam".

**Dujiangyan protects the plain, not the river.** Here:

- **The river** is the burst of requests and actions from many agents at once;
- **The plain** is your side: your keys' concurrency and quota, your money, your machine (builds and benchmarks fight for CPU), your project files, and your attention (approval requests must not all hit you at once).

Ten agents at once will not hurt any provider, but they easily overwhelm your side.

| Part | What it does at Dujiangyan | What it does here |
|---|---|---|
| **Fish Mouth** | A levee that splits the river into inner and outer channels | **Multi-model routing**: one model chain per role; requests take the first healthy model |
| **Flying Sand Spillway** | Floodwater and silt spill out here | **Permission gate + breaker**: dangerous actions are stopped; failing providers are taken out of rotation |
| **Bottle Neck** | Meters the water entering the plain | **Admission control**: per-key concurrency; narrows on rate limits and widens again on recovery |
| **The plain** | The irrigated Chengdu Plain | **Where agents work**: sessions, task queues, exclusive leases |

"Without a dam" is also the gate's design rule: what is clearly safe passes, what is clearly dangerous is denied with a reason, and only the grey zone goes to approval. **Guide the flow; don't block it.**

## How it differs

The DeepSeek Harness community already has excellent multi-agent plugins. Dujiangyan does not build another "captain" inside DSH; it solves a different problem: **letting external AI clients command DSH safely**.

| | **Dujiangyan** | dsh-agent-teams | dsh-crew | dsh-harness-mcp-server |
|---|---|---|---|---|
| Who commands | **Any MCP client** (Claude Code, Codex, Kimi Code…), several at once | A captain session inside DSH | Claude / Codex | Any MCP client |
| Number of agents | **Unlimited**; requests are metered at the admission layer | Up to 8 members by default (configurable) | — | Unlimited |
| Multiple models | ✅ Model chain per role, broken routes skipped, failover | ✅ Per-member model | — | — |
| Gate on every tool call | ✅ Allow / deny with reason / escalate, sub-agents included | Per-member tool policy (documented as not an authorization boundary) | ❌ | ❌ |
| Approvals | ✅ AI approver, then you (one click in the panel) | Member calls that need approval are auto-rejected | ❌ | ❌ |
| Per-key admission, 429 narrowing, breaker failover | ✅ | ❌ | ❌ | ❌ |
| Exclusive leases | ✅ | ❌ | ❌ | ❌ |
| Authentication | ✅ Loopback + bearer token + CSRF guard | — | ❌ Unauthenticated HTTP | ❌ |
| Task DAG, member messaging | ❌ (left to the commanding agent) | ✅ Its strength | — | — |
| Platforms | Windows / macOS / Linux | Cross-platform | POSIX only | Cross-platform |

> They complement each other: dsh-agent-teams excels at DAG-style teamwork inside DSH; Dujiangyan turns DSH into a compute legion that outside agents can drive safely.

## Quick start

### 1. Install

> ⏳ **npm release in progress.** Once published, open **Plugins → Add plugin** in the desktop app and enter `dsh-dujiangyan-dispatch`. Until then, use the command line below or [build from source](#build-from-source).

**Command line** (first **quit the desktop app completely**, including the tray icon):

```powershell
# Windows
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add github:klinkdev2026/dsh-dujiangyan-dispatch
```

```bash
# macOS / Linux: use resources/runtime/cli/bin/dsh inside the desktop app's install directory
<install dir>/resources/runtime/cli/bin/dsh plugin --profile desktop add github:klinkdev2026/dsh-dujiangyan-dispatch
```

> Use the `dsh` bundled with the desktop app. A globally installed npm `dsh` cannot manage the desktop profile.

### 2. Set the workspace (required)

Append this to `~/.dsh/profiles/desktop/cordis.patch.yml` to name the directories agents may write to:

```yaml
- id: dujiangyan-dispatch
  name: dsh-dujiangyan-dispatch
  config:
    workspaceRoots:
      - '/home/me/my-project'     # or 'D:\work\my-project' on Windows
```

Without `workspaceRoots`, every session is refused. Restart the desktop app; a **Dujiangyan** icon appears in the sidebar.

### 3. Connect your AI client

On start, the plugin writes an **agent-facing connection guide** to `~/.dsh/dujiangyan/CONNECT.md`. In the client you use (Claude Code, Codex, Kimi Code, Zhipu, pi…), tell its agent:

> Read `~/.dsh/dujiangyan/CONNECT.md` and connect your MCP client to Dujiangyan (server name djy) as it describes. Do not show the token. When done, call djy_status and tell me the version.

The agent configures its own client in that client's format and writes the token only into the configuration. For manual setup and verified client configs, see **[docs/CONNECT.md](docs/CONNECT.md)**.

### 4. Dispatch your first task

> Use djy to open an implementer session in /home/me/my-project, list the project structure and write NOTES.md.

The agent reads `djy_guide`, creates the session, submits the task, follows progress and handles approvals. Open the **Dujiangyan** panel to watch.

> 💡 **Sessions are long-lived workers; do not close one after each task.** Tasks on a session run in order and keep context. For follow-up work, find an existing session with `djy_session_list` and reuse it.

## Flying Sand: the permission gate

<p align="center"><img src="./assets/gate.en.png" width="100%" alt="Flying Sand: the permission gate"></p>

The gate applies only to **sessions dispatched by Dujiangyan and their sub-agents**. Sessions you open by hand are unaffected.

| Tier | Contents |
|---|---|
| ✅ **Allowed** | Reads and searches; writes and edits inside the workspace; builds and runs (`cargo`, `python`, `node`, `cmake`…); local git (`status/diff/add/commit`); read-only shell commands; the workspace's own scripts |
| ⛔ **Denied, with the reason** | Writes outside the workspace; reading credential files or printing key-bearing environment variables; global or system installs; registry and `setx`; **ACL, integrity-label or sandbox changes** (environment issues belong to you); `git push` and remote changes; uploads; `run_code` (its body bypasses the gate); agents spawning their own sub-agents; plugin or Harness configuration; benchmarks without the bench lease |
| ❓ **Escalated** | Everything else: network access, `pip/npm install`, `git clone`, dynamic code execution, deletes with unresolvable targets, unknown commands |

- **Approval order**: the connected AI client decides first (it should verify independently rather than trust the worker); you can also click Allow or Deny in the panel. The first decision wins, and the audit log records who made it.
- **On timeout** (15 minutes by default): root sessions fall back to the desktop's own approval prompt; sub-agents are pinned to policy `never`, so the call is denied.
- The denial reason goes back to the agent verbatim, so it adapts instead of working around the gate.

<p align="center"><img src="./assets/screenshots/approvals.en.png" width="100%" alt="Pending approvals"></p>

## Bottle Neck: admission control

<p align="center"><img src="./assets/admission.en.png" width="100%" alt="Bottle Neck: admission control"></p>

**Sessions, tasks and request concurrency are three different things:**

- **Sessions**: how many workers exist. **Unlimited**; idle sessions cost nothing.
- **Tasks**: how much work is queued on each session. **Unlimited**; tasks on one session run in order.
- **Request concurrency**: how many requests hit one provider at the same moment. **Only this layer needs control.**

So 100 sessions can work at once: every request passes the Bottle Neck, which admits as many as each key can take. At personal scale the real bottleneck is your own key; gateway keys often allow only 3–5 concurrent requests. Defaults:

- Concurrency cap per provider: `deepseek-official` 8, any other provider 4. Set these to your keys' real limits.
- On 429 or overload the cap halves; after 20 consecutive successes it grows by one.
- `Retry-After` is honoured when the provider sends it; requests are spaced 150 ms apart plus up to 250 ms of random jitter.
- Five rate limits or overloads in a row open the breaker for 2 minutes: requests move down the model chain; after the cooldown one probe request goes through, and on success traffic returns to the preferred model.
- RPM windows and staggered warm-up are off by default and can be enabled.

## Fish Mouth: multi-model routing

Each role has a model chain; earlier entries win:

```yaml
roster:
  implementer:
    - { provider: deepseek-official, model: deepseek-flash }
    - { provider: my-relay, model: qwen-coder }          # fallback
  reviewer:
    - { provider: moonshot, model: kimi-latest }
    - { provider: deepseek-official, model: deepseek-v4-pro }
```

- Providers and models are the ones already configured in your desktop app; no keys are configured twice. List them with `djy_models`.
- `djy_routes_probe` checks each model with a tiny real request. A model that a gateway lists but cannot serve (for example an API dialect mismatch) is benched for 30 minutes and sessions skip it.
- Deterministic errors at run time (400/401/403/404/422, except context-length 400s) bench the route, and the current step retries on the next model in the chain.

## Desktop panel

After installation the desktop sidebar gets a **Dujiangyan** entry with five tabs:

| Tab | Contents |
|---|---|
| **Overview** | Sessions (by creator), running tasks, pending approvals, leases; per-provider concurrency, queue and breaker state; recent events |
| **Sessions & tasks** | Grouped by **batch** (one client run per batch, or a name you choose); each session's creator, model chain, tasks, result summaries and open issues; open a session or cancel a task in one click |
| **Gate log** | Every denied or escalated tool call and why, filterable |
| **Approvals** | Calls waiting for a decision: click Allow or Deny, optionally with a reason |
| **Routes & probes** | Provider health, benched routes, probe results, route switches, usage and cache-hit rate per model |

<table>
<tr>
<td width="50%"><img src="./assets/screenshots/sessions.en.png" alt="Sessions and tasks"><br><sub>Sessions & tasks: grouped by batch, with each session's model chain</sub></td>
<td width="50%"><img src="./assets/screenshots/archive.en.png" alt="Archive a batch"><br><sub>Archive by batch: confirmed in a dialog, busy sessions excluded, always restorable</sub></td>
</tr>
<tr>
<td width="50%"><img src="./assets/screenshots/gate.en.png" alt="Gate log"><br><sub>Gate log: what was stopped and why</sub></td>
<td width="50%"><img src="./assets/screenshots/routes.en.png" alt="Routes and probes"><br><sub>Routes & probes: breakers, benched routes, usage and cache hits</sub></td>
</tr>
</table>

- **Archiving**: each batch has "Archive batch…", and a separate "Archive all…" button preselects nothing. It uses the desktop's own archive, so the sidebar stays in sync and everything can be restored.
- Sessions you archive in the sidebar are marked "archived" in the panel, offer only Restore, and accept no new tasks.
- The panel talks to the plugin through the desktop's own login session; no token is involved and other programs cannot impersonate it.

> Screenshots are rendered from the real panel component with demo data.

## Platforms and clients

The plugin is plain JavaScript running in DeepSeek Harness's bundled Node runtime. **Nothing else to install**, no native modules.

| Platform | Status |
|---|---|
| Windows 10 / 11 | ✅ Fully accepted on the real desktop app: all three gate tiers, approvals, bench lease, audit, panel; concurrent sessions across several providers; 429 classification, interplay with Harness's own retries, breaker failover |
| Linux | 🟡 Platform logic (paths, bash command rules) is unit-tested and CI runs on Linux; a real-desktop smoke test is pending |
| macOS | 🟡 Same as Linux |

| Client | Status |
|---|---|
| Claude Code (CLI) | ✅ Verified: dispatch, progress and approvals end to end |
| Codex CLI | ✅ Verified: session creation, task dispatch, progress and results |
| Kimi Code | ✅ Connection verified |
| Codex desktop app | 🟡 Shares `~/.codex/config.toml` with the CLI; not tested yet |
| Other MCP clients | Need "HTTP MCP server + custom headers"; see [docs/CONNECT.md](docs/CONNECT.md) |

## Configuration

Under `config` of the `dujiangyan-dispatch` row in `cordis.patch.yml`. Everything except `workspaceRoots` is optional.

| Field | Default | Meaning |
|---|---|---|
| `workspaceRoots` | `[]` | **Required.** Directories agents may write to |
| `host` / `port` | `127.0.0.1` / `8790` | MCP listen address |
| `stateDir` | `~/.dsh/dujiangyan` | Token, audit log, tasks and lease files |
| `roster` | implementer → `deepseek-official/deepseek-flash`; reviewer, planner → `deepseek-official/deepseek-v4-pro` | Model chain per role |
| `limits.defaults` / `limits.providers.<id>` | see [Bottle Neck](#bottle-neck-admission-control) | `maxConcurrent`, `rpm`, `minSpacingMs`, `jitterMs`, `increaseAfter`, `breakerThreshold`, `breakerCooldownMs` |
| `permissionPreset` | `workspace-write` | Permission preset for worker sessions |
| `agentPreset` | `standard` | Agent preset mounted on worker sessions |
| `approvalTimeoutMs` | `900000` (15 min) | How long to wait for an approval |
| `fallbackToHuman` | `true` | After a timeout, hand root sessions to the desktop's approval prompt |
| `maxSessions` | `0` (unlimited) | Session cap |
| `maxActiveSessions` | `0` (unlimited) | Cap on sessions running tasks at once, **for local machine load only**; API pressure is handled by the Bottle Neck |
| `preflight` | `true` | Check the workspace environment before creating a session |
| `rules.allowCommands` / `denyPatterns` / `benchPatterns` | empty | Extend the command rules |
| `rules.allowWebSearch` / `allowSubagents` | `true` / `false` | Allow web search; allow agents to spawn their own sub-agents |
| `stagger.enabled` | `false` | Experimental: staggered start so later agents hit the provider's prefix cache |

## MCP tools

| Tool | Purpose |
|---|---|
| `djy_guide` | **Read first**: workflow, approval principles, known pitfalls and workarounds |
| `djy_status` | Sessions, tasks, approvals, leases, per-provider concurrency and breaker, usage and cache-hit rate |
| `djy_models` | Providers and models that can be routed to |
| `djy_routes_probe` | Check models with a tiny real request; results go to the event stream and audit log |
| `djy_limits_set` | Adjust a provider's admission limits at run time (in memory) |
| `djy_preflight` | Read-only workspace environment check with suggested fixes |
| `djy_session_create` / `_list` / `_close` | Create, list, close worker sessions; role, model chain and batch name on create |
| `djy_task_submit` / `_get` / `_list` / `_cancel` | Submit, inspect, cancel tasks; declare exclusive resources such as `["bench"]` |
| `djy_events_watch` | Long-poll the event stream by cursor |
| `djy_approvals_list` / `djy_approval_decide` | List pending approvals and decide (first decision wins) |
| `djy_locks_list` | Leases and their queues |

## Security

- Listens on `127.0.0.1` only; refuses non-loopback peers and non-loopback Host headers (DNS-rebinding guard).
- Refuses any request with an `Origin` header, so web pages cannot mount CSRF.
- Requires a bearer token compared in constant time; POST must be `application/json`.
- Argument summaries shown to approvers mask likely secrets.
- The plugin sends nothing to external services; every decision goes to the local audit log in `~/.dsh/dujiangyan/audit/`.

## Troubleshooting

| Symptom | What to do |
|---|---|
| `djy_session_create` reports preflight issues (Windows) | The listed directories lack the Low integrity label the sandbox needs. Review and run the suggested `icacls` command (it touches only those directories), or pass `ignorePreflight` |
| Connection refused with 401/403 | Wrong token or an `Origin` header; reconnect as in [step 3](#3-connect-your-ai-client) |
| Nothing listening on 8790 | Make sure the desktop app is running and `workspaceRoots` is set; check `~/.dsh/dujiangyan/endpoint.json` |
| Many 429s | Lower `limits.providers.<id>.maxConcurrent` and give the role a fallback model |

More real-world pitfalls: [LESSONS.md](LESSONS.md) (Chinese).

## Roadmap

- [x] Three-tier gate + AI approver + human fallback
- [x] Per-key admission, breaker failover, route probes
- [x] Desktop panel, archive by batch
- [x] Self-service connection for any MCP client
- [ ] Publish to npm for one-click install in the desktop app
- [ ] Real-desktop smoke tests on Linux and macOS
- [ ] stdio → HTTP bridge for stdio-only clients
- [ ] **Dujiangyan · Tianfu**: team scheduling with task DAGs, automatic review and rework

## Build from source

```bash
git clone https://github.com/klinkdev2026/dsh-dujiangyan-dispatch.git
cd dsh-dujiangyan-dispatch
npm install
npm test          # unit tests + end-to-end tests against a fake host
npm run compile     # writes lib/
# quit the desktop app, then install the checkout with link: (use the desktop's bundled dsh)
dsh plugin --profile desktop add "link:$(pwd)"
```

After changing code, run `npm run compile` again and restart the desktop app. Issues and PRs are welcome.

## Acknowledgements

- The overall shape follows [dsh-harness-mcp-server](https://github.com/chushixixin/dsh-harness-mcp-server) (MIT); the code is an independent rewrite.
- Design ideas from [dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams), [dsh-agent-swarm](https://github.com/TT-Wang/dsh-agent-swarm), [dsh-swarm](https://github.com/joekytc/dsh-swarm) and DeepSeek Harness's official auto-review plugin. See [NOTICE.md](NOTICE.md).

This is a community plugin, not affiliated with DeepSeek.

<p align="center">MIT License · If it helps you, a ⭐ helps others find it</p>
