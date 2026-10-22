/**
 * Tasks: one prompt delivered to one dispatched session, run serially per
 * session, after the task's declared resources (e.g. the exclusive `bench`
 * lease) are held. Progress streams into the event log from `session/event`;
 * the final result is the assistant text, the tool calls, and the one-line
 * JSON summary the worker is asked to end with.
 */
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { redactSecrets } from './approvals.ts'
import type { ResolvedConfig } from './config.ts'
import { describeFacts, measureFacts } from './environment.ts'
import type { EvidenceRecorder, TaskEvidence } from './evidence.ts'
import type { EventLog } from './events.ts'
import { DISPATCH_CANCEL, type HostContext, type HostSession, type SessionEvent } from './host.ts'
import type { UsageMeter } from './llm-hooks.ts'
import type { LeaseManager } from './locks.ts'
import type { DispatchRegistry } from './registry.ts'
import type { SessionManager, WorkerQuestion } from './sessions.ts'
import { readJson, writeJsonAtomic } from './store.ts'

/**
 * `interrupted`: the plugin stopped (desktop restart/quit) or the turn was aborted from outside before it finished.
 * `needs_input`: the worker asked the user a question (see `questions`); answer it in a follow-up task.
 * `needs_attention`: the worker kept hitting denials and was paused (deny circuit breaker); read why, then submit a new task.
 */
export type TaskStatus = 'queued' | 'waiting_resources' | 'waiting_slot' | 'running' | 'done' | 'error' | 'cancelled' | 'interrupted' | 'needs_input' | 'needs_attention'

export const FINISHED_STATUSES: ReadonlySet<TaskStatus> = new Set(['done', 'error', 'cancelled', 'interrupted', 'needs_input', 'needs_attention'])
/** Endings where the plugin cut the turn off; the worker should not call anything afterwards. */
const STOPPED_STATUSES: ReadonlySet<TaskStatus> = new Set(['cancelled', 'needs_input', 'needs_attention'])
/** How long after such an ending a call from the idle session is treated as a leftover of that turn. */
const STRAY_WINDOW_MS = 10 * 60_000

const INTERRUPTED = 'interrupted by plugin stop/restart; partial work may exist — check the workspace and resubmit what is left'

/** Host-side failures before the turn did anything (prompt assembly not ready after a restart). */
export const STARTUP_ERROR = /prompt variable .* has no value|has no value for this assembly|not (yet )?(ready|initiali[sz]ed)/i

export interface TaskResult {
  /** Errors the agent reported during the turn (model/provider/session failures). */
  errors: string[]
  assistantText: string
  toolCalls: Array<{ name: string; args: string }>
  toolResultCount: number
  summary: { changes: string; verification: string; leftovers: string }
}

export interface TaskRecord {
  readonly id: string
  readonly sessionId: string
  readonly title?: string
  readonly prompt: string
  readonly resources: readonly string[]
  status: TaskStatus
  readonly createdAt: string
  startedAt?: string
  finishedAt?: string
  holds: string[]
  result?: TaskResult
  error?: string
  /** Questions the worker asked (status `needs_input`); nothing was chosen on its behalf. */
  questions?: WorkerQuestion[]
  /** Why the task was paused (status `needs_attention`). */
  attention?: string
  /** The worker's latest narration (tail of its last assistant text), so a reviewer sees what it is doing. */
  latest?: string
  /** Steps that waited for an approver who never answered (e.g. overnight); the worker was told to skip them. */
  blocked?: BlockedStep[]
  /** What the gate saw this task run: calls let through or refused, their outcomes, build and test runs. */
  evidence?: TaskEvidence
}

export interface BlockedStep {
  readonly tool: string
  readonly rule: string
  /** Bounded, secret-free summary of the call. */
  readonly summary: string
  readonly firstAt: string
  timeouts: number
  lastAt: string
}

const MAX_TEXT = 8000

export type BenchMode = 'command' | 'task' | 'shared'

/** The lease a declared resource takes for the whole task, if any. */
function leaseOf(resource: string): string | undefined {
  if (resource === 'bench' || resource === 'bench:shared') return undefined
  return resource === 'bench:task' ? 'bench' : resource
}
const MAX_BLOCKED = 20
const PERSISTED_COMMANDS = 40
/** Fingerprints of blocked steps (kept off the persisted record; after a restart a repeat is listed again). */
const blockedKeys = new WeakMap<BlockedStep, string>()
const blockedKey = (b: BlockedStep) => blockedKeys.get(b) ?? `${b.tool}|${b.summary}`

/**
 * Appended to every task prompt. Each line encodes a failure observed in real runs
 * (see LESSONS.md) so workers avoid it instead of rediscovering it.
 */
const WORKER_FOOTER = [
  '',
  '[dujiangyan] Work only inside the session workspace. Some actions are gated: if a call is denied, read the reason and adapt instead of working around it.',
  'Do not rewrite a command to get it past the gate (e.g. building a command name or path by string concatenation, or wrapping it in another shell). If a call is held for approval, say why you need it and wait: the call itself waits for the decision and returns its result (or the reason it was refused), so never end your turn because something is waiting for approval.',
  'To run a program with a time limit: $p = Start-Process -FilePath <program> -ArgumentList ... -PassThru -NoNewWindow; $null = $p.Handle; if(-not $p.WaitForExit(<ms>)){ $p.Kill() } else { $p.ExitCode } (an unwaited Start-Process is held for an approver; without reading $p.Handle first, $p.ExitCode stays empty). Scratch files go under $env:TEMP.',
  'Environment problems (permissions, ACLs, missing tools) are reported, not repaired: describe them in "leftovers". Never run icacls/Set-Acl/takeown or change sandbox settings.',
  'If a write is "access denied" inside the workspace on Windows, the directory is probably missing the sandbox integrity label — stop and report the directory path; do not grant yourself permissions.',
  'Benchmarks (cargo bench, bench*.py/ps1/sh, criterion) only run inside tasks that hold the "bench" resource; in other tasks prepare and build, but do not measure.',
  'On Windows the shell tool is pwsh: use PowerShell syntax; forward slashes in paths work and avoid escaping problems.',
  'Narrate for the reviewer: before each tool call write one sentence on what you are about to do and why; give every shell call a specific description; after a result, one sentence on what you learned. Held calls are approved from this text.',
  'Do not ask the user questions (no one is watching this session): a question ends your task and is handed to the orchestrator. Put open questions in "leftovers" instead.',
  'When you finish, end with exactly one line of JSON (no code fence):',
  '{"changes":"what you changed","verification":"how you verified it","leftovers":"open issues or questions"}',
].join('\n')

export class TaskManager {
  private readonly tasks = new Map<string, TaskRecord>()
  private readonly chains = new Map<string, Promise<void>>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly running = new Map<string, string>() // root session → task id
  /** Root session → the task whose turn the plugin stopped (cancel, needs_input, needs_attention) and when. */
  private readonly stopped = new Map<string, { taskId: string; status: TaskStatus; at: number }>()
  private readonly file: string
  private lastStartAt = 0
  private leaderStartAt = 0
  private readonly ctx: HostContext
  private readonly config: ResolvedConfig
  private readonly sessions: SessionManager
  private readonly registry: DispatchRegistry
  private readonly leases: LeaseManager
  private readonly events: EventLog
  private readonly usage: UsageMeter
  private readonly localFacts: (cwd: string | undefined) => readonly string[]
  private stopping = false
  private readonly evidence: EvidenceRecorder | undefined
  /** Outcome decided outside the turn (a question, the deny breaker); applied when the turn unwinds. */
  private readonly endings = new Map<string, { status: 'needs_input' | 'needs_attention' | 'error'; note: string }>()

  constructor(deps: {
    ctx: HostContext; config: ResolvedConfig; sessions: SessionManager; registry: DispatchRegistry
    leases: LeaseManager; events: EventLog; usage: UsageMeter
    /** Extra environment facts from the personal rules file for a session's working directory. */
    localFacts?: (cwd: string | undefined) => readonly string[]
    /** Gate-recorded evidence; a finished task keeps its own. */
    evidence?: EvidenceRecorder
  }) {
    this.evidence = deps.evidence
    this.ctx = deps.ctx
    this.config = deps.config
    this.sessions = deps.sessions
    this.registry = deps.registry
    this.leases = deps.leases
    this.events = deps.events
    this.usage = deps.usage
    this.localFacts = deps.localFacts ?? (() => [])
    this.file = path.join(deps.config.stateDir, 'tasks.json')
    let recovered = false
    for (const rec of readJson<TaskRecord[]>(this.file, [])) {
      // A task that was in flight when the host stopped did not finish; say so instead of resuming blindly.
      if (!FINISHED_STATUSES.has(rec.status)) {
        markInterrupted(rec)
        recovered = true
      }
      this.tasks.set(rec.id, rec)
    }
    if (recovered) this.persist()
    deps.sessions.onQuestion = (sessionId, questions) => this.onQuestion(sessionId, questions)
    this.ctx.on('session/event', (session: HostSession, event: SessionEvent) => this.onSessionEvent(session, event))
    this.ctx.on('agent/error', (p: { agent?: { session?: HostSession }; error?: unknown }) => {
      const id = p.agent?.session?.id
      const c = id !== undefined ? this.collecting.get(id) : undefined
      if (c === undefined) return
      const message = p.error instanceof Error ? p.error.message : String(p.error)
      c.errors.push(message)
      this.events.append('task/agent-error', { taskId: c.rec.id, sessionId: id, error: message.slice(0, 500) })
    })
  }

  submit(input: { sessionId: string; prompt: string; title?: string; resources?: readonly string[] }): TaskRecord {
    if (this.registry.get(input.sessionId) === undefined) throw new Error(`session ${input.sessionId} is not a dispatched session`)
    const rec: TaskRecord = {
      id: `task_${randomUUID().slice(0, 12)}`,
      sessionId: input.sessionId,
      ...input.title !== undefined ? { title: input.title } : {},
      prompt: input.prompt,
      resources: [...new Set(input.resources ?? [])],
      status: 'queued',
      createdAt: new Date().toISOString(),
      holds: [],
    }
    this.tasks.set(rec.id, rec)
    this.persist()
    this.events.append('task/queued', { taskId: rec.id, sessionId: rec.sessionId, title: rec.title, resources: rec.resources })
    const controller = new AbortController()
    this.controllers.set(rec.id, controller)
    const prev = this.chains.get(rec.sessionId) ?? Promise.resolve()
    const next = prev.then(() => this.run(rec, controller.signal)).catch(() => {})
    this.chains.set(rec.sessionId, next)
    return rec
  }

  get(id: string): TaskRecord | undefined {
    return this.tasks.get(id)
  }

  list(filter: { sessionId?: string; status?: TaskStatus } = {}): TaskRecord[] {
    return [...this.tasks.values()].filter(t =>
      (filter.sessionId === undefined || t.sessionId === filter.sessionId) && (filter.status === undefined || t.status === filter.status))
  }

  /**
   * The plugin is stopping (desktop restart or quit): every unfinished task ends as `interrupted`
   * now, synchronously, so the record on disk is right even if the process exits before the
   * running turns unwind. Their later completion cannot overwrite this.
   */
  stop(): void {
    this.stopping = true
    for (const rec of this.tasks.values()) {
      if (FINISHED_STATUSES.has(rec.status)) continue
      const c = this.collecting.get(rec.sessionId)
      if (c !== undefined && c.rec === rec) rec.result = this.resultOf(c, [INTERRUPTED])
      for (const name of rec.holds) {
        this.leases.release(name, rec.id)
        this.events.append('lease/released', { taskId: rec.id, name })
      }
      markInterrupted(rec)
      this.attachEvidence(rec)
      this.events.append('task/interrupted', { taskId: rec.id, sessionId: rec.sessionId, error: rec.error })
      this.controllers.get(rec.id)?.abort(new Error(INTERRUPTED))
    }
    this.persist()
  }

  /** Cancel every unfinished task of a session (used before the session is closed). */
  async cancelSession(sessionId: string): Promise<void> {
    for (const rec of [...this.tasks.values()]) {
      if (rec.sessionId === sessionId && !FINISHED_STATUSES.has(rec.status)) await this.cancel(rec.id)
    }
  }

  async cancel(id: string): Promise<boolean> {
    const rec = this.tasks.get(id)
    if (rec === undefined || FINISHED_STATUSES.has(rec.status)) return false
    this.controllers.get(id)?.abort(new Error('cancelled by orchestrator'))
    // Still behind other tasks of its session: nothing of it has run, so end it now. Otherwise its
    // status and event would only change when the queue reaches it, possibly hours later.
    if (rec.status === 'queued') {
      this.update(rec, { status: 'cancelled', error: 'cancelled by orchestrator', finishedAt: new Date().toISOString() })
      return true
    }
    if (rec.status === 'running') {
      try {
        ;(await this.sessions.agent(rec.sessionId)).cancel(DISPATCH_CANCEL)
      } catch {
        // The session may already be gone.
      }
    }
    return true
  }

  /** A worker asked the user something: record it on the running task and end the turn (no one will answer). */
  private onQuestion(sessionId: string, questions: readonly WorkerQuestion[]): void {
    const taskId = this.running.get(sessionId)
    const rec = taskId !== undefined ? this.tasks.get(taskId) : undefined
    this.events.append('task/needs-input', { taskId, sessionId, questions: questions.map(q => ({ id: q.id, question: q.question.slice(0, 300), options: q.options?.map(o => o.label) })) })
    if (rec === undefined) return
    rec.questions = [...questions]
    this.endTurn(rec, 'needs_input', 'the worker asked the user a question; answer it in a follow-up task (nothing was chosen on its behalf)')
  }

  /** The deny circuit breaker tripped for this session's running task: pause it. */
  pauseForAttention(rootSessionId: string, taskId: string | undefined, detail: { consecutive: number; windowDenies: number; lastRule: string }): void {
    const id = taskId ?? this.running.get(rootSessionId)
    const rec = id !== undefined ? this.tasks.get(id) : undefined
    if (rec === undefined || FINISHED_STATUSES.has(rec.status)) return
    rec.attention = `paused after repeated denials (${detail.consecutive} in a row, ${detail.windowDenies} of the recent calls; last rule ${detail.lastRule}); read the task's tool calls and the gate events, then submit a corrected task`
    this.endTurn(rec, 'needs_attention', rec.attention)
  }

  /** The session's route cannot work (e.g. it renames tools) and no healthy route is left: end the running task as an error. */
  failRunning(rootSessionId: string, note: string): void {
    const id = this.running.get(rootSessionId)
    const rec = id !== undefined ? this.tasks.get(id) : undefined
    if (rec === undefined || FINISHED_STATUSES.has(rec.status)) return
    this.endTurn(rec, 'error', note)
  }

  /** Record a step that timed out waiting for an approver, so the morning view lists what is missing. */
  noteBlocked(rootSessionId: string, taskId: string | undefined, step: { tool: string; rule: string; summary: string; fingerprint: string }): void {
    const id = taskId ?? this.running.get(rootSessionId)
    const rec = id !== undefined ? this.tasks.get(id) : undefined
    if (rec === undefined) return
    const now = new Date().toISOString()
    const list = rec.blocked ?? (rec.blocked = [])
    const known = list.find(b => blockedKey(b) === step.fingerprint)
    if (known !== undefined) {
      known.timeouts++
      known.lastAt = now
    } else if (list.length < MAX_BLOCKED) {
      const entry: BlockedStep = { tool: step.tool, rule: step.rule, summary: step.summary.slice(0, 500), firstAt: now, timeouts: 1, lastAt: now }
      blockedKeys.set(entry, step.fingerprint)
      list.push(entry)
    }
    this.persist()
  }

  private endTurn(rec: TaskRecord, status: 'needs_input' | 'needs_attention' | 'error', note: string): void {
    if (this.endings.has(rec.id)) return
    this.endings.set(rec.id, { status, note })
    void this.sessions.agent(rec.sessionId).then(agent => agent.cancel(DISPATCH_CANCEL)).catch(() => {})
  }

  /**
   * Deliver a message into the running worker's next model step (prior art: dsh-agent-teams
   * steerMemberPrompt — steer, not followup, so it is read now and not queued as a new turn).
   * Only while a task runs: steering an idle agent would start a turn the task runner does not own.
   */
  async steer(sessionId: string, text: string, from: 'orchestrator' | 'watchdog' = 'orchestrator'): Promise<{ taskId: string }> {
    const taskId = this.running.get(sessionId)
    if (taskId === undefined) throw new Error(`session ${sessionId} has no running task; submit a task instead`)
    const agent = await this.sessions.agent(sessionId)
    if (typeof agent.steer !== 'function') throw new Error('this Harness host has no steer API; the note cannot be delivered to a running turn')
    agent.steer(userMessage(`[dujiangyan note from the ${from}] ${text}`, taskId))
    this.events.append('task/steered', { taskId, sessionId, from, text: text.slice(0, 300) })
    return { taskId }
  }

  /** Whether `steer()` can reach this session right now (used to refuse a note before deciding). */
  canSteer(sessionId: string): boolean {
    if (!this.running.has(sessionId)) return false
    const live = this.ctx.agents.get(sessionId)
    return live === undefined || typeof live.steer === 'function'
  }

  /** Resources held by the task running on a root session (gate uses this for the bench rule). */
  /**
   * The bench rights of the task running on a root session: `command` (resource `bench`: the
   * machine is held only while a benchmark command runs), `task` (`bench:task`: the whole task holds
   * it), `shared` (`bench:shared`: may run benchmarks, holds nothing, results may be noisy).
   */
  benchMode(rootSessionId: string): BenchMode | undefined {
    const taskId = this.running.get(rootSessionId)
    const res = taskId === undefined ? [] : this.tasks.get(taskId)?.resources ?? []
    return res.includes('bench:task') ? 'task' : res.includes('bench') ? 'command' : res.includes('bench:shared') ? 'shared' : undefined
  }

  heldResources(rootSessionId: string): readonly string[] {
    const taskId = this.running.get(rootSessionId)
    if (taskId === undefined) return []
    // Trust the lease file, not memory: a lease taken over after our renewals stalled is no longer ours.
    return (this.tasks.get(taskId)?.holds ?? []).filter(name => this.leases.holder(name)?.holder === taskId)
  }

  runningTask(rootSessionId: string): string | undefined {
    return this.running.get(rootSessionId)
  }

  /**
   * The task whose turn the plugin stopped on this idle session less than `withinMs` ago. A call
   * arriving then comes from a turn that should have ended (findings 58), not from a person
   * typing in the session later.
   */
  stoppedTask(rootSessionId: string, withinMs = STRAY_WINDOW_MS): { taskId: string; status: TaskStatus } | undefined {
    if (this.running.has(rootSessionId)) return undefined
    const s = this.stopped.get(rootSessionId)
    return s !== undefined && Date.now() - s.at < withinMs ? { taskId: s.taskId, status: s.status } : undefined
  }

  /** The running task on a root session and the worker's latest assistant text (for approval context). */
  approvalContextFor(rootSessionId: string): { id: string; title?: string; prompt: string; lastAssistant?: string } | undefined {
    const taskId = this.running.get(rootSessionId)
    const rec = taskId === undefined ? undefined : this.tasks.get(taskId)
    if (rec === undefined) return undefined
    const last = this.collecting.get(rootSessionId)?.assistant.at(-1)
    return { id: rec.id, ...rec.title !== undefined ? { title: rec.title } : {}, prompt: rec.prompt, ...last !== undefined ? { lastAssistant: last } : {} }
  }

  private async run(rec: TaskRecord, signal: AbortSignal): Promise<void> {
    if (FINISHED_STATUSES.has(rec.status)) return // cancelled while queued
    try {
      if (signal.aborted) throw signal.reason
      // `bench` and `bench:shared` are rights, not task-long leases (the gate takes `bench` per command).
      const leases = [...new Set(rec.resources.map(leaseOf).filter((n): n is string => n !== undefined))].sort() // sorted order avoids lock-order deadlocks
      if (leases.length > 0) {
        this.update(rec, { status: 'waiting_resources' })
        for (const name of leases) {
          await this.leases.acquire(name, rec.id, signal)
          rec.holds.push(name)
          this.events.append('lease/acquired', { taskId: rec.id, name })
        }
      }
      await this.acquireSlot(rec, signal)
      await this.staggerStart(signal)
      const agent = await this.sessions.agent(rec.sessionId)
      this.running.set(rec.sessionId, rec.id)
      this.stopped.delete(rec.sessionId)
      this.update(rec, { status: 'running', startedAt: new Date().toISOString() })
      const cwd = this.registry.get(rec.sessionId)?.cwd
      const roots = this.config.workspaceRoots.length > 0 ? this.config.workspaceRoots : [cwd ?? process.cwd()]
      const facts = describeFacts(measureFacts(roots, this.config.permissionPreset), this.localFacts(cwd))
      for (let attempt = 1; ; attempt++) {
        this.collecting.set(rec.sessionId, { rec, assistant: [], toolCalls: [], toolResults: 0, errors: [] })
        // `whenIdle()` resolves at once while the agent has not yet picked the followup up,
        // so first wait for it to start running (or to error out), then for idle.
        const started = this.waitForRun(agent, signal)
        agent.followup(userMessage(`${rec.prompt}\n${WORKER_FOOTER}\n${facts}`, rec.id))
        await started
        await agent.whenIdle()
        if (rec.status === 'interrupted' || signal.aborted) break
        const c = this.collecting.get(rec.sessionId)
        // Right after a desktop restart the first turn can fail before the host has finished
        // assembling its prompt ("prompt variable "{{model}}" has no value …"). Nothing ran; retry.
        const startupFailure = c !== undefined && c.assistant.length === 0 && c.toolCalls.length === 0 && c.errors.some(e => STARTUP_ERROR.test(e))
        if (!startupFailure || attempt > this.config.startupRetryDelaysMs.length) break
        const delayMs = this.config.startupRetryDelaysMs[attempt - 1] as number
        this.events.append('task/retry', { taskId: rec.id, sessionId: rec.sessionId, attempt, delayMs, error: (c?.errors.at(-1) ?? '').slice(0, 300) })
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, delayMs)
          signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
        })
        if (signal.aborted) break
      }
      // A turn cut off by the output-token ceiling (typically one huge file write) is not finished:
      // ask the worker to continue in smaller pieces instead of reporting the half-done task as done.
      for (let n = 1; ; n++) {
        const cut = this.collecting.get(rec.sessionId)
        if (cut === undefined || cut.endReason !== 'max-tokens' || signal.aborted || rec.status === 'interrupted' || this.endings.has(rec.id)) break
        if (n > MAX_TOKEN_CONTINUATIONS) {
          this.endings.set(rec.id, { status: 'needs_attention', note: `the worker's turn hit the output-token limit ${MAX_TOKEN_CONTINUATIONS + 1} times in a row; the task is unfinished` })
          rec.attention = 'turns keep hitting the output-token limit; split the task or ask for smaller steps'
          break
        }
        cut.endReason = undefined
        this.events.append('task/continued', { taskId: rec.id, sessionId: rec.sessionId, reason: 'max-tokens', continuation: n })
        const started = this.waitForRun(agent, signal)
        agent.followup(userMessage(MAX_TOKENS_CONTINUE, rec.id))
        await started
        await agent.whenIdle()
      }
      if (rec.status === 'interrupted') return // stop() already recorded the outcome
      const c = this.collecting.get(rec.sessionId)
      const ending = this.endings.get(rec.id)
      if (ending !== undefined) {
        rec.result = this.resultOf(c, [ending.note])
        this.update(rec, { status: ending.status, ...ending.status === 'error' ? { error: ending.note } : {}, finishedAt: new Date().toISOString() })
        return
      }
      if (c !== undefined && c.assistant.length === 0 && c.errors.some(e => /\babort(ed)?\b|\binterrupt/i.test(e)) && !signal.aborted) {
        // The turn was aborted from outside (host or user stop button), not by the orchestrator.
        rec.result = this.resultOf(c, [INTERRUPTED])
        markInterrupted(rec)
        this.update(rec, {})
        return
      }
      if (c !== undefined && c.errors.length > 0 && c.assistant.length === 0) {
        throw new Error(`the worker turn failed: ${c.errors.join('; ')}`)
      }
      rec.result = this.resultOf(c, [])
      this.update(rec, { status: signal.aborted ? 'cancelled' : 'done', finishedAt: new Date().toISOString() })
    } catch (err) {
      if (rec.status === 'interrupted' || this.stopping) return
      const ending = this.endings.get(rec.id)
      if (ending !== undefined) {
        rec.result = this.resultOf(this.collecting.get(rec.sessionId), [ending.note])
        this.update(rec, { status: ending.status, ...ending.status === 'error' ? { error: ending.note } : {}, finishedAt: new Date().toISOString() })
        return
      }
      this.update(rec, {
        status: signal.aborted ? 'cancelled' : 'error',
        error: err instanceof Error ? err.message : String(err),
        finishedAt: new Date().toISOString(),
      })
    } finally {
      this.collecting.delete(rec.sessionId)
      this.releaseSlot(rec)
      if (this.running.get(rec.sessionId) === rec.id) this.running.delete(rec.sessionId)
      if (STOPPED_STATUSES.has(rec.status) || this.endings.has(rec.id)) this.stopped.set(rec.sessionId, { taskId: rec.id, status: rec.status, at: Date.now() })
      for (const name of rec.holds) {
        this.leases.release(name, rec.id)
        this.events.append('lease/released', { taskId: rec.id, name })
      }
      rec.holds = []
      this.controllers.delete(rec.id)
      this.endings.delete(rec.id)
      this.persist()
    }
  }

  private readonly slotHolders = new Set<string>()
  private readonly slotWaiters: Array<() => void> = []

  /** Optional local-load cap (config.maxActiveSessions > 0); unlimited by default. */
  private async acquireSlot(rec: TaskRecord, signal: AbortSignal): Promise<void> {
    const cap = this.config.maxActiveSessions
    if (cap <= 0) return
    while (this.slotHolders.size >= cap) {
      if (rec.status !== 'waiting_slot') this.update(rec, { status: 'waiting_slot' })
      await new Promise<void>(resolve => {
        this.slotWaiters.push(resolve)
        // A cancelled waiter must leave the queue, or releaseSlot wakes it instead of a live one.
        signal.addEventListener('abort', () => {
          const i = this.slotWaiters.indexOf(resolve)
          if (i >= 0) this.slotWaiters.splice(i, 1)
          resolve()
        }, { once: true })
      })
      if (signal.aborted) throw signal.reason
    }
    this.slotHolders.add(rec.id)
  }

  private releaseSlot(rec: TaskRecord): void {
    if (this.slotHolders.delete(rec.id)) this.slotWaiters.shift()?.()
  }

  /** Number of tasks currently running (for status). */
  get active(): number {
    return [...this.tasks.values()].filter(t => t.status === 'running').length
  }

  /** Optional prefix-cache experiment: later starts wait behind a leader's first response. */
  private async staggerStart(signal: AbortSignal): Promise<void> {
    const s = this.config.stagger
    if (!s.enabled) return
    const now = Date.now()
    if (now - this.lastStartAt > 60_000) {
      this.lastStartAt = now
      this.leaderStartAt = now
      return // the leader of a new burst starts at once
    }
    const leaderAt = this.leaderStartAt
    await new Promise<void>(resolve => {
      const timer = setTimeout(done, s.leaderWaitMs)
      const off = this.usage.onFinish(() => {
        if (Date.now() > leaderAt) done()
      })
      signal.addEventListener('abort', done, { once: true })
      function done() {
        clearTimeout(timer)
        off()
        resolve()
      }
    })
    const gap = s.baseMs + Math.floor(Math.random() * s.jitterMs)
    const wait = Math.max(0, this.lastStartAt + gap - Date.now())
    this.lastStartAt = Date.now() + wait
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
  }

  private readonly collecting = new Map<string, { rec: TaskRecord; assistant: string[]; toolCalls: Array<{ name: string; args: string }>; toolResults: number; errors: string[]; endReason?: string }>()

  /** Resolve once the agent reports `running`, an error, or after a grace period (already-running agents). */
  private waitForRun(agent: { session: HostSession; status?: string }, signal: AbortSignal): Promise<void> {
    return new Promise<void>(resolve => {
      const offs: Array<() => void> = []
      const done = () => {
        for (const off of offs) off()
        clearTimeout(timer)
        resolve()
      }
      const mine = (a: { session?: HostSession } | undefined) => a?.session?.id === agent.session.id
      offs.push(this.ctx.on('agent/status', (p: { agent?: { session?: HostSession }; status?: string }) => {
        if (mine(p.agent) && p.status === 'running') done()
      }))
      offs.push(this.ctx.on('agent/error', (p: { agent?: { session?: HostSession } }) => {
        if (mine(p.agent)) done()
      }))
      signal.addEventListener('abort', done, { once: true })
      const timer = setTimeout(done, 30_000)
    })
  }

  private onSessionEvent(session: HostSession, event: SessionEvent): void {
    const root = this.registry.rootOf(session)
    if (root === undefined) return
    const c = this.collecting.get(root)
    const data = (event.data ?? {}) as Record<string, any>
    if (event.type === 'tool/call') {
      const call = { name: String(data['name'] ?? '?'), args: String(data['arguments'] ?? JSON.stringify(data['input'] ?? null)).slice(0, 500) }
      if (c !== undefined && session.id === root) c.toolCalls.push(call)
      this.events.append('task/tool-call', { taskId: c?.rec.id, sessionId: session.id, root, tool: call.name, args: call.args.slice(0, 200) })
    } else if (event.type === 'turn/end' && c !== undefined && session.id === root) {
      const kind = (data['reason'] as { kind?: unknown } | null | undefined)?.kind
      c.endReason = typeof kind === 'string' ? kind : undefined
    } else if (event.type === 'tool/result') {
      if (c !== undefined && session.id === root) c.toolResults++
    } else if (event.type === 'assistant/message' && c !== undefined && session.id === root) {
      const content = data['message']?.content as Array<{ type?: string; text?: string }> | undefined
      const text = (content ?? []).filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text as string).join('\n')
      if (text !== '') {
        c.assistant.push(text)
        c.rec.latest = redactSecrets(text).replace(/\s+/g, ' ').trim().slice(-300)
      }
    }
  }

  private resultOf(c: { assistant: string[]; toolCalls: Array<{ name: string; args: string }>; toolResults: number; errors: string[] } | undefined, extraErrors: readonly string[]): TaskResult {
    const assistantText = (c?.assistant.join('\n') ?? '').slice(-MAX_TEXT)
    return {
      errors: [...c?.errors ?? [], ...extraErrors],
      assistantText,
      toolCalls: (c?.toolCalls ?? []).slice(-50),
      toolResultCount: c?.toolResults ?? 0,
      summary: parseSummary(assistantText),
    }
  }

  /** A finished task takes its evidence out of the recorder into its own record. */
  private attachEvidence(rec: TaskRecord): void {
    const ev = this.evidence?.take(rec.id)
    if (ev === undefined) return
    // tasks.json keeps the last 500 tasks: persist only the tail of the command list (all checks stay).
    rec.evidence = ev.commands.length > PERSISTED_COMMANDS ? { ...ev, commands: ev.commands.slice(-PERSISTED_COMMANDS), truncated: true } : ev
  }

  /** The task record, with the live evidence while it still runs. */
  view(taskId: string): TaskRecord | undefined {
    const rec = this.tasks.get(taskId)
    if (rec === undefined || rec.evidence !== undefined) return rec
    const live = this.evidence?.get(taskId)
    return live === undefined ? rec : { ...rec, evidence: live }
  }

  private update(rec: TaskRecord, patch: Partial<TaskRecord>): void {
    Object.assign(rec, patch)
    if (FINISHED_STATUSES.has(rec.status)) this.attachEvidence(rec)
    this.persist()
    this.events.append(`task/${rec.status}`, {
      taskId: rec.id,
      sessionId: rec.sessionId,
      ...rec.error !== undefined ? { error: rec.error } : {},
      ...rec.result !== undefined ? { summary: rec.result.summary } : {},
    })
  }

  private persist(): void {
    const all = [...this.tasks.values()]
    const keep = all.length > 500 ? all.slice(-500) : all
    writeJsonAtomic(this.file, keep)
  }
}

function markInterrupted(rec: TaskRecord): void {
  rec.status = 'interrupted'
  rec.error = INTERRUPTED
  rec.holds = []
  rec.finishedAt ??= new Date().toISOString()
  if (rec.result === undefined) rec.result = { errors: [INTERRUPTED], assistantText: '', toolCalls: [], toolResultCount: 0, summary: { changes: '', verification: '', leftovers: '' } }
  else if (!rec.result.errors.includes(INTERRUPTED)) rec.result.errors.push(INTERRUPTED)
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v)
    Object.freeze(value)
  }
  return value
}

/**
 * The same shape `createUserMessage` (dsh-llm 0.2.1-rc.2) builds: a detached,
 * frozen message with a fresh id. Built locally so the plugin carries no
 * runtime dependency on a host package that a `link:` install might resolve
 * to a second copy.
 */
const MAX_TOKEN_CONTINUATIONS = 3
const MAX_TOKENS_CONTINUE = '[dujiangyan] Your previous reply hit the output-token limit and was cut off, so the task is not finished. Continue from where you stopped. Write large files in several smaller steps (create the file, then append or edit it in pieces) instead of one huge write, and end with the summary the task asks for.'

export function userMessage(text: string, taskId: string): unknown {
  return deepFreeze({
    role: 'user',
    content: [{ type: 'text', text }],
    // Session format v4 refuses the retired `{ kind: 'plugin' }` wrapper; producers own their kind
    // (cf. `{ kind: 'goal', goalId, … }` in goal-round-driver). Observed on 0.2.1-rc.2:
    // "format v4 message requires a producer-owned source kind".
    source: { kind: 'dujiangyan-dispatch', taskId },
    id: randomUUID(),
  })
}

/** The last `{changes, verification, leftovers}` JSON object in the text (also accepts 改动/验证/遗留). */
export function parseSummary(text: string): TaskResult['summary'] {
  // Values may contain braces ("25×{1,20} threads"), so each `{` is matched to its closing brace
  // outside strings instead of matching brace-free spans.
  for (let start = text.lastIndexOf('{'); start >= 0; start = start === 0 ? -1 : text.lastIndexOf('{', start - 1)) {
    const end = closingBrace(text, start)
    if (end < 0) continue
    try {
      const obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
      if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) continue
      const s = (...keys: string[]) => {
        for (const k of keys) {
          const v = obj[k]
          if (typeof v === 'string') return v
          if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.join('; ')
        }
        return ''
      }
      const summary = { changes: s('changes', '改动'), verification: s('verification', '验证'), leftovers: s('leftovers', '遗留', 'leftover') }
      if (summary.changes !== '' || summary.verification !== '' || summary.leftovers !== '') return summary
    } catch {
      // Not JSON; try an earlier candidate.
    }
  }
  return { changes: '', verification: '', leftovers: '' }
}

/** Index of the `}` closing the `{` at `start`, skipping braces inside JSON strings; -1 if none. */
function closingBrace(text: string, start: number): number {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return i
  }
  return -1
}
