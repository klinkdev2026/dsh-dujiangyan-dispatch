/**
 * Worker sessions: created with a validated route chain, the configured agent
 * preset, and the `workspace-write` permission preset, then registered as
 * dispatch roots so the gate guards them and everything they spawn.
 */
import { randomUUID } from 'node:crypto'
import type { ResolvedConfig, RouteEntry } from './config.ts'
import type { EventLog } from './events.ts'
import type {
  AgentHandle, AgentPresetRegistry, HostAgent, HostContext, PermissionPresets, WorkspaceRegistry,
} from './host.ts'
import { optional } from './host.ts'
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
}

export type CreateSessionResult =
  | { readonly ok: true; readonly sessionId: string; readonly route: RouteEntry; readonly chain: readonly RouteEntry[]; readonly skippedRoutes: ReadonlyArray<{ route: RouteEntry; error: string }>; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly error: string; readonly preflight?: readonly PreflightIssue[] }

export class SessionManager {
  private readonly handles = new Map<string, AgentHandle>()
  private readonly ctx: HostContext
  private readonly config: ResolvedConfig
  private readonly registry: DispatchRegistry
  private readonly events: EventLog
  private readonly health: RouteHealth | undefined

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
    if (roots.length === 0) return { ok: false, error: 'no workspaceRoots configured; set them in the dujiangyan-dispatch profile row' }
    if (!isWithinAny(roots, cwd)) return { ok: false, error: `cwd ${cwd} is outside the workspace roots (${roots.join(', ')})` }
    if (this.config.maxSessions > 0 && this.registry.size >= this.config.maxSessions) {
      return { ok: false, error: `maxSessions (${this.config.maxSessions}) reached; reuse an existing session (djy_session_list) or close one` }
    }
    const chain = input.route !== undefined ? [input.route, ...(input.fallbacks ?? [])] : this.config.roster[input.role ?? 'implementer']
    if (chain === undefined || chain.length === 0) return { ok: false, error: `unknown role "${input.role}" and no explicit route` }
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
      chain: valid,
      createdAt: new Date().toISOString(),
    })
    this.events.append('session/created', { sessionId, title, createdBy: who, batch: input.batch, role: input.role, route: `${primary.provider}/${primary.model}`, cwd, warnings })
    return { ok: true, sessionId, route: primary, chain: valid, skippedRoutes: skipped, warnings }
  }

  /** The live agent for a dispatched session, resuming it after a host restart. */
  async agent(sessionId: string): Promise<HostAgent> {
    const handle = this.handles.get(sessionId)
    if (handle !== undefined) return handle.agent
    const live = this.ctx.agents.get(sessionId)
    if (live !== undefined) return live
    const rec = this.registry.get(sessionId)
    if (rec === undefined) throw new Error(`session ${sessionId} is not a dispatched session`)
    const resumed = await this.ctx.agents.resume({
      resumeSessionId: sessionId,
      setup: async agentCtx => {
        await optional<AgentPresetRegistry>(this.ctx, 'agentPresets')?.mount(agentCtx, this.config.agentPreset)
      },
    })
    this.handles.set(sessionId, resumed)
    return resumed.agent
  }

  async close(sessionId: string): Promise<boolean> {
    if (this.registry.get(sessionId) === undefined) return false
    const handle = this.handles.get(sessionId)
    this.handles.delete(sessionId)
    try {
      handle?.agent.cancel()
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
