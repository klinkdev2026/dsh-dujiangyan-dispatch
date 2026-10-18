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
import { homedir } from 'node:os';
import { summarizeArgs } from "./approvals.js";
import { optional } from "./host.js";
import { canonicalPath } from "./paths.js";
import { classify, RUN_CODE } from "./rules.js";
export function installGate(ctx, deps) {
    const { config, registry, approvals, events, audit } = deps;
    const home = homedir();
    /** Calls whose sandbox escalation the approver already granted at pre-execute. */
    const preApproved = new Set();
    const contextFor = (agent, root) => {
        const cwd = canonicalPath(agent.session.header.cwd ?? registry.get(root)?.cwd ?? process.cwd());
        return {
            cwd,
            roots: config.workspaceRoots.length > 0 ? config.workspaceRoots : [canonicalPath(registry.get(root)?.cwd ?? cwd)],
            home,
            platform: process.platform,
            holdsBench: deps.heldResources(root).includes('bench'),
            config: config.rules,
        };
    };
    const isRootSession = (agent, root) => agent.session.id === root || agent.session.header.id === root;
    ctx.on('tools/pre-execute', async (exec, next) => {
        const agent = exec.agent;
        if (agent === undefined)
            return next();
        const root = registry.rootOf(agent);
        if (root === undefined)
            return next();
        const args = (exec.arguments !== null && typeof exec.arguments === 'object' ? exec.arguments : {});
        const outerRunCode = exec.name === RUN_CODE && exec.parent === undefined;
        let verdict;
        try {
            verdict = classify(exec.name, args, contextFor(agent, root), outerRunCode);
        }
        catch (err) {
            verdict = { kind: 'escalate', rule: 'classifier-error', reason: String(err) };
        }
        const taskId = deps.runningTask(root);
        const record = { type: 'gate', sessionId: agent.session.id, root, taskId, tool: exec.name, callId: exec.callId, kind: verdict.kind, rule: verdict.rule };
        audit(verdict.kind === 'allow' ? record : { ...record, reason: verdict.reason });
        if (verdict.kind !== 'allow')
            events.append('gate/decision', { ...record, reason: verdict.reason });
        if (verdict.kind === 'allow')
            return next();
        if (verdict.kind === 'deny') {
            return { kind: 'deny', reason: `[dujiangyan:${verdict.rule}] ${verdict.reason}`, info: { name: 'DujiangyanDenied', code: 'DJY_DENIED', reason: verdict.rule } };
        }
        const result = await approvals.request({
            sessionId: agent.session.id,
            ...taskId !== undefined ? { taskId } : {},
            tool: exec.name,
            summary: summarizeArgs(args),
            rule: verdict.rule,
            reason: verdict.reason,
            cwd: agent.session.header.cwd ?? '',
            origin: 'pre-execute',
        }, config.approvalTimeoutMs, exec.signal);
        switch (result.kind) {
            case 'allow':
                if (args['sandbox_permissions'] !== undefined && exec.callId !== undefined)
                    preApproved.add(exec.callId);
                return next();
            case 'deny':
                return { kind: 'deny', reason: `[dujiangyan:approver] ${result.decider} denied this call: ${result.reason}`, info: { name: 'DujiangyanDenied', code: 'DJY_APPROVER_DENIED', reason: result.reason } };
            case 'cancelled':
                return { kind: 'cancel' };
            case 'timeout': {
                const policy = optional(ctx, 'approval')?.overrideOf(agent.session);
                if (config.fallbackToHuman && isRootSession(agent, root) && policy !== 'never') {
                    return {
                        kind: 'ask',
                        reason: `dujiangyan: no approver answered within ${Math.round(config.approvalTimeoutMs / 60_000)} min (${verdict.rule}: ${verdict.reason})`,
                        displayReason: {
                            en: `Dujiangyan escalated this call and no approver answered: ${verdict.reason}`,
                            zh: `都江堰把这个调用转交审批，但审批人未在时限内答复：${verdict.reason}`,
                        },
                    };
                }
                return { kind: 'deny', reason: `[dujiangyan:approval-timeout] no approver answered in time (${verdict.rule}: ${verdict.reason}); continue with other work or report it in your summary` };
            }
        }
    }, { prepend: true });
    ctx.on('approval/request', async (req, next) => {
        const root = registry.rootOf(req.agent);
        if (root === undefined)
            return next();
        if (req.callId !== undefined && preApproved.delete(req.callId))
            return 'allowed-once';
        const taskId = deps.runningTask(root);
        const result = await approvals.request({
            sessionId: req.agent.session.id,
            ...taskId !== undefined ? { taskId } : {},
            tool: req.toolName,
            summary: req.reason ?? '',
            rule: 'sandbox-escalation',
            reason: req.reason ?? 'the tool asks to run with wider permissions',
            cwd: req.agent.session.header.cwd ?? '',
            origin: 'sandbox',
        }, config.approvalTimeoutMs, req.signal);
        switch (result.kind) {
            case 'allow': return 'allowed-once';
            case 'deny': return 'rejected';
            case 'cancelled': return 'cancelled';
            case 'timeout': return config.fallbackToHuman ? next() : 'rejected';
        }
    }, { prepend: true });
}
