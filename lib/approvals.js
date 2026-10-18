/**
 * The escalation queue between the gate and an external approver.
 *
 * A pending approval waits until the first `decide()` (any approver: Claude
 * Code, Codex, a human tool), its timeout, or the tool call's abort signal.
 * The first decision wins; later ones are rejected so two approvers can never
 * flip a call.
 */
import { randomUUID } from 'node:crypto';
export class ApprovalQueue {
    entries = new Map();
    events;
    audit;
    now;
    constructor(events, audit, now = () => Date.now()) {
        this.events = events;
        this.audit = audit;
        this.now = now;
    }
    /** Park one request until decided, timed out, or aborted. */
    request(req, timeoutMs, signal) {
        if (signal?.aborted === true)
            return Promise.resolve({ kind: 'cancelled' });
        const id = `apr_${randomUUID().slice(0, 12)}`;
        const created = this.now();
        const pending = {
            ...req,
            id,
            createdAt: new Date(created).toISOString(),
            expiresAt: new Date(created + timeoutMs).toISOString(),
        };
        return new Promise(resolve => {
            let done = false;
            const settle = (result) => {
                if (done)
                    return;
                done = true;
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
                this.entries.delete(id);
                this.audit({ type: 'approval/settled', id, sessionId: req.sessionId, tool: req.tool, rule: req.rule, ...result });
                this.events.append('approval/settled', { id, sessionId: req.sessionId, taskId: req.taskId, tool: req.tool, result: result.kind });
                resolve(result);
            };
            const onAbort = () => settle({ kind: 'cancelled' });
            const timer = setTimeout(() => settle({ kind: 'timeout' }), timeoutMs);
            timer.unref?.();
            signal?.addEventListener('abort', onAbort, { once: true });
            this.entries.set(id, { pending, settle });
            this.audit({ type: 'approval/pending', ...pending });
            this.events.append('approval/pending', { ...pending });
        });
    }
    list() {
        return [...this.entries.values()].map(e => e.pending);
    }
    /** Decide a pending approval. Returns false when it is unknown or already settled. */
    decide(id, decision, reason, decider) {
        const entry = this.entries.get(id);
        if (entry === undefined)
            return false;
        entry.settle({ kind: decision, reason, decider });
        return true;
    }
    /** Cancel every pending approval (plugin disposal). */
    cancelAll() {
        for (const entry of [...this.entries.values()])
            entry.settle({ kind: 'cancelled' });
    }
}
/** Summarize tool arguments for an approver: bounded length, likely secrets masked. */
export function summarizeArgs(args, max = 1200) {
    const masked = JSON.stringify(args, (key, value) => {
        if (/key|token|secret|passw|authorization/i.test(key))
            return '***';
        if (key === 'content' && typeof value === 'string' && value.length > 200)
            return `${value.slice(0, 200)}… (${value.length} chars)`;
        return value;
    });
    return masked.length > max ? `${masked.slice(0, max)}…` : masked;
}
