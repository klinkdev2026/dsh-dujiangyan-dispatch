# Changelog

## 0.2.0

Low weir: let the safe flow through. Replayed against a real day (2026-10-20: 130 approvals in 6.5 hours, 12 overnight timeouts), these changes leave 16 calls for an approver and none of the overnight ones.

**Gate: precise allowances** (each with its escape variants tested on the deny side)
- `Start-Process` is judged like a direct call of the program it starts, when the command waits for it (`-Wait`, `$p.WaitForExit(ms)`, `Wait-Process`): workspace binaries, interpreters and listed programs run; redirect files are write targets; the working directory must be inside the roots; `-Verb RunAs` is refused; an unwaited process (it would outlive the call) still needs approval.
- `$env:TEMP` / `$env:TMP` are the worker's own scratch directory (no `..`, no wildcard delete of the whole directory).
- Values the gate can now follow: `Join-Path` of literals, `$PWD`, `(Resolve-Path <literal>).Path`, literal lists (`'a','b'`, `@('a', "b")`) and `foreach` loop variables, each value checked. `$p += …` makes a known value unknown (it used to keep only the appended part).
- Functions the command defines, or dot-sources from a workspace script, can be called; their bodies are judged as before.
- A double-quoted `powershell -Command "…"` sees the outer variables; hashtable entries (`@{ K = 'v' }`) are judged as values, not commands; comments (`# …`, `<# … #>`) are not commands.
- A call to a tool name of another agent host (`Bash`, `Read`, `ToolSearch`, `apply_patch`, …), which models trained on those hosts sometimes emit, is refused at once with the name to use here instead of waiting for an approver; the host has no such tool, so the call could only fail.
- A route that renames tools (a gateway sent the model another host's tool names and did not map the calls back): after two such calls in a row the route is benched like any other deterministic route failure and the turn continues on the next healthy route of the chain; with none left the task ends as an error naming the route. The first such call of a session is logged (`route/foreign-tools`: the name and the argument names) as evidence for the gateway operator. Names are never mapped back by guesswork.
- A `sandbox_permissions` request for exactly the mode the call already has (the host grants that without approval) no longer waits for an approver; the call is judged as if the field were absent, the audit log marks it, and the orchestrator gets one `gate/hint` per session. Any other value, or a mode the gate cannot read, still escalates.
- A process polled with `while (-not $p.HasExited)` and killed on its deadline (`$p.Kill()`) counts as waited for.
- A session whose task the plugin stopped (cancelled, needs input, needs attention, failed route) and that keeps calling tools has those calls refused for ten minutes, and its turn is stopped again.
- Workers are told that a held call waits for its decision by itself, so a pending approval is no reason to end the turn.
- `djy_routes_probe` sends one tool definition and the route's effort, like a worker request: routes that accept a bare prompt but reject tools no longer probe as healthy.
- `cmd /c "set NAME=value&& program …"` sets a plain variable and runs the program as judged on its own; loader variables (`PATH`, …) follow `allowEnv`, `set /a` and `set /p` need approval, redirects are write targets.
- `New-Object` of pure types (collections, `StringBuilder`, `IO.DriveInfo` for free disk space) is allowed; `-ComObject` and other types still need approval.
- A task summary whose values contain braces (`"25 × {1,20} threads"`) was read as empty; the closing `}` is now found outside strings, and list values are joined.
- A rule listed both in the profile config and in `local-rules.json` (e.g. the same `benchPatterns`) appears once in the effective rules.
- `djy_ai_approval_set` replaces the judge models at run time: each new judge is probed first (nothing changes if one fails), the choice is kept in the plugin data dir across restarts, `judges: null` returns to the configured ones. Judges can differ per session (`judges` on `djy_session_create`, or `sessionId`), per batch (`batch`) and per folder (`workspaces[root].aiApproval.judges` in `local-rules.json`), so orchestrators working in different folders each use their own; the most specific applies. Changing a judge no longer needs a profile edit, which reloads the desktop and interrupts every running task.
- `local-rules.json` gains `workspaceRoots`: extra roots that apply at once, without a desktop restart (one orchestrator can run workers in several project folders); a whole drive, the home directory or a folder containing the plugin data directory is refused. A session refused for its folder is told how to add a root.
- `local-rules.json` gains `allowEnv` (e.g. prepend a known Python to `PATH`) and `allowPrograms` (a program outside the workspace by exact path, with argument and script constraints).
- `working_directory` inside the roots, `exit`, `Add-Type -AssemblyName`, physical-memory reads via `ComputerInfo` are allowed.
- Fix: positional data of `Set-Content`/`Add-Content`/`Out-File` (`Set-Content f.rs "//! stub"`) is no longer judged as a second write target.
- From the independent review of these changes: `*>` (all streams) redirect targets are judged; `~` is the home directory (writes there are refused, `~user` paths need approval); after `cd`/`Set-Location`/`Push-Location` relative paths and `$PWD` are judged from every directory the shell may be in: only there after an unconditional `cd` into an existing directory, also the old one after a conditional (`&&`, `||`, inside a block) or possibly failing `cd` (an unresolvable target needs approval; this was wrong before 0.2 too); a `Start-Process` counts as waited only when its own `-PassThru` object is waited for in code, not in a string or comment; a function named like a built-in command (`function rm {…}`) needs approval; JWTs are masked in summaries and evidence.

**From the sixth review round**
- Git subcommands that create or overwrite work-tree files judge their operands like any write (roots, protected paths, the session's write scope): `worktree add/remove/move` paths, `init` directory, `checkout -- <paths>`, `restore`, `rm`, `mv`; a branch switch or stash is judged on the whole work tree (the nearest `.git` above), so a session sharing a repo with others needs approval for it; pathspec magic (`:/`) and globs need approval. `-C`, `--git-dir=`, `--work-tree=` are followed. Before, `git worktree add ../b/x` and `git checkout -- ../b/x` wrote into another session's scope (N1).
- Judges chosen at session creation are evented and audited like every other judge change (S1); the health check, the periodic probe and the watchdog alert cover session, batch and folder judges too, so a dead session judge no longer sends its sessions to a human silently (S2).
- Parallel benchmarks of one task keep the machine until the last one ends; the first result used to release it mid-run (F1).
- The approval-timeout count (defer, then blocked) restarts only when an approver lists or decides approvals; plain event polling by a long-connected orchestrator used to make every timeout the first again (F2).
- A judge switch probes the new judges in parallel, at most 60 s, so the reply arrives before the client gives up (N2).

**The orchestrator is the first approver, its user the last**
- The MCP server now sends instructions at connect: approvals of the connecting agent's workers come to it first (the AI judges hand it the ones they disagree on), so it keeps watching `djy_events_watch` instead of ending its turn after `djy_task_submit`; it decides only what it can judge with confidence and asks its user, with a recommendation, when unsure or for anything irreversible or outward-facing. `djy_task_submit` replies with the same reminder, `djy_task_get` lists the approvals its task waits for (`waitingForYou`), and `CONNECT.md` has a "Your role" section. Orchestrators that submitted and stopped left split approvals to time out.

**Unattended approvals**
- A call that times out is deferred the first time ("continue, submit once more near the end"), then listed as `BLOCKED-ON-APPROVAL` in the task's `blocked` list, and refused at once afterwards (`approval-unavailable`) instead of waiting out the timeout again and again. Any human or orchestrator decision, or any MCP call after the timeout, resets it.
- A worker-supplied tool timeout excuses the stall alarm for at most an hour.

**Orchestrator**
- A note sent with `djy_approval_decide` after someone else (often the AI judges) settled the approval is delivered as a steer; the reply says who settled it.
- Calls the AI judges settle unanimously no longer appear as `approval/pending` in the event stream (`approval/settled` carries `aiSettled: true`); a split is announced once, after the judges, with their opinions.

**Bench and quiet mode**
- `resources: ["bench"]` now holds the machine only while a benchmark command runs (it first waits for heavy commands of other sessions already running, and releases when its result arrives, or after 3 hours if the result never comes); `bench:task` is the old task-long lease; `bench:shared` may run benchmarks without holding anyone.
- `djy_quiet_set` switches quiet mode on or off for a while (audited, expires on its own) instead of an edit of `local-rules.json`.

**Evidence**
- Each task records what the gate saw it run (calls let through, approved, refused; recent commands with exit codes; build/test/lint runs with the runner summary); `djy_task_get` returns it as `evidence`, `djy_task_list` shows the last checks.

**Preflight**
- The session's working directory itself is checked for the Low integrity label, not only its subdirectories; preflight has tests.

**Internal**
- `scripts/replay-approvals.mjs` replays recorded approvals against the current rules.
- A test keeps the rule engine and admission controller free of host and orchestration imports.

## 0.1.1

Lessons from running a mixed-model agent fleet for real: nothing may wait silently, the human approver needs context, and personal habits must be configurable without a release.

**Approval (飞沙堰)**
- **AI approval, opt-in, two judges must agree.** Grey calls that only touch the workspace can be decided by model judges: unanimous allow allows, unanimous deny denies, anything else stays pending for a human with every opinion attached. The call is nonce-fenced as data (prompt-injection text inside it changes nothing), secrets are redacted, each session has a judgment budget, and a judge that refuses `temperature: 0` is retried without it. Network or outward calls, anything outside the workspace roots, encoded commands, loader-environment changes and sandbox widening are never sent to a judge. Judges default to the user's own roster (reviewer, planner, implementer); no model is assumed.
- **Approval context.** Every pending item carries the task, session, route, the worker's latest explanation, the call's own description and the earlier gated calls of the task; the panel has an "open session" button.
- **Nothing waits silently (watchdog).** Pending approvals raise alerts as they age and the worker is told it is waiting; at the timeout the call is denied safely and the host's follow-up sandbox escalation for the same call is rejected instead of queued (`fallbackToHuman` now defaults to off). Silent tasks, an absent orchestrator and a degraded AI judge are reported; `djy_status` has a health block; the panel raises desktop notifications.
- **Gate parser.** Real-world PowerShell, git global options before push/remote/config, write targets per session, attached redirects (`>f`, `2>&1`) can no longer hide a write target. A deny breaker pauses a task after repeated denials.

**Workers**
- `djy_session_steer` corrects a running worker at its next step; `note` on `djy_approval_decide` says something along with a decision.
- Task prompts end with an environment-facts footer (disk, known sandbox behaviour, personal facts) and a narration rule, so approvers can see what a worker is doing.
- A worker that asks the user a question ends its task as `needs_input` instead of hanging.
- **Quiet mode.** While a task holds `bench`, heavy commands from other sessions wait (also after an approval), so measurements stay clean.

**Personal rules, hot-reloaded.** `~/.dsh/dujiangyan/local-rules.json` (rules, hints, facts, per-workspace overrides, `aiApproval`, `quietMode`) is reloaded on change, no restart or release needed.

**Restarts.** Idle sessions resume after a desktop restart with their route and permission preset; tasks cut by a restart end as `interrupted` (not `done`); the event log carries an epoch so watchers detect the reset.

**Fixes**
- Cancelling a task passed no cause to `agent.cancel()`; the host logged `turn/end` with a null reason and the desktop chat view went blank for every conversation. All cancels now pass a cause.
- A busy MCP port no longer crashes the host; a lease taken over after stalled renewals is reported (`lease/lost`) and no longer grants bench rights; cancelled slot waiters leave the queue; secret masking matches whole words (`api_key`, not `monkey`); summaries never split a surrogate pair; failover happens at most once per request window.

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
