export interface EvidenceCommand {
    readonly tool: string;
    /** The command (shell tools) or a one-line argument summary, secrets masked, bounded. */
    readonly cmd: string;
    /** Gate rule that let it through; `decider` when an approver allowed it. */
    readonly rule: string;
    readonly decider?: string;
    readonly startedAt: string;
    ms?: number;
    ok?: boolean;
    exitCode?: number;
    timedOut?: boolean;
}
export type CheckKind = 'test' | 'build' | 'lint';
export interface EvidenceCheck {
    readonly kind: CheckKind;
    readonly cmd: string;
    readonly at: string;
    readonly ok: boolean;
    readonly exitCode?: number;
    /** Test-runner summary lines found in the output (`test result: ok. 12 passed; 0 failed`). */
    readonly summary?: string;
}
export interface TaskEvidence {
    readonly calls: {
        allowed: number;
        approved: number;
        denied: number;
    };
    readonly commands: EvidenceCommand[];
    readonly checks: EvidenceCheck[];
    /** True when older commands were dropped to stay within the bound. */
    truncated?: boolean;
}
export declare const MAX_COMMANDS = 200;
export declare const MAX_CHECKS = 50;
/** Which kind of check a shell command is, if any (the first matching kind wins: test > lint > build). */
export declare function checkKind(command: string): CheckKind | undefined;
/** The outcome of one host tool result: error flag, exit code, time-out, and its text. */
export declare function outcomeOf(result: unknown): {
    ok: boolean;
    exitCode?: number;
    timedOut?: boolean;
    text: string;
};
export declare class EvidenceRecorder {
    private readonly tasks;
    /** Calls awaiting their result, by the host's execution object and (should the host pass a copy) its call id. */
    private readonly open;
    private readonly openByCall;
    private readonly now;
    constructor(now?: () => number);
    private forTaskOrNew;
    /** A call the gate let through (`decider` set when an approver allowed it). Keyed by the host's execution object. */
    started(exec: object, taskId: string, tool: string, args: Readonly<Record<string, unknown>>, rule: string, decider?: string): void;
    /** A call the gate (or an approver) refused. */
    denied(taskId: string): void;
    /** The host's final result for a call recorded by `started`. Unknown executions are ignored. */
    finished(exec: object, result: unknown): void;
    /** The evidence so far for a task (live view). */
    get(taskId: string): TaskEvidence | undefined;
    /** The evidence of a finished task, removed from memory (the task record keeps it). */
    take(taskId: string): TaskEvidence | undefined;
}
