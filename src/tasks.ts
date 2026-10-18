/**
 * Tasks: one prompt delivered to one dispatched session, run serially per
 * session, after the task's declared resources (e.g. the exclusive `bench`
 * lease) are held. Progress streams into the event log from `session/event`;
 * the final result is the assistant text, the tool calls, and the one-line
 * JSON summary the worker is asked to end with.
 */
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { ResolvedConfig } from './config.ts'
import type { EventLog } from './events.ts'
import type { HostContext, HostSession, SessionEvent } from './host.ts'
import type { UsageMeter } from './llm-hooks.ts'
import type { LeaseManager } from './locks.ts'
import type { DispatchRegistry } from './registry.ts'
import type { SessionManager } from './sessions.ts'
import { readJson, writeJsonAtomic } from './store.ts'

export type TaskStatus = 'queued' | 'waiting_resources' | 'waiting_slot' | 'running' | 'done' | 'error' | 'cancelled'

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
}

const MAX_TEXT = 8000

/**
 * Appended to every task prompt. Each line encodes a failure observed in real runs
 * (see LESSONS.md) so workers avoid it instead of rediscovering it.
 */
const WORKER_FOOTER = [
  '',
  '[dujiangyan] Work only inside the session workspace. Some actions are gated: if a call is denied, read the reason and adapt instead of working around it.',
  'Environment problems (permissions, ACLs, missing tools) are reported, not repaired: describe them in "leftovers". Never run icacls/Set-Acl/takeown or change sandbox settings.',
  'If a write is "access denied" inside the workspace on Windows, the directory is probably missing the sandbox integrity label — stop and report the directory path; do not grant yourself permissions.',
  'Benchmarks (cargo bench, bench*.py/ps1/sh, criterion) only run inside tasks that hold the "bench" resource; in other tasks prepare and build, but do not measure.',
  'On Windows the shell tool is pwsh: use PowerShell syntax; forward slashes in paths work and avoid escaping problems.',
  'Do not ask the user questions (no one is watching this session); put open questions in "leftovers".',
  'When you finish, end with exactly one line of JSON (no code fence):',
  '{"changes":"what you changed","verification":"how you verified it","leftovers":"open issues or questions"}',
].join('\n')

export class TaskManager {
  private readonly tasks = new Map<string, TaskRecord>()
  private readonly chains = new Map<string, Promise<void>>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly running = new Map<string, string>() // root session → task id
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

  constructor(deps: {
    ctx: HostContext; config: ResolvedConfig; sessions: SessionManager; registry: DispatchRegistry
    leases: LeaseManager; events: EventLog; usage: UsageMeter
  }) {
    this.ctx = deps.ctx
    this.config = deps.config
    this.sessions = deps.sessions
    this.registry = deps.registry
    this.leases = deps.leases
    this.events = deps.events
    this.usage = deps.usage
    this.file = path.join(deps.config.stateDir, 'tasks.json')
    for (const rec of readJson<TaskRecord[]>(this.file, [])) {
      // A task that was in flight when the host stopped did not finish; say so instead of resuming blindly.
      if (rec.status === 'queued' || rec.status === 'waiting_resources' || rec.status === 'waiting_slot' || rec.status === 'running') {
        rec.status = 'error'
        rec.error = 'interrupted: the host stopped before this task finished; resubmit it if still needed'
        rec.holds = []
      }
      this.tasks.set(rec.id, rec)
    }
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

  async cancel(id: string): Promise<boolean> {
    const rec = this.tasks.get(id)
    if (rec === undefined || rec.status === 'done' || rec.status === 'error' || rec.status === 'cancelled') return false
    this.controllers.get(id)?.abort(new Error('cancelled by orchestrator'))
    if (rec.status === 'running') {
      try {
        ;(await this.sessions.agent(rec.sessionId)).cancel()
      } catch {
        // The session may already be gone.
      }
    }
    return true
  }

  /** Resources held by the task running on a root session (gate uses this for the bench rule). */
  heldResources(rootSessionId: string): readonly string[] {
    const taskId = this.running.get(rootSessionId)
    return taskId === undefined ? [] : this.tasks.get(taskId)?.holds ?? []
  }

  runningTask(rootSessionId: string): string | undefined {
    return this.running.get(rootSessionId)
  }

  private async run(rec: TaskRecord, signal: AbortSignal): Promise<void> {
    try {
      if (signal.aborted) throw signal.reason
      if (rec.resources.length > 0) {
        this.update(rec, { status: 'waiting_resources' })
        for (const name of [...rec.resources].sort()) { // sorted order avoids lock-order deadlocks
          await this.leases.acquire(name, rec.id, signal)
          rec.holds.push(name)
          this.events.append('lease/acquired', { taskId: rec.id, name })
        }
      }
      await this.acquireSlot(rec, signal)
      await this.staggerStart(signal)
      const agent = await this.sessions.agent(rec.sessionId)
      this.running.set(rec.sessionId, rec.id)
      this.update(rec, { status: 'running', startedAt: new Date().toISOString() })
      this.collecting.set(rec.sessionId, { rec, assistant: [], toolCalls: [], toolResults: 0, errors: [] })
      // `whenIdle()` resolves at once while the agent has not yet picked the followup up,
      // so first wait for it to start running (or to error out), then for idle.
      const started = this.waitForRun(agent, signal)
      agent.followup(userMessage(`${rec.prompt}\n${WORKER_FOOTER}`, rec.id))
      await started
      await agent.whenIdle()
      const c = this.collecting.get(rec.sessionId)
      if (c !== undefined && c.errors.length > 0 && c.assistant.length === 0) {
        throw new Error(`the worker turn failed: ${c.errors.join('; ')}`)
      }
      const assistantText = (c?.assistant.join('\n') ?? '').slice(-MAX_TEXT)
      rec.result = {
        errors: c?.errors ?? [],
        assistantText,
        toolCalls: (c?.toolCalls ?? []).slice(-50),
        toolResultCount: c?.toolResults ?? 0,
        summary: parseSummary(assistantText),
      }
      this.update(rec, { status: signal.aborted ? 'cancelled' : 'done', finishedAt: new Date().toISOString() })
    } catch (err) {
      this.update(rec, {
        status: signal.aborted ? 'cancelled' : 'error',
        error: err instanceof Error ? err.message : String(err),
        finishedAt: new Date().toISOString(),
      })
    } finally {
      this.collecting.delete(rec.sessionId)
      this.releaseSlot(rec)
      if (this.running.get(rec.sessionId) === rec.id) this.running.delete(rec.sessionId)
      for (const name of rec.holds) {
        this.leases.release(name, rec.id)
        this.events.append('lease/released', { taskId: rec.id, name })
      }
      rec.holds = []
      this.controllers.delete(rec.id)
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
        signal.addEventListener('abort', () => resolve(), { once: true })
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

  private readonly collecting = new Map<string, { rec: TaskRecord; assistant: string[]; toolCalls: Array<{ name: string; args: string }>; toolResults: number; errors: string[] }>()

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
    } else if (event.type === 'tool/result') {
      if (c !== undefined && session.id === root) c.toolResults++
    } else if (event.type === 'assistant/message' && c !== undefined && session.id === root) {
      const content = data['message']?.content as Array<{ type?: string; text?: string }> | undefined
      const text = (content ?? []).filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text as string).join('\n')
      if (text !== '') c.assistant.push(text)
    }
  }

  private update(rec: TaskRecord, patch: Partial<TaskRecord>): void {
    Object.assign(rec, patch)
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
  const candidates = text.match(/\{[^{}]*\}/g) ?? []
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(candidates[i] as string) as Record<string, unknown>
      const s = (...keys: string[]) => {
        for (const k of keys) if (typeof obj[k] === 'string') return obj[k] as string
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
