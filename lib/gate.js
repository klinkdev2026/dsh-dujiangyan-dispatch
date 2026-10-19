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
import { aiEligible, askJudges, judgeKey } from "./ai-approval.js";
import { summarizeForApproval } from "./approvals.js";
import { optional } from "./host.js";
import { canonicalPath } from "./paths.js";
import { matchHint } from "./local-rules.js";
import { buildApprovalContext, oneLineArgs, CONTEXT_LIMITS } from "./approval-context.js";
import { classify, RUN_CODE } from "./rules.js";
/** Heavy commands that wait while another session holds the `bench` lease (quiet mode). */
export const QUIET_PATTERNS = [
    /\bcargo(\.exe)?\s+(\+\S+\s+)?(build|b|test|t|clippy|run|r|bench|check|c|nextest|doc)\b/i,
    /\b(npm|pnpm|yarn)(\.cmd)?\s+(run\s+)?(test|build|compile)\b/i,
];
/** Prefix on every denial a worker receives, so it (and the orchestrator) can tell a gate denial from a tool error. */
export const DENY_MARKER = '[dujiangyan-denied';
const DENY_GUIDANCE = 'Do not retry the same action with a different formulation; adapt your approach or report it in "leftovers".';
const denyText = (rule, reason) => `${DENY_MARKER}:${rule}] ${reason} — ${DENY_GUIDANCE}`;
export function installGate(ctx, deps) {
    const { config, registry, approvals, events, audit } = deps;
    const home = homedir();
    /** Calls whose sandbox escalation the approver already granted at pre-execute. */
    const preApproved = new Set();
    /** Timed-out calls handed to the desktop prompt by the explicit `fallbackToHuman` opt-in. */
    const fallbackAsks = new Set();
    /**
     * Calls the gate itself denied or timed out, by call id and by session+tool, for a short window.
     * A host `approval/request` that follows one of them is not a new question: shown to a human it
     * reads like a sandbox escalation and approving it would run the refused call outside the sandbox.
     */
    const refusedRecently = new Map();
    const REFUSED_WINDOW_MS = 2 * 60_000;
    const noteRefused = (sessionId, tool, callId) => {
        const now = Date.now();
        for (const [k, at] of refusedRecently)
            if (now - at > REFUSED_WINDOW_MS)
                refusedRecently.delete(k);
        refusedRecently.set(`${sessionId}|${tool}`, now);
        if (callId !== undefined)
            refusedRecently.set(`call|${callId}`, now);
    };
    const wasRefused = (sessionId, tool, callId) => {
        const now = Date.now();
        const hit = (k) => { const at = refusedRecently.get(k); return at !== undefined && now - at <= REFUSED_WINDOW_MS; };
        return (callId !== undefined && hit(`call|${callId}`)) || hit(`${sessionId}|${tool}`);
    };
    /**
     * Deny circuit breaker (prior art: dsh-auto-review's rejection breaker): per running task, N
     * consecutive gate/AI denials or M of the last W verdicts pause the task, so a worker that keeps
     * rephrasing a refused action stops burning turns. Denials by a human or the orchestrator are
     * deliberate guidance and do not count.
     */
    const breakers = new Map();
    const noteVerdict = (root, taskId, denied, rule) => {
        const b = config.denyBreaker;
        // Only a running task can be paused; calls outside a task are not tracked.
        if (!b.enabled || taskId === undefined)
            return;
        let state = breakers.get(root);
        if (state === undefined || state.taskId !== taskId) {
            state = { taskId, consecutive: 0, recent: [], tripped: false };
            breakers.set(root, state);
        }
        if (state.tripped)
            return;
        state.consecutive = denied ? state.consecutive + 1 : 0;
        state.recent.push(denied);
        if (state.recent.length > b.windowSize)
            state.recent.shift();
        const windowDenies = state.recent.filter(Boolean).length;
        if (denied && (state.consecutive >= b.consecutiveDenies || windowDenies >= b.windowDenies)) {
            state.tripped = true;
            const detail = { consecutive: state.consecutive, windowDenies, lastRule: rule };
            events.append('task/deny-breaker', { root, taskId, ...detail });
            audit({ type: 'task/deny-breaker', root, taskId, ...detail });
            deps.onDenyBreaker?.(root, taskId, detail);
        }
    };
    const contextFor = (agent, root) => {
        const cwd = canonicalPath(agent.session.header.cwd ?? registry.get(root)?.cwd ?? process.cwd());
        const local = deps.localRules?.effective(cwd);
        return {
            local,
            gate: {
                cwd,
                roots: config.workspaceRoots.length > 0 ? config.workspaceRoots : [canonicalPath(registry.get(root)?.cwd ?? cwd)],
                home,
                platform: process.platform,
                holdsBench: deps.heldResources(root).includes('bench'),
                config: local?.rules ?? config.rules,
                protectedDirs: [canonicalPath(config.stateDir)],
                ...(() => {
                    const scope = registry.get(root)?.writeScope;
                    return scope !== undefined && scope.length > 0 ? { writeScope: scope.map(p => canonicalPath(p)) } : {};
                })(),
            },
        };
    };
    /** The last few gated calls per root session, so an approver sees what the worker did just before. */
    const recent = new Map();
    const noteCall = (root, call) => {
        const list = recent.get(root) ?? [];
        list.push(call);
        if (list.length > CONTEXT_LIMITS.calls)
            list.shift();
        recent.set(root, list);
    };
    const approvalContext = (root, args) => {
        const rec = registry.get(root);
        const route = rec?.chain?.[0];
        return buildApprovalContext({
            ...(() => { const task = deps.approvalContext?.(root); return task !== undefined ? { task } : {}; })(),
            session: { ...rec?.title !== undefined ? { title: rec.title } : {}, ...route !== undefined ? { route: `${route.provider}/${route.model}` } : {} },
            description: args['description'],
            recentCalls: (recent.get(root) ?? []).filter(c => c.taskId === deps.runningTask(root)),
        });
    };
    const isRootSession = (agent, root) => agent.session.id === root || agent.session.header.id === root;
    /** Run the AI judges on a pending approval; only a unanimous answer settles it, anything else stays for a human. */
    const judgeApproval = async (id, meta, input, signal) => {
        const ai = deps.aiApproval?.current();
        if (ai === undefined)
            return;
        const judges = ai.judges.map(judgeKey);
        if (deps.aiApproval?.takeBudget(meta.sessionId) === false) {
            const opinions = [{ judge: 'budget', decision: 'human', reason: `AI approval budget used up for this session (${ai.maxPerSessionPer10Min} judgments per 10 min)`, latencyMs: 0 }];
            approvals.annotate(id, { status: 'split', opinions });
            events.append('approval/ai', { id, ...meta, status: 'over-budget', opinions });
            audit({ type: 'approval/ai', id, ...meta, judges, outcome: 'over-budget' });
            return;
        }
        // Stop the judges the moment the approval settles elsewhere (a human or the orchestrator was faster).
        const settled = approvals.settledSignal(id);
        if (settled === undefined)
            return;
        approvals.annotate(id, { status: 'judging', opinions: [] });
        events.append('approval/ai', { id, ...meta, status: 'judging', judges });
        let verdict;
        try {
            verdict = await askJudges(ctx, ai, input, AbortSignal.any([signal, settled]));
        }
        catch (err) {
            verdict = { outcome: 'pending', opinions: [{ judge: judges.join('+'), decision: 'error', reason: String(err).slice(0, 300), latencyMs: 0 }] };
        }
        const reasons = verdict.opinions.map(o => `${o.judge}: ${o.reason}`).join(' | ');
        const decider = `ai:${ai.judges.map(j => j.model).join('+')}`;
        // decide()/annotate() return false when someone else settled the approval first.
        const applied = verdict.outcome === 'allow' ? approvals.decide(id, 'allow', reasons, decider)
            : verdict.outcome === 'deny' ? approvals.decide(id, 'deny', reasons, decider)
                : approvals.annotate(id, { status: 'split', opinions: verdict.opinions });
        for (const o of verdict.opinions)
            deps.aiApproval?.record(o, 'live');
        audit({ type: 'approval/ai', id, ...meta, judges, outcome: verdict.outcome, applied, opinions: verdict.opinions });
        events.append('approval/ai', { id, ...meta, status: verdict.outcome === 'pending' ? 'split' : verdict.outcome, applied, opinions: verdict.opinions });
    };
    /** Quiet mode: a heavy command waits while another session holds the bench lease. */
    const quietPatterns = () => {
        const local = deps.localRules?.quietMode();
        const extra = [...config.quietMode.patterns, ...local?.patterns ?? []].map(p => new RegExp(p, 'i'));
        return { enabled: local?.enabled ?? config.quietMode.enabled, patterns: [...QUIET_PATTERNS, ...extra] };
    };
    const waitForQuiet = async (signal) => {
        const deadline = Date.now() + config.quietMode.maxWaitMs;
        const poll = deps.quietPollMs ?? 1000;
        while (deps.benchHolder?.() !== undefined) {
            if (signal.aborted)
                return 'cancelled';
            if (Date.now() >= deadline)
                return 'timeout';
            await new Promise(resolve => {
                const t = setTimeout(resolve, poll);
                signal.addEventListener('abort', () => {
                    clearTimeout(t);
                    resolve();
                }, { once: true });
            });
        }
        return signal.aborted ? 'cancelled' : 'free';
    };
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
        const context = contextFor(agent, root);
        try {
            verdict = classify(exec.name, args, context.gate, outerRunCode);
        }
        catch (err) {
            verdict = { kind: 'escalate', rule: 'classifier-error', reason: String(err) };
        }
        // A personal hint only redirects a call that would wait for an approver; it never allows or loosens.
        if (verdict.kind === 'escalate' && context.local !== undefined) {
            const hint = matchHint(context.local, exec.name, args);
            if (hint !== undefined)
                verdict = { kind: 'deny', rule: hint.id, reason: `${hint.reason} (would have needed approval: ${verdict.rule})` };
        }
        const command = typeof args['command'] === 'string' ? args['command'] : undefined;
        if (verdict.kind === 'allow' && command !== undefined && !context.gate.holdsBench && deps.benchHolder?.() !== undefined) {
            const quiet = quietPatterns();
            if (quiet.enabled && quiet.patterns.some(re => re.test(command))) {
                const started = Date.now();
                events.append('quiet/waiting', { sessionId: agent.session.id, root, tool: exec.name, holder: deps.benchHolder?.(), command: command.slice(0, 200) });
                const waited = await waitForQuiet(exec.signal);
                events.append('quiet/resumed', { sessionId: agent.session.id, root, tool: exec.name, result: waited, waitedMs: Date.now() - started });
                if (waited === 'cancelled')
                    return { kind: 'cancel' };
                if (waited === 'timeout') {
                    verdict = {
                        kind: 'escalate',
                        rule: 'quiet-timeout',
                        reason: `a benchmark has held the machine for over ${Math.round(config.quietMode.maxWaitMs / 60_000)} min; this heavy command was held back so the measurement stays clean`,
                    };
                }
            }
        }
        const taskId = deps.runningTask(root);
        const record = { type: 'gate', sessionId: agent.session.id, root, taskId, tool: exec.name, callId: exec.callId, kind: verdict.kind, rule: verdict.rule };
        audit(verdict.kind === 'allow' ? record : { ...record, reason: verdict.reason });
        if (verdict.kind !== 'allow')
            events.append('gate/decision', { ...record, reason: verdict.reason });
        const paused = breakers.get(root);
        if (taskId !== undefined && paused?.tripped === true && paused.taskId === taskId) {
            return { kind: 'deny', reason: denyText('deny-breaker', 'this task was paused after repeated denials; stop and summarize what you were trying to do'), info: { name: 'DujiangyanDenied', code: 'DJY_PAUSED', reason: 'deny-breaker' } };
        }
        const line = oneLineArgs(args);
        const tagged = taskId !== undefined ? { taskId } : {};
        if (verdict.kind === 'allow') {
            noteVerdict(root, taskId, false, verdict.rule);
            noteCall(root, { ...tagged, tool: exec.name, args: line, verdict: 'allow', rule: verdict.rule });
            return next();
        }
        if (verdict.kind === 'deny') {
            noteVerdict(root, taskId, true, verdict.rule);
            noteCall(root, { ...tagged, tool: exec.name, args: line, verdict: 'deny', rule: verdict.rule });
            noteRefused(agent.session.id, exec.name, exec.callId);
            return { kind: 'deny', reason: denyText(verdict.rule, verdict.reason), info: { name: 'DujiangyanDenied', code: 'DJY_DENIED', reason: verdict.rule } };
        }
        const { summary, truncated } = summarizeForApproval(args);
        // Built before this call joins the ring, so `recentCalls` are the calls that came before it.
        const callContext = approvalContext(root, args);
        const ai = deps.aiApproval?.current();
        const judged = ai !== undefined && ai.enabled && aiEligible(verdict.rule, truncated);
        const meta = { sessionId: agent.session.id, ...taskId !== undefined ? { taskId } : {}, tool: exec.name, rule: verdict.rule };
        const input = {
            tool: exec.name,
            summary,
            cwd: context.gate.cwd,
            roots: context.gate.roots,
            rule: verdict.rule,
            reason: verdict.reason,
            facts: context.local?.facts ?? [],
            context: callContext,
        };
        const result = await approvals.request({
            sessionId: agent.session.id,
            ...taskId !== undefined ? { taskId } : {},
            tool: exec.name,
            summary,
            ...truncated ? { truncated } : {},
            rule: verdict.rule,
            reason: verdict.reason,
            cwd: agent.session.header.cwd ?? '',
            origin: 'pre-execute',
            context: callContext,
        }, config.approvalTimeoutMs, exec.signal, judged ? id => void judgeApproval(id, meta, input, exec.signal) : undefined);
        noteCall(root, {
            ...tagged, tool: exec.name, args: line, verdict: `escalate → ${result.kind}`, rule: verdict.rule,
            ...result.kind === 'allow' || result.kind === 'deny' ? { decider: result.decider } : {},
        });
        switch (result.kind) {
            case 'allow': {
                // An approval does not exempt a heavy command from quiet mode: an approved build would
                // otherwise run while another session's benchmark holds the machine.
                // (A quiet-timeout approval is an explicit decision to run during the benchmark.)
                if (command !== undefined && verdict.rule !== 'quiet-timeout' && !context.gate.holdsBench && deps.benchHolder?.() !== undefined) {
                    const quiet = quietPatterns();
                    if (quiet.enabled && quiet.patterns.some(re => re.test(command))) {
                        const started = Date.now();
                        events.append('quiet/waiting', { sessionId: agent.session.id, root, tool: exec.name, holder: deps.benchHolder?.(), command: command.slice(0, 200), approved: true });
                        const waited = await waitForQuiet(exec.signal);
                        events.append('quiet/resumed', { sessionId: agent.session.id, root, tool: exec.name, result: waited, waitedMs: Date.now() - started, approved: true });
                        if (waited === 'cancelled')
                            return { kind: 'cancel' };
                        if (waited === 'timeout') {
                            const reason = `approved, but a benchmark still holds the machine after ${Math.round(config.quietMode.maxWaitMs / 60_000)} min; run this heavy command after the measurement`;
                            return { kind: 'deny', reason: denyText('quiet-timeout', reason), info: { name: 'DujiangyanDenied', code: 'DJY_DENIED', reason: 'quiet-timeout' } };
                        }
                    }
                }
                noteVerdict(root, taskId, false, verdict.rule);
                if (args['sandbox_permissions'] !== undefined && exec.callId !== undefined) {
                    preApproved.add(exec.callId);
                    // A call the host never re-asks about would stay forever: keep only the most recent ones.
                    if (preApproved.size > 1000)
                        preApproved.delete(preApproved.values().next().value);
                }
                return next();
            }
            case 'deny':
                // AI denials count toward the breaker; a human's or the orchestrator's are guidance.
                if (result.decider.startsWith('ai:'))
                    noteVerdict(root, taskId, true, verdict.rule);
                noteRefused(agent.session.id, exec.name, exec.callId);
                return { kind: 'deny', reason: denyText('approver', `${result.decider} denied this call: ${result.reason}`), info: { name: 'DujiangyanDenied', code: 'DJY_APPROVER_DENIED', reason: result.reason } };
            case 'cancelled':
                return { kind: 'cancel' };
            case 'timeout': {
                const policy = optional(ctx, 'approval')?.overrideOf(agent.session);
                if (config.fallbackToHuman && isRootSession(agent, root) && policy !== 'never') {
                    // Explicit opt-in only: the desktop's own prompt decides this call (it is not routed back into our queue).
                    fallbackAsks.add(exec.callId ?? `${agent.session.id}|${exec.name}`);
                    return {
                        kind: 'ask',
                        reason: `dujiangyan: no approver answered within ${Math.round(config.approvalTimeoutMs / 60_000)} min (${verdict.rule}: ${verdict.reason})`,
                        displayReason: {
                            en: `Dujiangyan escalated this call and no approver answered: ${verdict.reason}`,
                            zh: `都江堰把这个调用转交审批，但审批人未在时限内答复：${verdict.reason}`,
                        },
                    };
                }
                noteRefused(agent.session.id, exec.name, exec.callId);
                events.append('approval/timeout', { sessionId: agent.session.id, ...tagged, tool: exec.name, rule: verdict.rule });
                return {
                    kind: 'deny',
                    reason: denyText('approval-timeout', `the approver did not answer in time (${verdict.rule}); resubmit the same call unchanged — it will be decided then. Do not rewrite it or try to run it another way`),
                    info: { name: 'DujiangyanDenied', code: 'DJY_APPROVAL_TIMEOUT', reason: 'approval-timeout' },
                };
            }
        }
    }, { prepend: true });
    ctx.on('approval/request', async (req, next) => {
        const root = registry.rootOf(req.agent);
        if (root === undefined)
            return next();
        if (req.callId !== undefined && preApproved.delete(req.callId))
            return 'allowed-once';
        const fallbackKey = req.callId ?? `${req.agent.session.id}|${req.toolName}`;
        if (fallbackAsks.delete(fallbackKey))
            return next();
        const taskId = deps.runningTask(root);
        // The host re-asking about a call the gate just refused or timed out: never a new question.
        if (wasRefused(req.agent.session.id, req.toolName, req.callId) || (req.reason ?? '').startsWith('dujiangyan:')) {
            const detail = { sessionId: req.agent.session.id, ...taskId !== undefined ? { taskId } : {}, tool: req.toolName, callId: req.callId, reason: (req.reason ?? '').slice(0, 300) };
            events.append('approval/escalation-blocked', detail);
            audit({ type: 'approval/escalation-blocked', ...detail });
            return 'rejected';
        }
        const result = await approvals.request({
            sessionId: req.agent.session.id,
            ...taskId !== undefined ? { taskId } : {},
            tool: req.toolName,
            summary: req.reason ?? '',
            rule: 'sandbox-escalation',
            reason: req.reason ?? 'the tool asks to run with wider permissions',
            danger: 'grants execution OUTSIDE the sandbox',
            cwd: req.agent.session.header.cwd ?? '',
            origin: 'sandbox',
            context: approvalContext(root, {}),
        }, config.approvalTimeoutMs, req.signal);
        switch (result.kind) {
            case 'allow': return 'allowed-once';
            case 'deny': return 'rejected';
            case 'cancelled': return 'cancelled';
            case 'timeout': return config.fallbackToHuman ? next() : 'rejected';
        }
    }, { prepend: true });
}
