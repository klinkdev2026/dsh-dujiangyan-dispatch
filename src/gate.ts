/**
 * 飞沙堰 (Feishayan) — the gate wired into the host.
 *
 * Two prepended listeners cover the two ways a tool effect is authorized:
 *   - `tools/pre-execute` sees every tool call of every agent, including
 *     in-process subagents. In-process children have their approval policy
 *     pinned to `never`, so returning `ask` for them would be auto-rejected;
 *     the gate therefore waits for the external approver itself and returns
 *     allow or deny.
 *   - `approval/request` sees sandbox escalations requested from inside a tool
 *     body (bash/pwsh `sandbox_permissions`), which never pass pre-execute.
 * Sessions outside the dispatch lineage are passed through untouched.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { aiEligible, askJudges, judgeKey, type AiApproval, type AiApprovalConfig, type AiVerdict, type JudgeInput } from './ai-approval.ts'
import { summarizeForApproval, type ApprovalQueue } from './approvals.ts'
import type { ResolvedConfig } from './config.ts'
import type { EventLog } from './events.ts'
import type {
  ApprovalOutcome, ApprovalRequestEvent, ApprovalService, HostAgent, HostContext, PreToolDecision, SandboxPolicyService, ToolExecution,
} from './host.ts'
import { DISPATCH_CANCEL, optional } from './host.ts'
import { canonicalPath } from './paths.ts'
import { matchHint, type LocalRules } from './local-rules.ts'
import { buildApprovalContext, oneLineArgs, CONTEXT_LIMITS, type ApprovalContext, type RecentCall } from './approval-context.ts'
import type { EvidenceRecorder } from './evidence.ts'
import type { DispatchRegistry } from './registry.ts'
import { classify, isBenchCommand, RUN_CODE, sandboxNoop, type RuleConfig, type Verdict } from './rules.ts'

/** Heavy commands that wait while another session holds the `bench` lease (quiet mode). */
export const QUIET_PATTERNS: readonly RegExp[] = [
  /\bcargo(\.exe)?\s+(\+\S+\s+)?(build|b|test|t|clippy|run|r|bench|check|c|nextest|doc)\b/i,
  /\b(npm|pnpm|yarn)(\.cmd)?\s+(run\s+)?(test|build|compile)\b/i,
]

export interface GateDeps {
  readonly config: ResolvedConfig
  readonly registry: DispatchRegistry
  readonly approvals: ApprovalQueue
  readonly events: EventLog
  readonly audit: (record: Record<string, unknown>) => void
  /** Resources (e.g. `bench`) held by the task currently running on a root session. */
  readonly heldResources: (rootSessionId: string) => readonly string[]
  /** The task currently running on a root session, for attribution. */
  readonly runningTask: (rootSessionId: string) => string | undefined
  /** The task whose turn the plugin just stopped on this idle root session (cancel, needs_input, needs_attention). */
  readonly stoppedTask?: (rootSessionId: string) => { taskId: string; status: string } | undefined
  /** Personal hot-reloaded rules layered over the profile config. */
  readonly localRules?: LocalRules
  /** Model judges for workspace-confined escalations (off unless enabled). */
  readonly aiApproval?: AiApproval
  /** Holder of the `bench` lease right now, if any (quiet mode). */
  readonly benchHolder?: () => string | undefined
  /** Poll interval while a heavy command waits for the bench lease (quiet mode). */
  readonly quietPollMs?: number
  /** The running task's id/title/prompt and the worker's latest assistant text (approval context). */
  readonly approvalContext?: (rootSessionId: string) => { id: string; title?: string; prompt: string; lastAssistant?: string } | undefined
  /** Called once when a session's task trips the deny circuit breaker (the task is paused). */
  readonly onDenyBreaker?: (root: string, taskId: string | undefined, detail: { consecutive: number; windowDenies: number; lastRule: string }) => void
  /** Milliseconds timestamp of the last authenticated MCP request (an orchestrator is around), if any. */
  readonly approverSeen?: () => number | undefined
  /** Bench rights of the task running on a root session (`command`, `task`, `shared`), if any. */
  readonly benchMode?: (rootSessionId: string) => 'command' | 'task' | 'shared' | undefined
  /** The machine-wide `bench` lease, taken per benchmark command in `command` mode. */
  readonly benchLease?: { acquire(holder: string, signal: AbortSignal): Promise<void>; release(holder: string): void }
  /** The orchestrator's quiet-mode switch (`djy_quiet_set`), when set and not expired. */
  readonly quietOverride?: () => boolean | undefined
  /** Records what each task really ran (calls let through, their results, build and test runs). */
  readonly evidence?: EvidenceRecorder
  /**
   * A session called tool names of another agent host twice in a row (findings 55/59: a gateway
   * renamed the tools); its route cannot work. Called once per run of such calls.
   */
  readonly onForeignTools?: (agent: HostAgent, root: string, taskId: string | undefined, names: readonly string[]) => void
  /** A step that timed out again waiting for an approver; the worker was told to skip it. */
  readonly onBlocked?: (root: string, taskId: string | undefined, step: { tool: string; rule: string; summary: string; fingerprint: string }) => void
}

/** Largest dot-sourced script the gate reads to learn the functions it defines. */
const MAX_SCRIPT_BYTES = 256 * 1024

function readWorkspaceScript(p: string): string | undefined {
  try {
    return statSync(p).size <= MAX_SCRIPT_BYTES ? readFileSync(p, 'utf8') : undefined
  } catch {
    return undefined
  }
}

/** Prefix on every denial a worker receives, so it (and the orchestrator) can tell a gate denial from a tool error. */
export const DENY_MARKER = '[dujiangyan-denied'
const DENY_GUIDANCE = 'Do not retry the same action with a different formulation; adapt your approach or report it in "leftovers".'
const denyText = (rule: string, reason: string) => `${DENY_MARKER}:${rule}] ${reason} — ${DENY_GUIDANCE}`

/** The nearest ancestor of `dir` (itself included) that holds a `.git` entry. */
function gitTopLevel(dir: string): string | undefined {
  for (let d = path.resolve(dir), i = 0; i < 64; i++) {
    if (existsSync(path.join(d, '.git'))) return canonicalPath(d)
    const up = path.dirname(d)
    if (up === d) return undefined
    d = up
  }
  return undefined
}

export function installGate(ctx: HostContext, deps: GateDeps): void {
  const { config, registry, approvals, events, audit } = deps
  const home = homedir()
  /** Calls whose sandbox escalation the approver already granted at pre-execute. */
  const preApproved = new Set<string>()
  /** Timed-out calls handed to the desktop prompt by the explicit `fallbackToHuman` opt-in. */
  const fallbackAsks = new Set<string>()
  /**
   * Calls the gate itself denied or timed out, by call id and by session+tool, for a short window.
   * A host `approval/request` that follows one of them is not a new question: shown to a human it
   * reads like a sandbox escalation and approving it would run the refused call outside the sandbox.
   */
  const refusedRecently = new Map<string, number>()
  const REFUSED_WINDOW_MS = 2 * 60_000
  const noteRefused = (sessionId: string, tool: string, callId: string | undefined): void => {
    const now = Date.now()
    for (const [k, at] of refusedRecently) if (now - at > REFUSED_WINDOW_MS) refusedRecently.delete(k)
    refusedRecently.set(`${sessionId}|${tool}`, now)
    if (callId !== undefined) refusedRecently.set(`call|${callId}`, now)
  }
  const wasRefused = (sessionId: string, tool: string, callId: string | undefined): boolean => {
    const now = Date.now()
    const hit = (k: string) => { const at = refusedRecently.get(k); return at !== undefined && now - at <= REFUSED_WINDOW_MS }
    return (callId !== undefined && hit(`call|${callId}`)) || hit(`${sessionId}|${tool}`)
  }

  /**
   * Deny circuit breaker (prior art: dsh-auto-review's rejection breaker): per running task, N
   * consecutive gate/AI denials or M of the last W verdicts pause the task, so a worker that keeps
   * rephrasing a refused action stops burning turns. Denials by a human or the orchestrator are
   * deliberate guidance and do not count.
   */
  const breakers = new Map<string, { taskId: string | undefined; consecutive: number; recent: boolean[]; tripped: boolean }>()
  const noteVerdict = (root: string, taskId: string | undefined, denied: boolean, rule: string): void => {
    const b = config.denyBreaker
    // Only a running task can be paused; calls outside a task are not tracked.
    if (!b.enabled || taskId === undefined) return
    let state = breakers.get(root)
    if (state === undefined || state.taskId !== taskId) {
      state = { taskId, consecutive: 0, recent: [], tripped: false }
      breakers.set(root, state)
    }
    if (state.tripped) return
    state.consecutive = denied ? state.consecutive + 1 : 0
    state.recent.push(denied)
    if (state.recent.length > b.windowSize) state.recent.shift()
    const windowDenies = state.recent.filter(Boolean).length
    if (denied && (state.consecutive >= b.consecutiveDenies || windowDenies >= b.windowDenies)) {
      state.tripped = true
      const detail = { consecutive: state.consecutive, windowDenies, lastRule: rule }
      events.append('task/deny-breaker', { root, taskId, ...detail })
      audit({ type: 'task/deny-breaker', root, taskId, ...detail })
      deps.onDenyBreaker?.(root, taskId, detail)
    }
  }

  /** Root session → the foreign tool names it called in a row (findings 59). */
  const foreignRun = new Map<string, string[]>()
  /** Root sessions whose first foreign call was already logged as evidence for the gateway operator. */
  const foreignLogged = new Set<string>()
  /** Root sessions already told about a no-op sandbox_permissions field (one gate/hint each). */
  const sandboxHinted = new Set<string>()
  const contextFor = (agent: HostAgent, root: string) => {
    const cwd = canonicalPath(agent.session.header.cwd ?? registry.get(root)?.cwd ?? process.cwd())
    const local = deps.localRules?.effective(cwd)
    return {
      local,
      gate: {
        cwd,
        roots: config.workspaceRoots.length > 0 ? config.workspaceRoots : [canonicalPath(registry.get(root)?.cwd ?? cwd)],
        home,
        platform: process.platform,
        // `command` and `shared` mode have the right to run benchmarks; `task` mode needs its lease.
        holdsBench: (() => {
          const mode = deps.benchMode?.(root)
          return mode === 'command' || mode === 'shared' || deps.heldResources(root).includes('bench')
        })(),
        config: local?.rules ?? config.rules,
        protectedDirs: [canonicalPath(config.stateDir)],
        readScript: readWorkspaceScript,
        ...(() => {
          // Read per call: a session override can change it. Unreadable → undefined (the request escalates).
          try {
            const mode = optional<SandboxPolicyService>(ctx, 'sandboxPolicy')?.resolve({ session: agent.session }).mode
            return typeof mode === 'string' ? { sandboxMode: mode } : {}
          } catch {
            return {}
          }
        })(),
        isDirectory: (p: string) => {
          try {
            return statSync(p).isDirectory()
          } catch {
            return false
          }
        },
        gitTopLevel,
        ...(() => {
          const scope = registry.get(root)?.writeScope
          return scope !== undefined && scope.length > 0 ? { writeScope: scope.map(p => canonicalPath(p)) } : {}
        })(),
      },
    }
  }

  /** The last few gated calls per root session, so an approver sees what the worker did just before. */
  const recent = new Map<string, RecentCall[]>()
  let callsSincePrune = 0
  const noteCall = (root: string, call: RecentCall): void => {
    const list = recent.get(root) ?? []
    list.push(call)
    if (list.length > CONTEXT_LIMITS.calls) list.shift()
    recent.set(root, list)
    // Closed sessions leave their per-session state behind; drop it now and then.
    if (++callsSincePrune >= 200) {
      callsSincePrune = 0
      for (const map of [recent, breakers] as Array<Map<string, unknown>>) {
        for (const key of [...map.keys()]) if (registry.get(key) === undefined) map.delete(key)
      }
    }
  }

  /**
   * Approval timeouts per task and call. Overnight nobody answers: telling the worker to resubmit
   * unchanged made it wait 15 min again and again (S16 waited an hour on one call, 2026-10-21). The
   * first timeout defers the step, the second marks it blocked, later repeats are refused at once.
   * Any human or orchestrator decision, or the orchestrator listing approvals after the timeout,
   * starts the count again (not just any MCP call: a long-polling orchestrator made every timeout the first).
   */
  const timeouts = new Map<string, { count: number; at: number }>()
  let lastHumanDecisionAt = 0
  const fingerprint = (tool: string, summary: string) => createHash('sha256').update(`${tool}\u0000${summary}`).digest('hex').slice(0, 16)
  const timeoutsFor = (key: string): number => {
    const t = timeouts.get(key)
    if (t === undefined) return 0
    const seen = deps.approverSeen?.()
    if (lastHumanDecisionAt > t.at || (seen !== undefined && seen > t.at)) {
      timeouts.delete(key)
      return 0
    }
    return t.count
  }
  const approvalContext = (root: string, args: Readonly<Record<string, unknown>>): ApprovalContext => {
    const rec = registry.get(root)
    const route = rec?.chain?.[0]
    return buildApprovalContext({
      ...(() => { const task = deps.approvalContext?.(root); return task !== undefined ? { task } : {} })(),
      session: { ...rec?.title !== undefined ? { title: rec.title } : {}, ...route !== undefined ? { route: `${route.provider}/${route.model}` } : {} },
      description: args['description'],
      recentCalls: (recent.get(root) ?? []).filter(c => c.taskId === deps.runningTask(root)),
    })
  }

  const isRootSession = (agent: HostAgent, root: string) => agent.session.id === root || agent.session.header.id === root

  /** Run the AI judges on a pending approval; only a unanimous answer settles it, anything else stays for a human. */
  const judgeApproval = async (id: string, meta: { sessionId: string; taskId?: string; tool: string; rule: string }, input: JudgeInput, signal: AbortSignal, ai: AiApprovalConfig) => {
    const judges = ai.judges.map(judgeKey)
    if (deps.aiApproval?.takeBudget(meta.sessionId) === false) {
      const opinions = [{ judge: 'budget', decision: 'human' as const, reason: `AI approval budget used up for this session (${ai.maxPerSessionPer10Min} judgments per 10 min)`, latencyMs: 0 }]
      approvals.annotate(id, { status: 'split', opinions })
      approvals.publish(id)
      events.append('approval/ai', { id, ...meta, status: 'over-budget', opinions })
      audit({ type: 'approval/ai', id, ...meta, judges, outcome: 'over-budget' })
      return
    }
    // Stop the judges the moment the approval settles elsewhere (a human or the orchestrator was faster).
    const settled = approvals.settledSignal(id)
    if (settled === undefined) return
    approvals.annotate(id, { status: 'judging', opinions: [] })
    events.append('approval/ai', { id, ...meta, status: 'judging', judges })
    let verdict: AiVerdict
    try {
      verdict = await askJudges(ctx, ai, input, AbortSignal.any([signal, settled]))
    } catch (err) {
      verdict = { outcome: 'pending', opinions: [{ judge: judges.join('+'), decision: 'error', reason: String(err).slice(0, 300), latencyMs: 0 }] }
    }
    const reasons = verdict.opinions.map(o => `${o.judge}: ${o.reason}`).join(' | ')
    const decider = `ai:${ai.judges.map(j => j.model).join('+')}`
    // decide()/annotate() return false when someone else settled the approval first.
    const applied = verdict.outcome === 'allow' ? approvals.decide(id, 'allow', reasons, decider)
      : verdict.outcome === 'deny' ? approvals.decide(id, 'deny', reasons, decider)
        : approvals.annotate(id, { status: 'split', opinions: verdict.opinions })
    // Split (or failed): now it is the orchestrator's to decide, so it enters the event stream.
    if (verdict.outcome === 'pending') approvals.publish(id)
    for (const o of verdict.opinions) deps.aiApproval?.record(o, 'live')
    audit({ type: 'approval/ai', id, ...meta, judges, outcome: verdict.outcome, applied, opinions: verdict.opinions })
    events.append('approval/ai', { id, ...meta, status: verdict.outcome === 'pending' ? 'split' : verdict.outcome, applied, opinions: verdict.opinions })
  }

  /** Quiet mode: a heavy command waits while another session holds the bench lease. */
  const quietPatterns = (): { enabled: boolean; patterns: RegExp[] } => {
    const local = deps.localRules?.quietMode()
    const extra = [...config.quietMode.patterns, ...local?.patterns ?? []].map(p => new RegExp(p, 'i'))
    return { enabled: deps.quietOverride?.() ?? local?.enabled ?? config.quietMode.enabled, patterns: [...QUIET_PATTERNS, ...extra] }
  }

  /**
   * Heavy commands running now, by execution (or call id), so a benchmark can wait for them to end.
   * Entries leave on `tools/result`; ones whose result never came are dropped after a few hours.
   */
  const inflight = new Map<unknown, { root: string; at: number }>()
  const callKey = (exec: ToolExecution): unknown => exec.callId ?? exec
  const noteHeavy = (exec: ToolExecution, root: string, command: string | undefined, rules: RuleConfig | undefined): void => {
    if (command === undefined || isBenchCommand(command, rules) || !quietPatterns().patterns.some(re => re.test(command))) return
    const now = Date.now()
    for (const [k, v] of inflight) if (now - v.at > 3 * 3600_000) inflight.delete(k)
    inflight.set(callKey(exec), { root, at: now })
  }

  /** Benchmark commands holding the `bench` lease for just their own run (`command` mode). */
  const machineHeld = new Map<unknown, { taskId: string; tool: string; at: number }>()
  const releaseKey = (key: unknown, type: string): void => {
    const held = machineHeld.get(key)
    if (held === undefined) return
    machineHeld.delete(key)
    // The lease is per task and re-entrant: parallel benchmarks of one task share it, so only the
    // last one to finish gives it back (review F1: the first result freed the machine mid-run).
    const stillRunning = [...machineHeld.values()].filter(v => v.taskId === held.taskId).length
    if (stillRunning === 0) deps.benchLease?.release(held.taskId)
    events.append(type, { taskId: held.taskId, tool: held.tool, ...stillRunning > 0 ? { stillRunning } : {} })
  }
  const releaseMachine = (exec: ToolExecution): void => releaseKey(callKey(exec), 'bench/released')
  /** A benchmark whose result never came (host crash, lost event) must not hold the machine for good. */
  const expireMachine = (now: number): void => {
    for (const [k, v] of machineHeld) if (now - v.at > 3 * 3600_000) releaseKey(k, 'bench/lease-expired')
  }
  /**
   * In `command` mode a benchmark takes the machine only while it runs: it waits for the lease,
   * then for heavy commands of other sessions already running (bounded), and gives it back when its
   * result arrives (findings 32, 38, 41, 51: report writing no longer holds everyone else).
   */
  const takeMachine = async (exec: ToolExecution, root: string, taskId: string | undefined, command: string | undefined, rules: RuleConfig | undefined): Promise<'ok' | 'cancelled'> => {
    if (command === undefined || taskId === undefined || deps.benchLease === undefined || deps.benchMode?.(root) !== 'command' || !isBenchCommand(command, rules)) return 'ok'
    const started = Date.now()
    expireMachine(started)
    events.append('bench/waiting', { taskId, tool: exec.name, command: command.slice(0, 200) })
    try {
      await deps.benchLease.acquire(taskId, exec.signal)
    } catch {
      events.append('bench/cancelled', { taskId, tool: exec.name })
      return 'cancelled'
    }
    machineHeld.set(callKey(exec), { taskId, tool: exec.name, at: Date.now() })
    exec.signal.addEventListener('abort', () => releaseMachine(exec), { once: true })
    const deadline = Date.now() + config.quietMode.maxWaitMs
    const poll = deps.quietPollMs ?? 1000
    while ([...inflight.values()].some(f => f.root !== root)) {
      if (exec.signal.aborted) {
        releaseKey(callKey(exec), 'bench/cancelled')
        return 'cancelled'
      }
      if (Date.now() >= deadline) {
        events.append('bench/noisy', { taskId, reason: 'heavy commands of other sessions were still running when the benchmark started' })
        break
      }
      await new Promise(resolve => setTimeout(resolve, poll))
    }
    events.append('bench/acquired', { taskId, tool: exec.name, waitedMs: Date.now() - started })
    return 'ok'
  }
  const waitForQuiet = async (signal: AbortSignal): Promise<'free' | 'timeout' | 'cancelled'> => {
    const deadline = Date.now() + config.quietMode.maxWaitMs
    const poll = deps.quietPollMs ?? 1000
    while (deps.benchHolder?.() !== undefined) {
      if (signal.aborted) return 'cancelled'
      if (Date.now() >= deadline) return 'timeout'
      await new Promise<void>(resolve => {
        const t = setTimeout(resolve, poll)
        signal.addEventListener('abort', () => {
          clearTimeout(t)
          resolve()
        }, { once: true })
      })
    }
    return signal.aborted ? 'cancelled' : 'free'
  }

  ctx.on('tools/pre-execute', async (exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
    const agent = exec.agent
    if (agent === undefined) return next()
    const root = registry.rootOf(agent)
    if (root === undefined) return next()

    // A turn the plugin stopped keeps calling tools (findings 58): refuse and stop it again.
    const stopped = deps.runningTask(root) === undefined ? deps.stoppedTask?.(root) : undefined
    if (stopped !== undefined) {
      const record = { type: 'gate', sessionId: agent.session.id, root, taskId: stopped.taskId, tool: exec.name, callId: exec.callId, kind: 'deny', rule: 'task-stopped' }
      audit(record)
      events.append('gate/decision', { ...record, reason: `task ${stopped.status}` })
      try { agent.cancel(DISPATCH_CANCEL) } catch { /* the turn may already be over */ }
      return { kind: 'deny', reason: denyText('task-stopped', `your task ended (${stopped.status}); do not call more tools, end your turn now`), info: { name: 'DujiangyanDenied', code: 'DJY_DENIED', reason: 'task-stopped' } }
    }

    const args = (exec.arguments !== null && typeof exec.arguments === 'object' ? exec.arguments : {}) as Record<string, unknown>
    const outerRunCode = exec.name === RUN_CODE && exec.parent === undefined
    let verdict: Verdict
    const context = contextFor(agent, root)
    try {
      verdict = classify(exec.name, args, context.gate, outerRunCode)
    } catch (err) {
      verdict = { kind: 'escalate', rule: 'classifier-error', reason: String(err) }
    }
    // A personal hint only redirects a call that would wait for an approver; it never allows or loosens.
    if (verdict.kind === 'escalate' && context.local !== undefined) {
      const hint = matchHint(context.local, exec.name, args)
      if (hint !== undefined) verdict = { kind: 'deny', rule: hint.id, reason: `${hint.reason} (would have needed approval: ${verdict.rule})` }
    }
    const command = typeof args['command'] === 'string' ? args['command'] : undefined
    const taskId = deps.runningTask(root)
    if (verdict.rule === 'foreign-tool') {
      const run = [...foreignRun.get(root) ?? [], exec.name]
      foreignRun.set(root, run)
      if (!foreignLogged.has(root)) {
        foreignLogged.add(root)
        // Evidence for the gateway's bug report: the name the model used and the argument names it sent
        // (they show which tool of this harness it meant). Not used for any mapping.
        events.append('route/foreign-tools', { sessionId: agent.session.id, root, taskId, tool: exec.name, argumentNames: Object.keys(args).slice(0, 12) })
      }
      if (run.length === 2) deps.onForeignTools?.(agent, root, taskId, run)
    } else {
      foreignRun.delete(root)
    }
    // Another session's benchmark holds the machine (this task's own lease, task- or command-long, does not count).
    const othersBench = () => {
      const h = deps.benchHolder?.()
      return h !== undefined && h !== taskId && !deps.heldResources(root).includes('bench')
    }
    if (verdict.kind === 'allow' && command !== undefined && !isBenchCommand(command, context.gate.config) && othersBench()) {
      const quiet = quietPatterns()
      if (quiet.enabled && quiet.patterns.some(re => re.test(command))) {
        const started = Date.now()
        events.append('quiet/waiting', { sessionId: agent.session.id, root, tool: exec.name, holder: deps.benchHolder?.(), command: command.slice(0, 200) })
        const waited = await waitForQuiet(exec.signal)
        events.append('quiet/resumed', { sessionId: agent.session.id, root, tool: exec.name, result: waited, waitedMs: Date.now() - started })
        if (waited === 'cancelled') return { kind: 'cancel' }
        if (waited === 'timeout') {
          verdict = {
            kind: 'escalate',
            rule: 'quiet-timeout',
            reason: `a benchmark has held the machine for over ${Math.round(config.quietMode.maxWaitMs / 60_000)} min; this heavy command was held back so the measurement stays clean`,
          }
        }
      }
    }
    // A sandbox request for the mode the call already has was judged as if absent: audit that (not an
    // approved escalation) and tell the orchestrator once per session; the worker is not told (findings 57).
    const sandboxIgnored = args['sandbox_permissions'] !== undefined && sandboxNoop(args, context.gate)
    if (sandboxIgnored && !sandboxHinted.has(root)) {
      sandboxHinted.add(root)
      events.append('gate/hint', { sessionId: agent.session.id, root, taskId, tool: exec.name, hint: 'sandbox-permissions-noop', detail: `the worker sends sandbox_permissions "${String(args['sandbox_permissions'])}", equal to its current mode; the field is ignored and the call judged normally` })
    }
    const record = { type: 'gate', sessionId: agent.session.id, root, taskId, tool: exec.name, callId: exec.callId, kind: verdict.kind, rule: verdict.rule, ...sandboxIgnored ? { sandboxPermissions: 'ignored: equal-to-effective' } : {} }
    audit(verdict.kind === 'allow' ? record : { ...record, reason: verdict.reason })
    if (verdict.kind !== 'allow') events.append('gate/decision', { ...record, reason: verdict.reason })

    const paused = breakers.get(root)
    if (taskId !== undefined && paused?.tripped === true && paused.taskId === taskId) {
      return { kind: 'deny', reason: denyText('deny-breaker', 'this task was paused after repeated denials; stop and summarize what you were trying to do'), info: { name: 'DujiangyanDenied', code: 'DJY_PAUSED', reason: 'deny-breaker' } }
    }
    const line = oneLineArgs(args)
    const tagged = taskId !== undefined ? { taskId } : {}
    if (verdict.kind === 'allow') {
      noteVerdict(root, taskId, false, verdict.rule)
      noteCall(root, { ...tagged, tool: exec.name, args: line, verdict: 'allow', rule: verdict.rule })
      if ((await takeMachine(exec, root, taskId, command, context.gate.config)) === 'cancelled') return { kind: 'cancel' }
      noteHeavy(exec, root, command, context.gate.config)
      if (taskId !== undefined) deps.evidence?.started(exec, taskId, exec.name, args, verdict.rule)
      return next()
    }
    if (verdict.kind === 'deny') {
      noteVerdict(root, taskId, true, verdict.rule)
      noteCall(root, { ...tagged, tool: exec.name, args: line, verdict: 'deny', rule: verdict.rule })
      noteRefused(agent.session.id, exec.name, exec.callId)
      if (taskId !== undefined) deps.evidence?.denied(taskId)
      return { kind: 'deny', reason: denyText(verdict.rule, verdict.reason), info: { name: 'DujiangyanDenied', code: 'DJY_DENIED', reason: verdict.rule } }
    }

    const { summary, truncated } = summarizeForApproval(args)
    const timeoutKey = `${taskId ?? root}|${fingerprint(exec.name, summary)}`
    if (timeoutsFor(timeoutKey) >= 2) {
      // Asked twice and nobody answered: do not park the worker for another full timeout.
      deps.onBlocked?.(root, taskId, { tool: exec.name, rule: verdict.rule, summary, fingerprint: timeoutKey })
      events.append('approval/unavailable', { sessionId: agent.session.id, ...tagged, tool: exec.name, rule: verdict.rule })
      noteCall(root, { ...tagged, tool: exec.name, args: line, verdict: 'deny', rule: 'approval-unavailable' })
      if (taskId !== undefined) deps.evidence?.denied(taskId)
      return {
        kind: 'deny',
        reason: denyText('approval-unavailable', `no approver has answered this call (${verdict.rule}) twice; do not submit it again in this task. List it in "leftovers" as BLOCKED-ON-APPROVAL with what it would do, then finish the rest of the task or wrap up`),
        info: { name: 'DujiangyanDenied', code: 'DJY_APPROVAL_UNAVAILABLE', reason: 'approval-unavailable' },
      }
    }
    // Built before this call joins the ring, so `recentCalls` are the calls that came before it.
    const callContext = approvalContext(root, args)
    // The judges of this session (or its batch or folder), else the global ones.
    const ai = deps.aiApproval?.current(root)
    const judged = ai !== undefined && ai.enabled && aiEligible(verdict.rule, truncated)
    const meta = { sessionId: agent.session.id, ...taskId !== undefined ? { taskId } : {}, tool: exec.name, rule: verdict.rule }
    const input: JudgeInput = {
      tool: exec.name,
      summary,
      cwd: context.gate.cwd,
      roots: context.gate.roots,
      rule: verdict.rule,
      reason: verdict.reason,
      facts: context.local?.facts ?? [],
      context: callContext,
    }
    const result = await approvals.request({
      sessionId: agent.session.id,
      ...taskId !== undefined ? { taskId } : {},
      tool: exec.name,
      summary,
      ...truncated ? { truncated } : {},
      rule: verdict.rule,
      reason: verdict.reason,
      cwd: agent.session.header.cwd ?? '',
      origin: 'pre-execute',
      context: callContext,
    }, config.approvalTimeoutMs, exec.signal, judged ? id => void judgeApproval(id, meta, input, exec.signal, ai) : undefined,
    // While the judges decide, the orchestrator is not told; a unanimous verdict never reaches its stream.
    judged ? { deferEvent: true, publishAfterMs: ai.timeoutMs * 2 + 5000 } : {})
    noteCall(root, {
      ...tagged, tool: exec.name, args: line, verdict: `escalate → ${result.kind}`, rule: verdict.rule,
      ...result.kind === 'allow' || result.kind === 'deny' ? { decider: result.decider } : {},
    })
    if ((result.kind === 'allow' || result.kind === 'deny') && !result.decider.startsWith('ai:')) lastHumanDecisionAt = Date.now()

    switch (result.kind) {
      case 'allow': {
        // An approval does not exempt a heavy command from quiet mode: an approved build would
        // otherwise run while another session's benchmark holds the machine.
        // (A quiet-timeout approval is an explicit decision to run during the benchmark.)
        if (command !== undefined && verdict.rule !== 'quiet-timeout' && !isBenchCommand(command, context.gate.config) && othersBench()) {
          const quiet = quietPatterns()
          if (quiet.enabled && quiet.patterns.some(re => re.test(command))) {
            const started = Date.now()
            events.append('quiet/waiting', { sessionId: agent.session.id, root, tool: exec.name, holder: deps.benchHolder?.(), command: command.slice(0, 200), approved: true })
            const waited = await waitForQuiet(exec.signal)
            events.append('quiet/resumed', { sessionId: agent.session.id, root, tool: exec.name, result: waited, waitedMs: Date.now() - started, approved: true })
            if (waited === 'cancelled') return { kind: 'cancel' }
            if (waited === 'timeout') {
              const reason = `approved, but a benchmark still holds the machine after ${Math.round(config.quietMode.maxWaitMs / 60_000)} min; run this heavy command after the measurement`
              return { kind: 'deny', reason: denyText('quiet-timeout', reason), info: { name: 'DujiangyanDenied', code: 'DJY_DENIED', reason: 'quiet-timeout' } }
            }
          }
        }
        noteVerdict(root, taskId, false, verdict.rule)
        if (args['sandbox_permissions'] !== undefined && !sandboxIgnored && exec.callId !== undefined) {
          preApproved.add(exec.callId)
          // A call the host never re-asks about would stay forever: keep only the most recent ones.
          if (preApproved.size > 1000) preApproved.delete(preApproved.values().next().value as string)
        }
        if ((await takeMachine(exec, root, taskId, command, context.gate.config)) === 'cancelled') return { kind: 'cancel' }
        noteHeavy(exec, root, command, context.gate.config)
        if (taskId !== undefined) deps.evidence?.started(exec, taskId, exec.name, args, verdict.rule, result.decider)
        return next()
      }
      case 'deny':
        // AI denials count toward the breaker; a human's or the orchestrator's are guidance.
        if (result.decider.startsWith('ai:')) noteVerdict(root, taskId, true, verdict.rule)
        noteRefused(agent.session.id, exec.name, exec.callId)
        if (taskId !== undefined) deps.evidence?.denied(taskId)
        return { kind: 'deny', reason: denyText('approver', `${result.decider} denied this call: ${result.reason}`), info: { name: 'DujiangyanDenied', code: 'DJY_APPROVER_DENIED', reason: result.reason } }
      case 'cancelled':
        return { kind: 'cancel' }
      case 'timeout': {
        const policy = optional<ApprovalService>(ctx, 'approval')?.overrideOf(agent.session)
        if (config.fallbackToHuman && isRootSession(agent, root) && policy !== 'never') {
          // Explicit opt-in only: the desktop's own prompt decides this call (it is not routed back into our queue).
          fallbackAsks.add(exec.callId ?? `${agent.session.id}|${exec.name}`)
          return {
            kind: 'ask',
            reason: `dujiangyan: no approver answered within ${Math.round(config.approvalTimeoutMs / 60_000)} min (${verdict.rule}: ${verdict.reason})`,
            displayReason: {
              en: `Dujiangyan escalated this call and no approver answered: ${verdict.reason}`,
              zh: `都江堰把这个调用转交审批，但审批人未在时限内答复：${verdict.reason}`,
            },
          }
        }
        noteRefused(agent.session.id, exec.name, exec.callId)
        if (taskId !== undefined) deps.evidence?.denied(taskId)
        const count = timeoutsFor(timeoutKey) + 1
        timeouts.set(timeoutKey, { count, at: Date.now() })
        if (timeouts.size > 1000) timeouts.delete(timeouts.keys().next().value as string)
        events.append('approval/timeout', { sessionId: agent.session.id, ...tagged, tool: exec.name, rule: verdict.rule, count })
        const mins = Math.round(config.approvalTimeoutMs / 60_000)
        if (count >= 2) deps.onBlocked?.(root, taskId, { tool: exec.name, rule: verdict.rule, summary, fingerprint: timeoutKey })
        return {
          kind: 'deny',
          reason: count === 1
            ? denyText('approval-timeout', `no approver answered within ${mins} min (${verdict.rule}); nobody may be available right now. Continue with the parts of the task that do not need this step and submit this exact call once more near the end. Do not rewrite it or try to run it another way`)
            : denyText('approval-timeout', `still no approver (${verdict.rule}); do not submit this call again in this task. List it in "leftovers" as BLOCKED-ON-APPROVAL with what it would do, then finish the rest of the task or wrap up`),
          info: { name: 'DujiangyanDenied', code: 'DJY_APPROVAL_TIMEOUT', reason: 'approval-timeout' },
        }
      }
    }
  }, { prepend: true })

  // The frozen final outcome of every call: completes the evidence record of calls the gate let through.
  ctx.on('tools/result', (exec: ToolExecution, result: unknown) => {
    inflight.delete(callKey(exec))
    releaseMachine(exec)
    try {
      deps.evidence?.finished(exec, result)
    } catch {
      // Evidence is best effort; a malformed result must never disturb the host.
    }
  })

  ctx.on('approval/request', async (req: ApprovalRequestEvent, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> => {
    const root = registry.rootOf(req.agent)
    if (root === undefined) return next()
    if (req.callId !== undefined && preApproved.delete(req.callId)) return 'allowed-once'
    const fallbackKey = req.callId ?? `${req.agent.session.id}|${req.toolName}`
    if (fallbackAsks.delete(fallbackKey)) return next()
    const taskId = deps.runningTask(root)
    // The host re-asking about a call the gate just refused or timed out: never a new question.
    if (wasRefused(req.agent.session.id, req.toolName, req.callId) || (req.reason ?? '').startsWith('dujiangyan:')) {
      const detail = { sessionId: req.agent.session.id, ...taskId !== undefined ? { taskId } : {}, tool: req.toolName, callId: req.callId, reason: (req.reason ?? '').slice(0, 300) }
      events.append('approval/escalation-blocked', detail)
      audit({ type: 'approval/escalation-blocked', ...detail })
      return 'rejected'
    }
    const result = await approvals.request({
      sessionId: req.agent.session.id,
      ...taskId !== undefined ? { taskId } : {},
      tool: req.toolName,
      summary: req.reason ?? '',
      rule: 'sandbox-escalation',
      reason: req.reason ?? 'the tool asks to run with wider permissions',
      danger: 'grants execution OUTSIDE the sandbox',
      cwd: req.agent.session.header.cwd ?? '',
      origin: 'sandbox',
      context: approvalContext(root, {}),
    }, config.approvalTimeoutMs, req.signal)
    switch (result.kind) {
      case 'allow': return 'allowed-once'
      case 'deny': return 'rejected'
      case 'cancelled': return 'cancelled'
      case 'timeout': return config.fallbackToHuman ? next() : 'rejected'
    }
  }, { prepend: true })
}
