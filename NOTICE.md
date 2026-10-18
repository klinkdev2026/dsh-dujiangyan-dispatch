# NOTICE

dsh-dujiangyan-dispatch is an independent implementation. It contains no code copied from the projects below; it adopts ideas and, where noted, mirrors documented public extension points.

- **dsh-harness-mcp-server** (chushixixin, MIT) — the overall shape of an in-process MCP server driving `ctx.agents` sessions, and the cwd canonicalization + workspace grouping approach.
- **DeepSeek Harness** (deepseek-ai, MIT) — the `tools/pre-execute`, `approval/request`, `llm/stream` and `agent/request` extension points, used as documented; `experimental/auto-review` as the reference for a prepended pre-execute gate.
- **dsh-agent-swarm** (TT-Wang) — non-author review, leases with epochs, host-captured artifacts (planned for phase 2).
- **dsh-agent-teams** (NanmiCoder) — Windows-tolerant atomic JSON replacement, route composition/validation against the host catalog.
- **dsh-swarm** (joekytc) — per-request model failover via `agent/request` / `agent/request-error`.
- **deepseek-as-subagent** (PsChina) — cross-process workspace lease as the model for named leases.
- **DeepSeek Elastic Compute (DSec)**, arXiv 2609.22978 — the latency-sensitive vs best-effort split informing the bench lease.
