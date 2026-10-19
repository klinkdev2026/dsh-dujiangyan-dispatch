export interface RecentCall {
    /** The task the call belonged to (calls from earlier tasks are not shown). */
    readonly taskId?: string;
    readonly tool: string;
    /** One-line argument summary (redacted, bounded). */
    readonly args: string;
    /** `allow` / `deny` / `escalate` at the gate, plus who settled an escalation. */
    readonly verdict: string;
    readonly rule: string;
    readonly decider?: string;
}
export interface ApprovalContext {
    readonly taskId?: string;
    readonly taskTitle?: string;
    /** First part of the task prompt the orchestrator sent. */
    readonly taskPrompt?: string;
    readonly sessionTitle?: string;
    readonly route?: string;
    /** The worker's latest assistant text before this call: its stated reason. */
    readonly lastAssistant?: string;
    /** The `description` the worker gave this very call, if any. */
    readonly description?: string;
    /** The task's previous gated calls, oldest first. */
    readonly recentCalls: readonly RecentCall[];
}
export declare const CONTEXT_LIMITS: {
    readonly prompt: 400;
    readonly assistant: 800;
    readonly description: 300;
    readonly args: 160;
    readonly calls: 5;
};
/** One line for a tool call's arguments: the command or path when there is one, else compact JSON. */
export declare function oneLineArgs(args: Readonly<Record<string, unknown>>): string;
export declare function buildApprovalContext(input: {
    task?: {
        id: string;
        title?: string;
        prompt: string;
        lastAssistant?: string;
    };
    session?: {
        title?: string;
        route?: string;
    };
    description?: unknown;
    recentCalls: readonly RecentCall[];
}): ApprovalContext;
