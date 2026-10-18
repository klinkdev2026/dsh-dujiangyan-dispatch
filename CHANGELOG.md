# Changelog

## 0.1.0-alpha.1

First pre-release.

- 飞沙堰 permission gate on `tools/pre-execute` and `approval/request` for dispatched sessions and their subagents: allow / deny-with-reason / escalate; escalations wait for an MCP approver, then fall back to the desktop prompt (root sessions) or deny (subagents).
- 宝瓶口 per-provider admission control on `llm/stream`: adaptive concurrency cap, Retry-After, jittered spacing, circuit breaker.
- 鱼嘴 route chains per role with failover via `agent/request` and return to the preferred route.
- Sessions, serial task queues, exclusive leases (`bench`), event log with cursors, audit log.
- Windows workspace preflight for the sandbox's Low integrity label.
- `djy_limits_set`: runtime (in-memory) override of a provider's admission limits.
- Marketplace metadata: `icon.svg`, `locale/{zh,en}.json` (`meta.title`/`meta.description`), keywords `dsh-plugin`/`deepseek-harness`; distribution notes in `docs/PUBLISHING.md`.
- Connecting clients: the plugin writes an agent-facing guide `~/.dsh/dujiangyan/CONNECT.md` at every start (endpoint, token file, header, rules: user scope, back up configs, never print the token, verify with `djy_status`); any MCP client's own agent applies it in its own config format. `docs/CONNECT.md` explains the flow and lists verified manual setups (Claude Code, Codex, Kimi Code). Kimi Code verified.
- Panel: sessions grouped by dispatch batch (`batch` on `djy_session_create`, default = one MCP connection, e.g. `codex · MM-DD HH:mm`); archive per batch or all (separate button, nothing preselected) behind a confirmation dialog, using the desktop's undoable archive; restore per session/batch. Sessions archived or removed in the sidebar are flagged (`desktop: archived|missing`), shown with Restore instead of Open, and refuse new tasks.
- `djy_session_create` accepts `fallbacks` (an explicit route chain). Verified on the real desktop with a local mock provider: 429 classification, AIMD narrowing, Harness-retry interplay (no double retries), breaker → fallback route.
- Route health: `djy_routes_probe` checks listed models with a tiny real request; deterministic route failures (400/401/403/404/422, excluding context-length) bench the route and fail over down the chain (`agent/request-error` → retry).
- **Desktop review panel**: a 都江堰 / Dujiangyan entry in the left sidebar with overview, sessions & tasks (creator, route chain, open session, cancel), gate log (filter denied/escalated), pending approvals with Allow/Deny, routes & probes (provider health, benched routes, probe history, usage). Served from authenticated routes under `/plugins/dsh-dujiangyan-dispatch/` behind the host's own Connection fence.
- Sessions are no longer capped (`maxSessions` and the new `maxActiveSessions` default to 0 = unlimited); API pressure is controlled only per request by the admission layer. Session titles are prefixed with the creating client (`[claude]`, `[codex]`), recorded as `createdBy`.
- Probe results are recorded in the event log (`routes/probed`) and the audit log.
- Guidance: sessions are long-lived and should be reused, not closed after each task (tool descriptions, djy_guide, README).
- MCP server on loopback with bearer token, Origin/Host checks; `djy_guide` playbook.
- Fixes found in the first real-desktop smoke test: v4 producer-owned message source kind; wait for the turn to start before `whenIdle()`; optional MCP arguments with server-side defaults.
