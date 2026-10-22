/**
 * Watchdog: nothing may wait silently.
 *
 * The approval chain had a single point of failure — an external orchestrator that must be awake —
 * and no alarm when it failed: approvals sat for the full timeout, a stuck task looked like a busy
 * one, and a failing AI judge quietly routed everything to humans. Every tick this module turns
 * those silent states into alerts (events, audit, the panel banner, desktop notifications from the
 * panel) and steers waiting workers so they do not rewrite a held call.
 */
import type { AiApproval } from './ai-approval.ts'
import type { ApprovalQueue } from './approvals.ts'
import type { ResolvedConfig } from './config.ts'
import type { EventLog } from './events.ts'
import type { TaskRecord } from './tasks.ts'

export type AlertKind = 'approval-aging' | 'ai-degraded' | 'task-stalled' | 'orchestrator-absent'

export interface HealthAlert {
  readonly id: string
  readonly kind: AlertKind
  readonly level: 'warn' | 'critical'
  readonly message: string
  readonly since: string
  readonly sessionId?: string
  readonly taskId?: string
  readonly approvalId?: string
}

export interface HealthBlock {
  readonly now: string
  readonly pendingApprovals: number
  readonly oldestPendingSec: number | undefined
  readonly ai: ReturnType<AiApproval['health']> & { readonly enabled: boolean }
  readonly stalledTasks: ReadonlyArray<{ taskId: string; sessionId: string; idleSec: number }>
  readonly waitingTasks: ReadonlyArray<{ taskId: string; sessionId: string; reason: string; untilSec: number | undefined }>
  readonly orchestratorLastSeenSec: number | undefined
  readonly alerts: readonly HealthAlert[]
}

export interface WatchdogDeps {
  readonly config: ResolvedConfig
  readonly approvals: ApprovalQueue
  readonly events: EventLog
  readonly audit: (record: Record<string, unknown>) => void
  readonly aiApproval: AiApproval
  readonly runningTasks: () => readonly TaskRecord[]
  readonly steer: (sessionId: string, text: string) => Promise<unknown>
  /** Milliseconds timestamp of the last authenticated MCP request (any orchestrator), if any. */
  readonly lastClientSeen: () => number | undefined
  readonly now?: () => number
}

interface Activity { at: number; waitUntil?: number; waitReason?: string }

/**
 * The longest wait a tool call's own timeout may excuse. The timeout comes from the worker's
 * arguments, so without a cap a huge value would silence the stall alarm (Kimi review, 2026-10-19).
 */
export const MAX_KNOWN_WAIT_MS = 60 * 60_000

/** Tool calls that legitimately block for a long time; their own timeout (capped) bounds the wait. */
function knownWait(tool: unknown, rawArgs: unknown): { reason: string; ms: number } | undefined {
  if (typeof rawArgs !== 'string') return undefined
  let args: Record<string, unknown>
  try {
    args = JSON.parse(rawArgs) as Record<string, unknown>
  } catch {
    return undefined
  }
  if (tool === 'job_output' && args['wait'] === true) {
    const ms = typeof args['timeout_ms'] === 'number' ? args['timeout_ms'] : 10 * 60_000
    return { reason: `waiting on background job ${String(args['job_id'] ?? '')} (job_output wait)`, ms: Math.min(ms, MAX_KNOWN_WAIT_MS) }
  }
  if (typeof args['timeoutMs'] === 'number' && args['timeoutMs'] > 60_000) {
    return { reason: `long ${String(tool)} call (timeout ${Math.round(args['timeoutMs'] / 60_000)} min): ${String(args['description'] ?? '').slice(0, 80)}`, ms: Math.min(args['timeoutMs'], MAX_KNOWN_WAIT_MS) }
  }
  return undefined
}

export class Watchdog {
  private readonly d: WatchdogDeps
  private readonly now: () => number
  private cursor = 0
  private epoch: string | undefined
  private readonly activity = new Map<string, Activity>()
  private readonly steered = new Set<string>()
  private readonly warned = new Map<string, number>()
  private readonly alerts = new Map<string, HealthAlert>()

  constructor(deps: WatchdogDeps) {
    this.d = deps
    this.now = deps.now ?? (() => Date.now())
    deps.aiApproval.onHealthChange = ({ judge, degraded, health }) => {
      const detail = { judge, error: health.lastError, consecutiveErrors: health.consecutiveErrors, source: health.source }
      this.d.events.append(degraded ? 'ai/degraded' : 'ai/recovered', detail)
      this.d.audit({ type: degraded ? 'ai/degraded' : 'ai/recovered', ...detail })
    }
  }

  /** Start the periodic tick; returns the stop function. The timer never keeps the host alive. */
  start(): () => void {
    const timer = setInterval(() => this.tick(), this.d.config.watchdog.intervalMs)
    timer.unref?.()
    return () => clearInterval(timer)
  }

  private raise(alert: Omit<HealthAlert, 'since'>, event: string, detail: Record<string, unknown>): void {
    if (this.alerts.has(alert.id)) return
    this.alerts.set(alert.id, { ...alert, since: new Date(this.now()).toISOString() })
    this.d.events.append(event, { ...detail, level: alert.level, message: alert.message })
    this.d.audit({ type: event, ...detail, level: alert.level })
  }

  private clear(prefix: string, keep: (id: string) => boolean): void {
    for (const id of [...this.alerts.keys()]) if (id.startsWith(prefix) && !keep(id)) this.alerts.delete(id)
  }

  /** One pass over approvals, tasks, AI health and orchestrator presence. */
  tick(): void {
    const now = this.now()
    const cfg = this.d.config.watchdog
    this.readActivity()
    const pending = this.d.approvals.list()
    const running = this.d.runningTasks()

    // 1. Approval aging: steer the waiting worker once, then alert at each threshold.
    for (const a of pending) {
      const age = now - Date.parse(a.createdAt)
      if (age >= cfg.steerAfterMs && !this.steered.has(a.id) && a.taskId !== undefined) {
        this.steered.add(a.id)
        this.d.steer(a.sessionId, `waiting for approval (${a.rule}): keep this call pending; do not rewrite it or try another way while it waits.`).catch(() => {})
      }
      const levels = cfg.warnAfterMs.filter(ms => age >= ms).length
      if (levels > (this.warned.get(a.id) ?? 0)) {
        this.warned.set(a.id, levels)
        const mins = Math.floor(age / 60_000)
        const level = levels >= cfg.warnAfterMs.length ? 'critical' : 'warn'
        this.alerts.delete(`approval:${a.id}`)
        this.raise(
          { id: `approval:${a.id}`, kind: 'approval-aging', level, message: `approval waiting ${mins} min: ${a.rule} (${a.tool})${a.context?.taskTitle !== undefined ? ` — ${a.context.taskTitle}` : ''}`, sessionId: a.sessionId, ...a.taskId !== undefined ? { taskId: a.taskId } : {}, approvalId: a.id },
          'approval/aging',
          { id: a.id, sessionId: a.sessionId, taskId: a.taskId, rule: a.rule, tool: a.tool, ageSec: Math.round(age / 1000) },
        )
      }
    }
    const pendingIds = new Set(pending.map(a => a.id))
    this.clear('approval:', id => pendingIds.has(id.slice('approval:'.length)))
    for (const id of [...this.steered]) if (!pendingIds.has(id)) this.steered.delete(id)
    for (const id of [...this.warned.keys()]) if (!pendingIds.has(id)) this.warned.delete(id)

    // 2. Stalled tasks: running, no activity for stallAfterMs, not waiting on an approval or a known long wait.
    const stalled = new Set<string>()
    for (const t of running) {
      const act = this.activity.get(t.id) ?? { at: Date.parse(t.startedAt ?? t.createdAt) }
      if (pending.some(a => a.taskId === t.id)) continue
      if (act.waitUntil !== undefined && now < act.waitUntil) continue
      const idle = now - act.at
      if (idle >= cfg.stallAfterMs) {
        stalled.add(t.id)
        this.raise(
          { id: `stall:${t.id}`, kind: 'task-stalled', level: 'warn', message: `task "${t.title ?? t.id}" has shown no activity for ${Math.round(idle / 60_000)} min`, sessionId: t.sessionId, taskId: t.id },
          'task/stalled',
          { taskId: t.id, sessionId: t.sessionId, idleSec: Math.round(idle / 1000) },
        )
      }
    }
    this.clear('stall:', id => stalled.has(id.slice('stall:'.length)))

    // 3. AI judges: mirror their health into the alert list (transitions are evented in onHealthChange).
    const ai = this.d.aiApproval.health()
    const enabled = this.d.aiApproval.current().enabled
    const degradedJudges = new Set<string>()
    if (enabled) {
      for (const j of ai.judges) {
        if (!('degraded' in j) || !j.degraded) continue
        degradedJudges.add(j.judge)
        if (!this.alerts.has(`ai:${j.judge}`)) {
          this.alerts.set(`ai:${j.judge}`, { id: `ai:${j.judge}`, kind: 'ai-degraded', level: 'critical', message: `AI judge ${j.judge} is failing (${j.lastError ?? 'error'}); every escalation now needs a human`, since: new Date(now).toISOString() })
        }
      }
    }
    this.clear('ai:', id => degradedJudges.has(id.slice('ai:'.length)))

    // 4. Orchestrator presence: approvals pending and no MCP client has called in a while.
    const seen = this.d.lastClientSeen()
    const absent = pending.length > 0 && (seen === undefined || now - seen >= cfg.orchestratorAbsentMs)
    if (absent) {
      this.raise(
        { id: 'orchestrator', kind: 'orchestrator-absent', level: 'critical', message: `${pending.length} approval(s) pending and no orchestrator has called for ${seen === undefined ? 'the whole session' : `${Math.round((now - seen) / 60_000)} min`}; decide them in this panel` },
        'orchestrator/absent',
        { pending: pending.length, lastSeenSec: seen === undefined ? undefined : Math.round((now - seen) / 1000) },
      )
    } else if (this.alerts.delete('orchestrator')) {
      this.d.events.append('orchestrator/back', {})
    }
  }

  /** Per-task activity from the event log (tool calls, approvals, steering, quiet-mode waits). */
  private readActivity(): void {
    const page = this.d.events.since(this.cursor, 1000, this.epoch)
    this.epoch = page.epoch
    this.cursor = page.cursor
    const bySession = new Map<string, string>()
    for (const t of this.d.runningTasks()) bySession.set(t.sessionId, t.id)
    for (const e of page.events) {
      const data = e.data as Record<string, unknown>
      const taskId = typeof data['taskId'] === 'string' ? data['taskId'] : typeof data['sessionId'] === 'string' ? bySession.get(data['sessionId']) : undefined
      if (taskId === undefined) continue
      const at = Date.parse(e.at)
      const act: Activity = { at }
      if (e.type === 'task/tool-call') {
        const wait = knownWait(data['tool'], data['args'])
        if (wait !== undefined) Object.assign(act, { waitUntil: at + wait.ms, waitReason: wait.reason })
      } else if (e.type === 'quiet/waiting') {
        Object.assign(act, { waitUntil: at + this.d.config.quietMode.maxWaitMs, waitReason: 'held by quiet mode while a benchmark runs' })
      }
      this.activity.set(taskId, act)
    }
    const live = new Set(this.d.runningTasks().map(t => t.id))
    for (const id of [...this.activity.keys()]) if (!live.has(id)) this.activity.delete(id)
  }

  snapshot(): HealthBlock {
    const now = this.now()
    const pending = this.d.approvals.list()
    const oldest = pending.reduce<number | undefined>((m, a) => {
      const age = now - Date.parse(a.createdAt)
      return m === undefined || age > m ? age : m
    }, undefined)
    const seen = this.d.lastClientSeen()
    const waiting = this.d.runningTasks().flatMap(t => {
      const act = this.activity.get(t.id)
      return act?.waitReason !== undefined && act.waitUntil !== undefined && now < act.waitUntil
        ? [{ taskId: t.id, sessionId: t.sessionId, reason: act.waitReason, untilSec: Math.round((act.waitUntil - now) / 1000) }]
        : []
    })
    return {
      now: new Date(now).toISOString(),
      pendingApprovals: pending.length,
      oldestPendingSec: oldest === undefined ? undefined : Math.round(oldest / 1000),
      ai: { ...this.d.aiApproval.health(), enabled: this.d.aiApproval.current().enabled },
      stalledTasks: [...this.alerts.values()].filter(a => a.kind === 'task-stalled').map(a => {
        const act = this.activity.get(a.taskId ?? '')
        return { taskId: a.taskId ?? '', sessionId: a.sessionId ?? '', idleSec: act === undefined ? 0 : Math.round((now - act.at) / 1000) }
      }),
      waitingTasks: waiting,
      orchestratorLastSeenSec: seen === undefined ? undefined : Math.round((now - seen) / 1000),
      alerts: [...this.alerts.values()],
    }
  }
}
