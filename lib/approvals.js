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
    /** Park one request until decided, timed out, or aborted. `onCreated` receives the id once it is listed. */
    request(req, timeoutMs, signal, onCreated) {
        if (signal?.aborted === true)
            return Promise.resolve({ kind: 'cancelled' });
        const id = `apr_${randomUUID().slice(0, 12)}`;
        const created = this.now();
        const pending = {
            ...req,
            reason: redactSecrets(req.reason),
            id,
            createdAt: new Date(created).toISOString(),
            expiresAt: new Date(created + timeoutMs).toISOString(),
        };
        const settled = new AbortController();
        return new Promise(resolve => {
            let done = false;
            const settle = (result) => {
                if (done)
                    return;
                done = true;
                settled.abort();
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
            this.entries.set(id, { pending, settle, settled });
            this.audit({ type: 'approval/pending', ...pending });
            this.events.append('approval/pending', { ...pending });
            onCreated?.(id);
        });
    }
    /** A signal that aborts when the approval settles (any decider, timeout or cancel); undefined once settled. */
    settledSignal(id) {
        return this.entries.get(id)?.settled.signal;
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
    /** Attach the AI judges' opinions to a pending approval. Returns false when it is no longer pending. */
    annotate(id, ai) {
        const entry = this.entries.get(id);
        if (entry === undefined)
            return false;
        entry.pending = { ...entry.pending, ai };
        return true;
    }
    /** Cancel every pending approval (plugin disposal). */
    cancelAll() {
        for (const entry of [...this.entries.values()])
            entry.settle({ kind: 'cancelled' });
    }
}
/**
 * Bound on the approver-facing summary. A shell command has to be read in full to be judged
 * (a real run had `Remove-Item …; cargo test` hidden past a 1200-character cut), so the bound
 * is generous and a cut is flagged rather than silent.
 */
export const SUMMARY_MAX = 16_000;
/** Summarize tool arguments for an approver: bounded length, likely secrets masked. */
export function summarizeArgs(args, max = SUMMARY_MAX) {
    return summarizeForApproval(args, max).summary;
}
const SECRET_KEY_WORDS = new Set(['key', 'apikey', 'token', 'secret', 'password', 'passwd', 'pwd', 'authorization', 'auth', 'credential', 'credentials']);
/** Whole-word match on the argument name (api_key, apiKey, X-Auth-Token), so monkey / keyboard / max_tokens stay visible. */
export function isSecretKey(key) {
    return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).some(w => SECRET_KEY_WORDS.has(w));
}
export function summarizeForApproval(args, max = SUMMARY_MAX) {
    const masked = redactSecrets(JSON.stringify(args, (key, value) => {
        if (isSecretKey(key))
            return '***';
        if (key === 'content' && typeof value === 'string' && value.length > 200)
            return `${value.slice(0, 200)}… (${value.length} chars)`;
        return value;
    }));
    if (masked.length <= max)
        return { summary: masked, truncated: false };
    // Never cut between the halves of a surrogate pair (emoji, rare CJK): a lone half is invalid UTF-16.
    const cut = /[\uD800-\uDBFF]/.test(masked.charAt(max - 1)) ? max - 1 : max;
    return { summary: `${masked.slice(0, cut)}…`, truncated: true };
}
/**
 * Secrets written inline in a command string (the JSON-key masking above only sees argument
 * names): `--token X`, `--api-key=X`, `KEY=…`/`TOKEN=…`/`SECRET=…`/`PASSWORD=…` assignments,
 * `Authorization: Bearer X`, and provider-style keys (`sk-…`, GitHub/Slack tokens). Applied to
 * everything an approver, a judge, the panel or the audit log sees.
 */
// The text is usually a JSON summary, so a quote inside a command appears as `\"`; values stop at
// whitespace, quotes, backslashes and shell separators.
const VALUE = String.raw `(?:\\?"[^"\\]*\\?"|'[^']*'|[^\s"'\\;&|]+)`;
const SECRET_PATTERNS = [
    [new RegExp(String.raw `(authorization\s*[:=]\s*(?:bearer|basic|token)\s+)[^\s"'\\]+`, 'gi'), '$1***'],
    [new RegExp(String.raw `(--?(?:api[-_]?key|access[-_]?key|secret(?:[-_]key)?|token|auth[-_]?token|password|passwd|pwd)(?:\s+|=))${VALUE}`, 'gi'), '$1***'],
    [new RegExp(String.raw `(\b[A-Za-z0-9_]*(?:API_?KEY|ACCESS_?KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Za-z0-9_]*\s*=\s*)${VALUE}`, 'gi'), '$1***'],
    [/\bsk-[A-Za-z0-9_-]{12,}/g, 'sk-***'],
    [/\b(?:ghp|gho|ghu|ghs|github_pat|xox[abprs])_[A-Za-z0-9_]{10,}/g, '***'],
];
export function redactSecrets(text) {
    let out = text;
    for (const [re, replacement] of SECRET_PATTERNS)
        out = out.replace(re, replacement);
    return out;
}
