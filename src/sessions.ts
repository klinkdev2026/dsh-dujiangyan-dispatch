/**
 * Worker sessions: created with a validated route chain, the configured agent
 * preset, and the `workspace-write` permission preset, then registered as
 * dispatch roots so the gate guards them and everything they spawn.
 */
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { ResolvedConfig, RouteEntry } from './config.ts'
import type { EventLog } from './events.ts'
import type {
  AgentHandle, AgentPresetRegistry, HostAgent, HostContext, PermissionPresets, WorkspaceRegistry,
} from './host.ts'
import { DISPATCH_CANCEL, optional } from './host.ts'
import { canonicalPath, isWithinAny } from './paths.ts'
import { preflightWorkspace, type PreflightIssue } from './preflight.ts'
import type { RouteHealth } from './llm-hooks.ts'
import type { DispatchRegistry } from './registry.ts'

export interface CreateSessionInput {
  readonly role?: string
  readonly route?: RouteEntry
  /** Fallback routes tried in order after `route` (forms the session's chain). */
  readonly fallbacks?: readonly RouteEntry[]
  readonly cwd: string
  readonly title?: string
  /** Create the session even when preflight reports issues. */
  readonly ignorePreflight?: boolean
  /** The MCP client that asked (e.g. claude-code, codex); shown as a title prefix. */
  readonly createdBy?: string
  /** Batch label grouping sessions of one dispatch run. */
  readonly batch?: string
  /**
   * Paths the session may write (inside the roots). Default: the cwd when it is a strict
   * subdirectory of a root (one spike folder), else the whole roots (unchanged behaviour).
   */
  readonly writeScope?: readonly string[]
}

/** A question a worker put to the user (`user-questions/request`), handed to the orchestrator instead. */
export interface WorkerQuestion {
  readonly id: string
  readonly question: string
  readonly detail?: string
  readonly options?: ReadonlyArray<{ label: string }>
}

/** What a session does with a question nobody is there to answer. */
export type QuestionHandler = (sessionId: string, questions: readonly WorkerQuestion[]) => void

export type CreateSessionResult =
  | { readonly ok: true; readonly sessionId: string; readonly route: RouteEntry; readonly chain: readonly RouteEntry[]; readonly skippedRoutes: ReadonlyArray<{ route: RouteEntry; error: string }>; readonly warnings: readonly string[]; readonly writeScope?: readonly string[] }
  | { readonly ok: false; readonly error: string; readonly preflight?: readonly PreflightIssue[] }

export class SessionManager {
  private readonly handles = new Map<string, AgentHandle>()
  private readonly ctx: HostContext
  private readonly config: ResolvedConfig
  private readonly registry: DispatchRegistry
  private readonly events: EventLog
  private readonly health: RouteHealth | undefined
  /** Set by the task manager: records the question on the running task and ends its turn. */
  onQuestion: QuestionHandler | undefined

  constructor(ctx: HostContext, config: ResolvedConfig, registry: DispatchRegistry, events: EventLog, health?: RouteHealth) {
    this.health = health
    this.ctx = ctx
    this.config = config
    this.registry = registry
    this.events = events
  }

  /** Validate each route against the host's adapters; keep the usable ones in order. */
  async validateChain(chain: readonly RouteEntry[]): Promise<{ valid: RouteEntry[]; skipped: Array<{ route: RouteEntry; error: string }> }> {
    const valid: RouteEntry[] = []
    const skipped: Array<{ route: RouteEntry; error: string }> = []
    for (const route of chain) {
      if (this.health?.isBroken(route) === true) {
        skipped.push({ route, error: 'route is benched after a deterministic failure (see djy_status.routeHealth); probe it again with djy_routes_probe' })
        continue
      }
      try {
        await this.ctx.llm.resolveCallConfig({
          provider: route.provider,
          model: route.model,
          ...route.effort !== undefined ? { reasoningEffort: route.effort } : {},
        })
        valid.push(route)
      } catch (err) {
        skipped.push({ route, error: err instanceof Error ? err.message : String(err) })
      }
    }
    return { valid, skipped }
  }

  async create(input: CreateSessionInput): Promise<CreateSessionResult> {
    const cwd = canonicalPath(input.cwd)
    const roots = this.config.workspaceRoots
    const howToAdd = `the user can add a root to "workspaceRoots" in ${path.join(this.config.stateDir, 'local-rules.json')} (applies at once, no restart) or to the profile row`
    if (roots.length === 0) return { ok: false, error: `no workspace roots configured; ${howToAdd}` }
    if (!isWithinAny(roots, cwd)) return { ok: false, error: `cwd ${cwd} is outside the workspace roots (${roots.join(', ')}); ${howToAdd}` }
    if (this.config.maxSessions > 0 && this.registry.size >= this.config.maxSessions) {
      return { ok: false, error: `maxSessions (${this.config.maxSessions}) reached; reuse an existing session (djy_session_list) or close one` }
    }
    const chain = input.route !== undefined ? [input.route, ...(input.fallbacks ?? [])] : this.config.roster[input.role ?? 'implementer']
    if (chain === undefined || chain.length === 0) return { ok: false, error: `unknown role "${input.role}" and no explicit route` }
    const scope = this.resolveWriteScope(cwd, input.writeScope)
    if ('error' in scope) return { ok: false, error: scope.error }
    const { valid, skipped } = await this.validateChain(chain)
    const primary = valid[0]
    if (primary === undefined) {
      return { ok: false, error: `no usable route: ${skipped.map(s => `${s.route.provider}/${s.route.model}: ${s.error}`).join('; ')}` }
    }

    const warnings: string[] = []
    if (this.config.preflight && input.ignorePreflight !== true) {
      const issues = await preflightWorkspace(cwd, this.config.permissionPreset)
      if (issues.length > 0) {
        return { ok: false, error: 'workspace preflight found issues the sandbox will trip over; fix them (or pass ignorePreflight) first', preflight: issues }
      }
    }

    // Same id shape as the desktop's own sessions (api/session-controller mints `session-${uuid}`).
    const sessionId = `session-${randomUUID()}`
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: { cwd, agentPreset: this.config.agentPreset },
      agentOptions: {
        provider: primary.provider,
        model: primary.model,
        ...primary.effort !== undefined ? { reasoningEffort: primary.effort } : {},
      },
      setup: async agentCtx => {
        try {
          await optional<AgentPresetRegistry>(this.ctx, 'agentPresets')?.mount(agentCtx, this.config.agentPreset)
        } catch (err) {
          warnings.push(`agent preset "${this.config.agentPreset}" not mounted: ${err instanceof Error ? err.message : String(err)}`)
        }
        this.installQuestionHandoff(agentCtx, sessionId)
      },
    })
    const session = handle.agent.session
    try {
      optional<PermissionPresets>(this.ctx, 'permissionPresets')?.set(session, this.config.permissionPreset)
    } catch (err) {
      warnings.push(`permission preset "${this.config.permissionPreset}" not applied: ${err instanceof Error ? err.message : String(err)}`)
    }
    await this.attachWorkspace(cwd, sessionId, warnings)
    const who = clientLabel(input.createdBy)
    const title = `[${who}] ${input.title ?? `${input.role ?? 'worker'} ${primary.provider}/${primary.model}`}`
    this.rename(session, title, warnings)

    this.handles.set(sessionId, handle)
    this.registry.add({
      sessionId,
      ...input.role !== undefined ? { role: input.role } : {},
      title,
      createdBy: who,
      ...input.batch !== undefined ? { batch: input.batch } : {},
      cwd,
      ...scope.scope !== undefined ? { writeScope: scope.scope } : {},
      chain: valid,
      createdAt: new Date().toISOString(),
    })
    this.events.append('session/created', { sessionId, title, createdBy: who, batch: input.batch, role: input.role, route: `${primary.provider}/${primary.model}`, cwd, warnings })
    return { ok: true, sessionId, route: primary, chain: valid, skippedRoutes: skipped, warnings, ...scope.scope !== undefined ? { writeScope: scope.scope } : {} }
  }

  /** The canonical write scope for a new session, or an error when a path is outside the roots. */
  private resolveWriteScope(cwd: string, requested: readonly string[] | undefined): { scope?: string[] } | { error: string } {
    const roots = this.config.workspaceRoots
    if (requested !== undefined && requested.length > 0) {
      const scope = requested.map(p => canonicalPath(p))
      const outside = scope.filter(p => !isWithinAny(roots, p))
      if (outside.length > 0) return { error: `writeScope must stay inside the workspace roots (${roots.join(', ')}): ${outside.join(', ')}` }
      return { scope }
    }
    // A cwd that IS a root keeps the old behaviour (whole roots); a spike folder below a root is its own scope.
    const isRoot = roots.some(r => isWithinAny([cwd], r) && isWithinAny([r], cwd))
    return isRoot ? {} : { scope: [cwd] }
  }

  /**
   * Prior art: dsh-crew worker-question.mjs. No one answers a dispatched worker's question, so the
   * request must not hang: hand it to the orchestrator (the task ends as needs_input) and refuse it.
   */
  private installQuestionHandoff(agentCtx: unknown, sessionId: string): void {
    const on = (agentCtx as { on?: HostContext['on'] } | undefined)?.on
    if (typeof on !== 'function') return
    on.call(agentCtx, 'user-questions/request', (request: { questions?: unknown }) => {
      const questions: WorkerQuestion[] = Array.isArray(request?.questions)
        ? (request.questions as Array<Record<string, unknown>>).slice(0, 16).map(q => ({
            id: String(q['id'] ?? '').slice(0, 200),
            question: String(q['question'] ?? '').slice(0, 4000),
            ...typeof q['detail'] === 'string' ? { detail: (q['detail'] as string).slice(0, 12_000) } : {},
            ...Array.isArray(q['options']) ? { options: (q['options'] as Array<Record<string, unknown>>).slice(0, 32).map(o => ({ label: String(o['label'] ?? '').slice(0, 500) })) } : {},
          }))
        : []
      this.onQuestion?.(sessionId, questions)
      const error = new Error('No one is watching this session: the question was handed to the orchestrator and this turn stops. An unanswered question grants no permission.')
      error.name = 'UserQuestionError'
      ;(error as Error & { code?: string }).code = 'UNATTENDED_WORKER'
      return Promise.reject(error)
    }, { prepend: true })
  }

  /** The live agent for a dispatched session, resuming it after a host restart. */
  async agent(sessionId: string): Promise<HostAgent> {
    const handle = this.handles.get(sessionId)
    if (handle !== undefined) return handle.agent
    const rec = this.registry.get(sessionId)
    const live = this.ctx.agents.get(sessionId)
    if (live !== undefined) {
      if (rec !== undefined) this.applyPermissionPreset(live.session, sessionId)
      return live
    }
    if (rec === undefined) throw new Error(`session ${sessionId} is not a dispatched session`)
    // A cold resume does not restore the creation-time agent options: without them the
    // persona section's {{model}} has no value and every turn fails. Re-send the route
    // (first healthy one in the saved chain) and re-apply the permission preset.
    const route = rec.chain.find(r => this.health?.isBroken(r) !== true) ?? rec.chain[0]
    const resumed = await this.ctx.agents.resume({
      resumeSessionId: sessionId,
      ...route !== undefined
        ? { agentOptions: { provider: route.provider, model: route.model, ...route.effort !== undefined ? { reasoningEffort: route.effort } : {} } }
        : {},
      setup: async agentCtx => {
        await optional<AgentPresetRegistry>(this.ctx, 'agentPresets')?.mount(agentCtx, this.config.agentPreset)
        this.installQuestionHandoff(agentCtx, sessionId)
      },
    })
    try {
      this.applyPermissionPreset(resumed.agent.session, sessionId)
    } catch (err) {
      await resumed.dispose()
      throw err
    }
    this.handles.set(sessionId, resumed)
    return resumed.agent
  }

  async close(sessionId: string): Promise<boolean> {
    if (this.registry.get(sessionId) === undefined) return false
    const handle = this.handles.get(sessionId)
    this.handles.delete(sessionId)
    try {
      handle?.agent.cancel(DISPATCH_CANCEL)
      await handle?.dispose()
    } finally {
      this.registry.close(sessionId)
      this.events.append('session/closed', { sessionId })
    }
    return true
  }

  async disposeAll(): Promise<void> {
    for (const handle of this.handles.values()) {
      try {
        await handle.dispose()
      } catch {
        // Disposal is best-effort during plugin unload.
      }
    }
    this.handles.clear()
  }

  /** Re-apply the sandbox preset on a resumed session; refuse to hand out the session if that fails. */
  private applyPermissionPreset(session: HostAgent["session"], sessionId: string): void {
    const presets = optional<PermissionPresets>(this.ctx, 'permissionPresets')
    if (presets === undefined) return
    try {
      presets.set(session, this.config.permissionPreset)
    } catch (err) {
      throw new Error(`refusing to resume ${sessionId}: permission preset "${this.config.permissionPreset}" could not be re-applied (${err instanceof Error ? err.message : String(err)})`)
    }
  }

  private async attachWorkspace(cwd: string, sessionId: string, warnings: string[]): Promise<void> {
    const workspaces = optional<WorkspaceRegistry>(this.ctx, 'workspaceRegistry')
    if (workspaces === undefined) return
    try {
      const ws = (await workspaces.resolveByPath?.(cwd)) ?? (await workspaces.create?.(cwd))
      await ws?.attachSession?.(sessionId)
    } catch (err) {
      warnings.push(`workspace grouping failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private rename(session: unknown, title: string, warnings: string[]): void {
    try {
      optional<{ rename?: (s: unknown, t: string) => unknown }>(this.ctx, 'sessionTitle')?.rename?.(session, title)
    } catch (err) {
      warnings.push(`title not set: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/** Short, stable label for the client that created a session (MCP clientInfo.name). */
export function clientLabel(name: string | undefined): string {
  const n = (name ?? '').toLowerCase()
  if (n.includes('claude')) return 'claude'
  if (n.includes('codex')) return 'codex'
  return n.replace(/[^a-z0-9_-]+/g, '-').slice(0, 20) || 'mcp'
}
