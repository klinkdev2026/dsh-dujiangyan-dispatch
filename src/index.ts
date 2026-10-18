/**
 * 都江堰 · DSH Agent Dispatch & Guard
 *
 *   鱼嘴 Yuzui        route chains per role; divert around unhealthy providers   (llm-hooks.ts, sessions.ts)
 *   飞沙堰 Feishayan  the permission gate and its escalation queue                (rules.ts, gate.ts, approvals.ts)
 *   宝瓶口 Baopingkou admission control per provider key                           (limiter.ts)
 *   灌区 (天府)       the dispatched sessions, tasks, leases                        (tasks.ts, locks.ts)
 *
 * The plugin creates worker sessions inside the running Harness and exposes
 * them to an external orchestrator (Claude Code, Codex, …) over MCP.
 */
import path from 'node:path'
import { ApprovalQueue } from './approvals.ts'
import { ensureToken, publishEndpoint } from './auth.ts'
import { resolveConfig, type Config } from './config.ts'
import { EventLog } from './events.ts'
import { installGate } from './gate.ts'
import type { HostContext } from './host.ts'
import { AdmissionController } from './limiter.ts'
import { installLlmHooks, RouteHealth, UsageMeter } from './llm-hooks.ts'
import { LeaseManager } from './locks.ts'
import { startMcpServer } from './mcp.ts'
import { DispatchRegistry } from './registry.ts'
import { SessionManager } from './sessions.ts'
import { appendJsonl, ensureDir } from './store.ts'
import { TaskManager } from './tasks.ts'
import { installWebRoutes } from './web-routes.ts'

export type { Config } from './config.ts'

export const name = 'dujiangyan-dispatch'

/** Required host services; optional ones (permissionPresets, agentPresets, approval, workspaceRegistry, sessionTitle) are read lazily. */
export const inject = ['agents', 'llm', 'tools']

export function apply(ctx: HostContext, raw: Config = {}): void {
  const config = resolveConfig(raw)
  ensureDir(config.stateDir)
  const auditFile = path.join(config.stateDir, 'audit', `${new Date().toISOString().slice(0, 10)}.jsonl`)
  const audit = (record: Record<string, unknown>) => {
    try {
      appendJsonl(auditFile, { at: new Date().toISOString(), ...record })
    } catch {
      // Audit is best-effort; it must never break a tool call.
    }
  }

  const events = new EventLog(path.join(config.stateDir, 'events.jsonl'))
  const approvals = new ApprovalQueue(events, audit)
  const limiter = new AdmissionController(config.limitFor)
  const usage = new UsageMeter()
  const health = new RouteHealth()
  const leases = new LeaseManager(path.join(config.stateDir, 'locks'))
  const registry = new DispatchRegistry(ctx, config.stateDir)
  const sessions = new SessionManager(ctx, config, registry, events, health)
  const tasks = new TaskManager({ ctx, config, sessions, registry, leases, events, usage })

  installGate(ctx, {
    config,
    registry,
    approvals,
    events,
    audit,
    heldResources: root => tasks.heldResources(root),
    runningTask: root => tasks.runningTask(root),
  })
  installLlmHooks(ctx, { limiter, usage, registry, events, health })

  const token = ensureToken(config.stateDir)
  const mcpDeps = { ctx, config, token, registry, sessions, tasks, approvals, events, leases, limiter, usage, health, audit }
  const server = startMcpServer(mcpDeps)
  installWebRoutes(ctx, mcpDeps)
  publishEndpoint(config.stateDir, server.url)
  audit({ type: 'plugin/started', url: server.url, roots: config.workspaceRoots })

  ctx.effect(() => () => {
    approvals.cancelAll()
    leases.releaseAll()
    void server.close()
    void sessions.disposeAll()
    audit({ type: 'plugin/stopped' })
  }, 'dujiangyan-dispatch lifecycle')
}
