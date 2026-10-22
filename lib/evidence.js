/**
 * Gate-recorded evidence: what a task really ran, as seen by the gate and the host's `tools/result`.
 *
 * A worker's closing JSON says how it verified its work ("cargo test passes"); the orchestrator had
 * only that claim to go on. This module records, per task, every call the gate let through with its
 * outcome (exit code, time-out), and picks out build and test runs, so `djy_task_get` can show the
 * recorded checks next to the claimed ones (Kimi review: "the gate record as proof"; prior art:
 * dsh-agent-teams quality gates trust the worker's own `commandsRun`).
 */
import { redactSecrets } from "./approvals.js";
export const MAX_COMMANDS = 200;
export const MAX_CHECKS = 50;
const MAX_CMD = 300;
const CHECKS = [
    ['test', /\bcargo(\.exe)?\s+(\+\S+\s+)?(test|t|nextest)\b|\b(npm|pnpm|yarn)(\.cmd)?\s+(run\s+)?test\b|\bpytest\b|\bpython\d?(\.exe)?\s+-m\s+(pytest|unittest)\b|\bnode\s+(--[\w-]+\s+)*--test\b|\bgo\s+test\b|\bctest\b|\bmake\s+(test|check)\b/i],
    ['lint', /\bcargo(\.exe)?\s+(\+\S+\s+)?(clippy|fmt\s+--check)\b|\b(npm|pnpm|yarn)(\.cmd)?\s+(run\s+)?(lint|typecheck)\b|\btsc\b[^;|]*--noEmit\b/i],
    ['build', /\bcargo(\.exe)?\s+(\+\S+\s+)?(build|b|check|c)\b|\b(npm|pnpm|yarn)(\.cmd)?\s+(run\s+)?(build|compile)\b|\bcmake\s+--build\b|\b(make|ninja|msbuild)\b/i],
];
/** Which kind of check a shell command is, if any (the first matching kind wins: test > lint > build). */
export function checkKind(command) {
    for (const [kind, re] of CHECKS)
        if (re.test(command))
            return kind;
    return undefined;
}
/** Test-runner summary lines worth keeping (cargo, pytest, node:test). */
function testSummary(text) {
    const lines = text.split(/\r?\n/).filter(l => /^test result: |^=+ .*(passed|failed).* =+$|^# (pass|fail) \d+|^ℹ (pass|fail) \d+/.test(l.trim()));
    return lines.length === 0 ? undefined : lines.slice(-6).map(l => l.trim()).join(' | ').slice(0, 400);
}
/** The outcome of one host tool result: error flag, exit code, time-out, and its text. */
export function outcomeOf(result) {
    const r = (result ?? {});
    const text = Array.isArray(r.content)
        ? r.content.map(b => (b !== null && typeof b === 'object' && typeof b.text === 'string' ? b.text : '')).join('\n')
        : '';
    const value = (r.value ?? {});
    let exitCode = typeof value.exitCode === 'number' ? value.exitCode : undefined;
    const timedOut = value.timedOut === true ? true : undefined;
    if (exitCode === undefined) {
        // The shell tools' rendered marker (`[exit code: N]` on the last line; none means 0).
        const m = /\n\[exit code: (\d+)\]\s*$/.exec(text);
        if (m !== null)
            exitCode = Number(m[1]);
    }
    const ok = r.isError !== true && timedOut !== true && (exitCode === undefined || exitCode === 0);
    return { ok, ...exitCode !== undefined ? { exitCode } : {}, ...timedOut !== undefined ? { timedOut } : {}, text };
}
export class EvidenceRecorder {
    tasks = new Map();
    /** Calls awaiting their result, by the host's execution object and (should the host pass a copy) its call id. */
    open = new WeakMap();
    openByCall = new Map();
    now;
    constructor(now = () => Date.now()) {
        this.now = now;
    }
    forTaskOrNew(taskId) {
        let ev = this.tasks.get(taskId);
        if (ev === undefined) {
            ev = { calls: { allowed: 0, approved: 0, denied: 0 }, commands: [], checks: [] };
            this.tasks.set(taskId, ev);
        }
        return ev;
    }
    /** A call the gate let through (`decider` set when an approver allowed it). Keyed by the host's execution object. */
    started(exec, taskId, tool, args, rule, decider) {
        const ev = this.forTaskOrNew(taskId);
        if (decider !== undefined)
            ev.calls.approved++;
        else
            ev.calls.allowed++;
        const command = typeof args['command'] === 'string' ? args['command'] : undefined;
        const shown = redactSecrets(command ?? JSON.stringify(args)).replace(/\s+/g, ' ').slice(0, MAX_CMD);
        const entry = { tool, cmd: shown, rule, ...decider !== undefined ? { decider } : {}, startedAt: new Date(this.now()).toISOString() };
        ev.commands.push(entry);
        if (ev.commands.length > MAX_COMMANDS) {
            ev.commands.shift();
            ev.truncated = true;
        }
        const o = { taskId, entry, started: this.now(), command };
        this.open.set(exec, o);
        const callId = exec.callId;
        if (typeof callId === 'string') {
            this.openByCall.set(callId, o);
            // A call whose result never comes (cancelled before it ran) must not pin memory.
            if (this.openByCall.size > 1000)
                this.openByCall.delete(this.openByCall.keys().next().value);
        }
    }
    /** A call the gate (or an approver) refused. */
    denied(taskId) {
        this.forTaskOrNew(taskId).calls.denied++;
    }
    /** The host's final result for a call recorded by `started`. Unknown executions are ignored. */
    finished(exec, result) {
        const callId = exec.callId;
        const o = this.open.get(exec) ?? (typeof callId === 'string' ? this.openByCall.get(callId) : undefined);
        if (o === undefined)
            return;
        this.open.delete(exec);
        if (typeof callId === 'string')
            this.openByCall.delete(callId);
        const out = outcomeOf(result);
        o.entry.ms = this.now() - o.started;
        o.entry.ok = out.ok;
        if (out.exitCode !== undefined)
            o.entry.exitCode = out.exitCode;
        if (out.timedOut !== undefined)
            o.entry.timedOut = out.timedOut;
        const kind = o.command === undefined ? undefined : checkKind(o.command);
        if (kind === undefined)
            return;
        const ev = this.forTaskOrNew(o.taskId);
        const summary = testSummary(out.text);
        // `cargo test | Select-String …` exits 0 even when tests fail: the runner's own summary decides then.
        const failedTests = kind === 'test' && summary !== undefined && /FAILED|\b[1-9]\d* failed|# fail [1-9]|ℹ fail [1-9]/.test(summary);
        ev.checks.push({ kind, cmd: o.entry.cmd, at: new Date(this.now()).toISOString(), ok: out.ok && !failedTests, ...out.exitCode !== undefined ? { exitCode: out.exitCode } : {}, ...summary !== undefined ? { summary } : {} });
        if (ev.checks.length > MAX_CHECKS)
            ev.checks.shift();
    }
    /** The evidence so far for a task (live view). */
    get(taskId) {
        return this.tasks.get(taskId);
    }
    /** The evidence of a finished task, removed from memory (the task record keeps it). */
    take(taskId) {
        const ev = this.tasks.get(taskId);
        this.tasks.delete(taskId);
        return ev;
    }
}
