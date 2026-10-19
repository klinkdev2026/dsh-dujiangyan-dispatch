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
import path from 'node:path';
import { AiApproval, judgeKey, probeJudges } from "./ai-approval.js";
import { ApprovalQueue } from "./approvals.js";
import { ensureToken, publishEndpoint } from "./auth.js";
import { resolveConfig } from "./config.js";
import { EventLog } from "./events.js";
import { installGate } from "./gate.js";
import { AdmissionController } from "./limiter.js";
import { installLlmHooks, RouteHealth, UsageMeter } from "./llm-hooks.js";
import { LocalRules } from "./local-rules.js";
import { LeaseManager } from "./locks.js";
import { startMcpServer } from "./mcp.js";
import { DispatchRegistry } from "./registry.js";
import { SessionManager } from "./sessions.js";
import { appendJsonl, ensureDir } from "./store.js";
import { TaskManager } from "./tasks.js";
import { installWebRoutes } from "./web-routes.js";
import { Watchdog } from "./watchdog.js";
export const name = 'dujiangyan-dispatch';
/** Required host services; optional ones (permissionPresets, agentPresets, approval, workspaceRegistry, sessionTitle) are read lazily. */
export const inject = ['agents', 'llm', 'tools'];
export function apply(ctx, raw = {}) {
    const config = resolveConfig(raw);
    ensureDir(config.stateDir);
    const auditFile = path.join(config.stateDir, 'audit', `${new Date().toISOString().slice(0, 10)}.jsonl`);
    const audit = (record) => {
        try {
            appendJsonl(auditFile, { at: new Date().toISOString(), ...record });
        }
        catch {
            // Audit is best-effort; it must never break a tool call.
        }
    };
    const events = new EventLog(path.join(config.stateDir, 'events.jsonl'));
    const approvals = new ApprovalQueue(events, audit);
    const limiter = new AdmissionController(config.limitFor);
    const usage = new UsageMeter();
    const health = new RouteHealth();
    const leases = new LeaseManager(path.join(config.stateDir, 'locks'));
    leases.onLost = (name, holder, now) => events.append('lease/lost', { name, holder, nowHeldBy: now?.holder, epoch: now?.epoch });
    const registry = new DispatchRegistry(ctx, config.stateDir);
    const sessions = new SessionManager(ctx, config, registry, events, health);
    const localRules = new LocalRules({ stateDir: config.stateDir, events, audit, base: () => config.rules });
    localRules.reload();
    localRules.watch();
    const aiApproval = new AiApproval(() => config.aiApproval, () => localRules.aiApproval());
    const tasks = new TaskManager({ ctx, config, sessions, registry, leases, events, usage, localFacts: cwd => localRules.effective(cwd).facts });
    installGate(ctx, {
        config,
        registry,
        approvals,
        events,
        audit,
        heldResources: root => tasks.heldResources(root),
        runningTask: root => tasks.runningTask(root),
        approvalContext: root => tasks.approvalContextFor(root),
        localRules,
        aiApproval,
        benchHolder: () => leases.holder('bench')?.holder,
        onDenyBreaker: (root, taskId, detail) => tasks.pauseForAttention(root, taskId, detail),
    });
    installLlmHooks(ctx, { limiter, usage, registry, events, health });
    const presence = { lastSeenAt: undefined };
    const watchdog = new Watchdog({
        config, approvals, events, audit, aiApproval,
        runningTasks: () => tasks.list({ status: 'running' }),
        steer: (sessionId, text) => tasks.steer(sessionId, text, 'watchdog'),
        lastClientSeen: () => presence.lastSeenAt,
    });
    const stopWatchdog = watchdog.start();
    // Probe the judges once the host's providers are up, and again whenever the judge set changes.
    let probedFor = '';
    const probe = () => {
        const ai = aiApproval.current();
        const key = ai.enabled ? ai.judges.map(judgeKey).join('+') : '';
        if (key === '' || key === probedFor)
            return;
        probedFor = key;
        void probeJudges(ctx, ai).then(opinions => {
            for (const o of opinions)
                aiApproval.record(o, 'probe');
            audit({ type: 'ai/probed', judges: opinions.map(o => ({ judge: o.judge, decision: o.decision, reason: o.reason.slice(0, 200), latencyMs: o.latencyMs })) });
        }).catch(() => { probedFor = ''; });
    };
    const probeTimer = setTimeout(probe, 5000);
    probeTimer.unref?.();
    const reprobe = setInterval(probe, 60_000);
    reprobe.unref?.();
    const token = ensureToken(config.stateDir);
    const mcpDeps = { ctx, config, token, registry, sessions, tasks, approvals, events, leases, limiter, usage, health, audit, localRules, aiApproval, watchdog, presence };
    const server = startMcpServer(mcpDeps);
    installWebRoutes(ctx, mcpDeps);
    publishEndpoint(config.stateDir, server.url);
    audit({ type: 'plugin/started', url: server.url, roots: config.workspaceRoots });
    ctx.effect(() => () => {
        // Record unfinished tasks as interrupted before disposal unwinds their turns into a fake "done".
        tasks.stop();
        stopWatchdog();
        clearTimeout(probeTimer);
        clearInterval(reprobe);
        localRules.close();
        approvals.cancelAll();
        leases.releaseAll();
        void server.close();
        void sessions.disposeAll();
        audit({ type: 'plugin/stopped' });
    }, 'dujiangyan-dispatch lifecycle');
}
