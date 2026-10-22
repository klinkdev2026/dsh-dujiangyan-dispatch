/**
 * Which sessions belong to the dispatch lineage.
 *
 * Root sessions are the ones this plugin created; they are persisted so the
 * gate keeps guarding them across a desktop restart. Any session whose
 * `header.parentSession` chain reaches a root (in-process subagents, agent-team
 * members) is in the lineage too and passes through the same gate. Sessions the
 * user opens by hand in the desktop UI are never touched.
 */
import path from 'node:path'
import type { Judge } from './ai-approval.ts'
import type { RouteEntry } from './config.ts'
import type { HostAgent, HostContext, HostSession, SessionsService } from './host.ts'
import { optional } from './host.ts'
import { readJson, writeJsonAtomic } from './store.ts'

export interface DispatchedSession {
  readonly sessionId: string
  readonly role?: string
  readonly title?: string
  /** Which orchestrator created it (claude, codex, …). */
  readonly createdBy?: string
  /** Dispatch batch: one orchestrator run (MCP connection) unless the caller names it. */
  readonly batch?: string
  readonly cwd: string
  /** Paths (canonical, inside the roots) this session may write; absent = the whole workspace roots. */
  readonly writeScope?: readonly string[]
  /** The route chain; requests use its first healthy entry. */
  readonly chain: readonly RouteEntry[]
  /** AI approval judges of this session (set at create or by `djy_ai_approval_set`); absent = folder or global judges. */
  judges?: readonly Judge[]
  readonly createdAt: string
  closedAt?: string
}

const MAX_DEPTH = 8

export class DispatchRegistry {
  private readonly roots = new Map<string, DispatchedSession>()
  private readonly rootOfCache = new Map<string, string | null>()
  private readonly file: string
  private readonly ctx: HostContext

  constructor(ctx: HostContext, stateDir: string) {
    this.ctx = ctx
    this.file = path.join(stateDir, 'sessions.json')
    for (const rec of readJson<DispatchedSession[]>(this.file, [])) {
      if (rec.closedAt === undefined) this.roots.set(rec.sessionId, rec)
      else this.closed.push(rec)
    }
  }

  private readonly closed: DispatchedSession[] = []

  add(rec: DispatchedSession): void {
    this.roots.set(rec.sessionId, rec)
    this.rootOfCache.clear()
    this.persist()
  }

  close(sessionId: string): void {
    const rec = this.roots.get(sessionId)
    if (rec === undefined) return
    rec.closedAt = new Date().toISOString()
    this.roots.delete(sessionId)
    this.closed.push(rec)
    this.rootOfCache.clear()
    this.persist()
  }

  /** Give a session its own AI judges, or (`undefined`) return it to the folder or global ones. */
  setJudges(sessionId: string, judges: readonly Judge[] | undefined): boolean {
    const rec = this.roots.get(sessionId)
    if (rec === undefined) return false
    if (judges === undefined) delete rec.judges
    else rec.judges = judges
    this.persist()
    return true
  }

  get(sessionId: string): DispatchedSession | undefined {
    return this.roots.get(sessionId)
  }

  list(): DispatchedSession[] {
    return [...this.roots.values()]
  }

  get size(): number {
    return this.roots.size
  }

  /**
   * How the desktop currently sees a dispatched session: archived from the
   * sidebar (the user can do that at any time), present, or gone from every
   * workspace (then opening it would start an unrelated empty conversation).
   */
  desktopState(sessionId: string): 'active' | 'archived' | 'missing' | 'unknown' {
    const ws = optional<{ archivedSessionIds?: readonly string[]; list?: () => ReadonlyArray<{ sessionIds?: readonly string[] }> }>(this.ctx, 'workspaceRegistry')
    if (ws === undefined) return 'unknown'
    if (ws.archivedSessionIds?.includes(sessionId) === true) return 'archived'
    const views = ws.list?.()
    if (views === undefined) return 'unknown'
    return views.some(v => v.sessionIds?.includes(sessionId) === true) ? 'active' : 'missing'
  }

  /** The dispatch root a session descends from, or undefined when it is not in the lineage. */
  rootOf(agentOrSession: HostAgent | HostSession | undefined): string | undefined {
    if (agentOrSession === undefined) return undefined
    const session = 'session' in agentOrSession ? agentOrSession.session : agentOrSession
    const id = session.id ?? session.header.id
    const cached = this.rootOfCache.get(id)
    if (cached !== undefined) return cached ?? undefined
    let header = session.header
    let found: string | undefined
    for (let depth = 0; depth <= MAX_DEPTH; depth++) {
      const current = header.id ?? (depth === 0 ? id : undefined)
      if (current !== undefined && this.roots.has(current)) {
        found = current
        break
      }
      const parent = header.parentSession
      if (parent === undefined) break
      if (this.roots.has(parent)) {
        found = parent
        break
      }
      const next = this.headerOf(parent)
      if (next === undefined) break
      header = next
    }
    this.rootOfCache.set(id, found ?? null)
    return found
  }

  private headerOf(id: string): HostSession['header'] | undefined {
    const live = this.ctx.agents.get(id)
    if (live !== undefined) return live.session.header
    return optional<SessionsService>(this.ctx, 'sessions')?.get?.(id)?.header
  }

  private persist(): void {
    if (this.closed.length > 200) this.closed.splice(0, this.closed.length - 200)
    writeJsonAtomic(this.file, [...this.closed, ...this.roots.values()])
  }
}
