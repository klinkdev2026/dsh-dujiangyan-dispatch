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
import { AiApproval, judgeKey, probeJudges } from './ai-approval.ts'
import { ApprovalQueue } from './approvals.ts'
import { ensureToken, publishEndpoint } from './auth.ts'
import { resolveConfig, type Config, type ResolvedConfig } from './config.ts'
import { EvidenceRecorder } from './evidence.ts'
import { EventLog } from './events.ts'
import { installGate } from './gate.ts'
import type { HostContext } from './host.ts'
import { AdmissionController } from './limiter.ts'
import { installLlmHooks, RouteHealth, UsageMeter } from './llm-hooks.ts'
import { LocalRules } from './local-rules.ts'
import { LeaseManager } from './locks.ts'
import { startMcpServer } from './mcp.ts'
import { DispatchRegistry } from './registry.ts'
import { QuietSwitch } from './quiet.ts'
import { SessionManager } from './sessions.ts'
import { appendJsonl, ensureDir } from './store.ts'
import { TaskManager } from './tasks.ts'
import { installWebRoutes } from './web-routes.ts'
import { Watchdog } from './watchdog.ts'

export type { Config } from './config.ts'

export const name = 'dujiangyan-dispatch'

/** Required host services; optional ones (permissionPresets, agentPresets, approval, workspaceRegistry, sessionTitle) are read lazily. */
export const inject = ['agents', 'llm', 'tools']

export function apply(ctx: HostContext, raw: Config = {}): void {
  const profile = resolveConfig(raw)
  // Roots from the profile plus the hot-reloaded `local-rules.json` ones, read at each use.
  const config: ResolvedConfig = Object.defineProperty({ ...profile }, 'workspaceRoots', {
    get: () => [...new Set([...profile.workspaceRoots, ...localRules.workspaceRoots()])],
    enumerable: true,
  })
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
  leases.onLost = (name, holder, now) => events.append('lease/lost', { name, holder, nowHeldBy: now?.holder, epoch: now?.epoch })
  const registry = new DispatchRegistry(ctx, config.stateDir)
  const localRules = new LocalRules({ stateDir: config.stateDir, events, audit, base: () => config.rules })
  const sessions = new SessionManager(ctx, config, registry, events, health)
  localRules.reload()
  localRules.watch()
  const aiApproval = new AiApproval(() => config.aiApproval, () => localRules.aiApproval(), path.join(config.stateDir, 'ai-judges.json'), root => {
    const rec = registry.get(root)
    if (rec?.judges !== undefined) return { judges: rec.judges, source: 'session' }
    const folder = rec !== undefined ? localRules.workspaceJudges(rec.cwd) : undefined
    return folder !== undefined ? { judges: folder, source: 'workspace' } : undefined
  }, () => registry.list().flatMap(rec => rec.judges ?? localRules.workspaceJudges(rec.cwd) ?? []))
  const evidence = new EvidenceRecorder()
  const tasks = new TaskManager({ ctx, config, sessions, registry, leases, events, usage, evidence, localFacts: cwd => localRules.effective(cwd).facts })

  const presence: { lastSeenAt: number | undefined; approverAt?: number } = { lastSeenAt: undefined }
  const quiet = new QuietSwitch()
  installGate(ctx, {
    config,
    registry,
    approvals,
    events,
    audit,
    heldResources: root => tasks.heldResources(root),
    runningTask: root => tasks.runningTask(root),
    stoppedTask: root => tasks.stoppedTask(root),
    approvalContext: root => tasks.approvalContextFor(root),
    localRules,
    aiApproval,
    benchHolder: () => leases.holder('bench')?.holder,
    onDenyBreaker: (root, taskId, detail) => tasks.pauseForAttention(root, taskId, detail),
    // Only handling approvals proves an approver is back; event polling alone does not (review F2).
    approverSeen: () => presence.approverAt,
    evidence,
    benchMode: root => tasks.benchMode(root),
    benchLease: {
      acquire: async (holder, signal) => { await leases.acquire('bench', holder, signal) },
      release: holder => { leases.release('bench', holder) },
    },
    quietOverride: () => quiet.current()?.enabled,
    onBlocked: (root, taskId, step) => tasks.noteBlocked(root, taskId, step),
    onForeignTools: (agent, root, taskId, names) => {
      // The route renames tools (findings 59): bench it like other deterministic route failures. The
      // next request of the turn then goes to the next healthy route of the chain; with none left the
      // task ends as an error instead of retrying on the same route.
      const route = routing.routeOf(agent.session.id)
      if (route === undefined) return
      const key = RouteHealth.key(route)
      const reason = `route ${key} rewrites tool names (the model called ${names.join(', ')}); the gateway must fix it`
      health.markBroken(route, reason)
      events.append('route/broken', { sessionId: agent.session.id, root, taskId, route: key, reason, names })
      if (!(registry.get(root)?.chain ?? []).some(e => routing.healthy(e))) tasks.failRunning(root, reason)
    },
  })
  const routing = installLlmHooks(ctx, { limiter, usage, registry, events, health })

  const watchdog = new Watchdog({
    config, approvals, events, audit, aiApproval,
    runningTasks: () => tasks.list({ status: 'running' }),
    steer: (sessionId, text) => tasks.steer(sessionId, text, 'watchdog'),
    lastClientSeen: () => presence.lastSeenAt,
  })
  const stopWatchdog = watchdog.start()
  // Probe the judges once the host's providers are up, and again whenever the judge set changes.
  let probedFor = ''
  const probe = () => {
    const ai = aiApproval.current()
    // Session, batch and folder judges too: a dead one would silently send its sessions to a human.
    const judges = aiApproval.inUse()
    const key = ai.enabled ? judges.map(judgeKey).join('+') : ''
    if (key === '' || key === probedFor) return
    probedFor = key
    void probeJudges(ctx, { ...ai, judges }).then(opinions => {
      for (const o of opinions) aiApproval.record(o, 'probe')
      audit({ type: 'ai/probed', judges: opinions.map(o => ({ judge: o.judge, decision: o.decision, reason: o.reason.slice(0, 200), latencyMs: o.latencyMs })) })
    }).catch(() => { probedFor = '' })
  }
  const probeTimer = setTimeout(probe, 5000)
  probeTimer.unref?.()
  const reprobe = setInterval(probe, 60_000)
  reprobe.unref?.()

  const token = ensureToken(config.stateDir)
  const mcpDeps = { ctx, config, token, registry, sessions, tasks, approvals, events, leases, limiter, usage, health, audit, localRules, aiApproval, watchdog, presence, quiet }
  const server = startMcpServer(mcpDeps)
  installWebRoutes(ctx, mcpDeps)
  publishEndpoint(config.stateDir, server.url)
  audit({ type: 'plugin/started', url: server.url, roots: config.workspaceRoots })

  ctx.effect(() => () => {
    // Record unfinished tasks as interrupted before disposal unwinds their turns into a fake "done".
    tasks.stop()
    stopWatchdog()
    clearTimeout(probeTimer)
    clearInterval(reprobe)
    localRules.close()
    approvals.cancelAll()
    leases.releaseAll()
    void server.close()
    void sessions.disposeAll()
    audit({ type: 'plugin/stopped' })
  }, 'dujiangyan-dispatch lifecycle')
}
