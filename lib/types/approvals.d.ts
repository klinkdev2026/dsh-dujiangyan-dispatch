import type { EventLog } from './events.ts';
export type ApprovalDecision = 'allow' | 'deny';
export type ApprovalResult = {
    readonly kind: 'allow';
    readonly reason: string;
    readonly decider: string;
} | {
    readonly kind: 'deny';
    readonly reason: string;
    readonly decider: string;
} | {
    readonly kind: 'timeout';
} | {
    readonly kind: 'cancelled';
};
export interface ApprovalRequest {
    readonly sessionId: string;
    readonly taskId?: string;
    readonly tool: string;
    /** Bounded, secret-free summary of the arguments shown to the approver. */
    readonly summary: string;
    readonly rule: string;
    readonly reason: string;
    readonly cwd: string;
    /** `pre-execute` (a tool call) or `sandbox` (an escalation inside a tool body). */
    readonly origin: 'pre-execute' | 'sandbox';
}
export interface PendingApproval extends ApprovalRequest {
    readonly id: string;
    readonly createdAt: string;
    readonly expiresAt: string;
}
export declare class ApprovalQueue {
    private readonly entries;
    private readonly events;
    private readonly audit;
    private readonly now;
    constructor(events: EventLog, audit: (record: Record<string, unknown>) => void, now?: () => number);
    /** Park one request until decided, timed out, or aborted. */
    request(req: ApprovalRequest, timeoutMs: number, signal?: AbortSignal): Promise<ApprovalResult>;
    list(): PendingApproval[];
    /** Decide a pending approval. Returns false when it is unknown or already settled. */
    decide(id: string, decision: ApprovalDecision, reason: string, decider: string): boolean;
    /** Cancel every pending approval (plugin disposal). */
    cancelAll(): void;
}
/** Summarize tool arguments for an approver: bounded length, likely secrets masked. */
export declare function summarizeArgs(args: Readonly<Record<string, unknown>>, max?: number): string;
