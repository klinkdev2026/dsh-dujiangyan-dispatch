import type { AiOpinion } from './ai-approval.ts';
import type { ApprovalContext } from './approval-context.ts';
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
    /** True when `summary` was cut at the bound: the approver has not seen the whole call. */
    readonly truncated?: boolean;
    readonly rule: string;
    readonly reason: string;
    readonly cwd: string;
    /** `pre-execute` (a tool call) or `sandbox` (an escalation inside a tool body). */
    readonly origin: 'pre-execute' | 'sandbox';
    /** Task, worker narration and recent calls, so the approver can judge the call in context (untrusted text). */
    readonly context?: ApprovalContext;
    /** Set on host sandbox escalations: what approving actually grants (shown as a strong warning). */
    readonly danger?: string;
}
/** What the AI judges said about a pending call (attached while it waits for a human). */
export interface AiAnnotation {
    /** `judging` while the judges run; `split` when they did not all agree (or one said "human"/failed). */
    readonly status: 'judging' | 'split';
    readonly opinions: readonly AiOpinion[];
}
export interface PendingApproval extends ApprovalRequest {
    readonly id: string;
    readonly createdAt: string;
    readonly expiresAt: string;
    readonly ai?: AiAnnotation;
}
/** What became of an approval that is no longer pending (kept briefly, e.g. to deliver a late note). */
export interface SettledApproval {
    readonly id: string;
    readonly sessionId: string;
    readonly taskId?: string;
    readonly result: ApprovalResult['kind'];
    readonly decider?: string;
    readonly at: string;
}
export interface RequestOptions {
    /**
     * Hold the `approval/pending` event back (AI judges are deciding): `publish()` writes it, at the
     * latest after `publishAfterMs`. An approval the judges settle never reaches the orchestrator's stream.
     */
    readonly deferEvent?: boolean;
    readonly publishAfterMs?: number;
}
export declare class ApprovalQueue {
    private readonly entries;
    private readonly recentlySettled;
    private readonly events;
    private readonly audit;
    private readonly now;
    constructor(events: EventLog, audit: (record: Record<string, unknown>) => void, now?: () => number);
    /** Park one request until decided, timed out, or aborted. `onCreated` receives the id once it is listed. */
    request(req: ApprovalRequest, timeoutMs: number, signal?: AbortSignal, onCreated?: (id: string) => void, opts?: RequestOptions): Promise<ApprovalResult>;
    /** A signal that aborts when the approval settles (any decider, timeout or cancel); undefined once settled. */
    settledSignal(id: string): AbortSignal | undefined;
    list(): PendingApproval[];
    /** Write a deferred `approval/pending` event (with the judges' opinions attached by then). */
    publish(id: string): void;
    /** The outcome of an approval settled recently (the last few hundred), if any. */
    settled(id: string): SettledApproval | undefined;
    /** Decide a pending approval. Returns false when it is unknown or already settled. */
    decide(id: string, decision: ApprovalDecision, reason: string, decider: string): boolean;
    /** Attach the AI judges' opinions to a pending approval. Returns false when it is no longer pending. */
    annotate(id: string, ai: AiAnnotation): boolean;
    /** Cancel every pending approval (plugin disposal). */
    cancelAll(): void;
}
/**
 * Bound on the approver-facing summary. A shell command has to be read in full to be judged
 * (a real run had `Remove-Item …; cargo test` hidden past a 1200-character cut), so the bound
 * is generous and a cut is flagged rather than silent.
 */
export declare const SUMMARY_MAX = 16000;
/** Summarize tool arguments for an approver: bounded length, likely secrets masked. */
export declare function summarizeArgs(args: Readonly<Record<string, unknown>>, max?: number): string;
/** Whole-word match on the argument name (api_key, apiKey, X-Auth-Token), so monkey / keyboard / max_tokens stay visible. */
export declare function isSecretKey(key: string): boolean;
export declare function summarizeForApproval(args: Readonly<Record<string, unknown>>, max?: number): {
    summary: string;
    truncated: boolean;
};
export declare function redactSecrets(text: string): string;
