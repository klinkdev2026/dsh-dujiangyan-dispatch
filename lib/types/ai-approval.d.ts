import type { ApprovalContext } from './approval-context.ts';
import type { HostContext, StreamChunk } from './host.ts';
export interface Judge {
    readonly provider: string;
    readonly model: string;
    /** Reasoning effort id for this judge; absent picks the route's least effort ("reasoning off"). */
    readonly effort?: string;
}
export interface AiApprovalConfig {
    readonly enabled: boolean;
    /** Asked in this order; put the fastest judge first. */
    readonly judges: readonly Judge[];
    /** Only "wide" exists: every eligible rule below may be judged. */
    readonly scope: 'wide';
    /** Per judge call. */
    readonly timeoutMs: number;
    /** Most AI judgments one session may use in any 10 minutes; over budget the call waits for a human. */
    readonly maxPerSessionPer10Min: number;
}
/**
 * No model is assumed: unless `aiApproval.judges` is set, the judges are taken from the user's own
 * roster (the reviewer, then the planner, then the implementer route), preferring two different
 * models. Judges from two different vendors are best: a split is what keeps one model's blind spot
 * from deciding alone.
 */
export declare function judgesFromRoster(roster: Readonly<Record<string, readonly Judge[]>>): Judge[];
export declare const DEFAULT_AI_APPROVAL: Omit<AiApprovalConfig, 'judges'>;
/**
 * Gate rules the judges may decide (scope "wide"). Everything not listed here is
 * never sent to a judge: network-read, web-fetch, web-search, git-network,
 * pip-install, node-package, mcp-tool, unknown-tool, script-outside-root,
 * git-outside-root, workdir-outside-root, encoded-command, env-loader,
 * sandbox-escalation, nesting, classifier-error — and every deny.
 */
export declare const AI_ELIGIBLE_RULES: ReadonlySet<string>;
export type AiDecision = 'allow' | 'deny' | 'human';
export interface AiOpinion {
    readonly judge: string;
    readonly decision: AiDecision | 'error';
    readonly reason: string;
    readonly latencyMs: number;
}
export interface AiVerdict {
    /** `allow` / `deny` only when every judge agreed; otherwise the call stays with a human. */
    readonly outcome: 'allow' | 'deny' | 'pending';
    readonly opinions: readonly AiOpinion[];
}
export interface JudgeInput {
    readonly tool: string;
    /** The approver-facing summary of the arguments (secrets masked, bounded). */
    readonly summary: string;
    readonly cwd: string;
    readonly roots: readonly string[];
    /** Gate rule id (ours, never worker text). */
    readonly rule: string;
    /** Gate reason; it can quote worker-controlled text (a command name), so it goes inside the data fence. */
    readonly reason: string;
    /** Environment facts from the profile and the personal rules file (trusted). */
    readonly facts: readonly string[];
    /** Task, worker narration and recent calls (worker-written, untrusted): only ever inside the data fence. */
    readonly context?: ApprovalContext;
}
export declare const judgeKey: (j: Judge) => string;
/** Whether a gated call may go to the judges at all. */
export declare function aiEligible(rule: string, truncated: boolean): boolean;
export declare function judgePrompt(input: JudgeInput, nonce?: string): string;
/** Parse a judge's reply: the first JSON object with a valid decision, else undefined. */
export declare function parseOpinion(text: string): {
    decision: AiDecision;
    reason: string;
} | undefined;
/** Answer text carried by a streamed chunk: only `text-delta` (never `reasoning-delta`). */
export declare function chunkText(chunk: StreamChunk): string;
/**
 * Ask the judges in order; stop as soon as unanimity is impossible. Only a unanimous
 * answer from every judge decides; anything else is `pending` (a human decides).
 */
export declare function askJudges(ctx: HostContext, config: AiApprovalConfig, input: JudgeInput, signal?: AbortSignal): Promise<AiVerdict>;
/** A judge failing this many times in a row (or failing its probe) is reported degraded. */
export declare const JUDGE_DEGRADED_AFTER = 3;
export interface JudgeHealth {
    readonly judge: string;
    readonly consecutiveErrors: number;
    readonly lastError?: string;
    readonly lastOkAt?: string;
    readonly lastCheckedAt: string;
    /** `probe` = the startup/config-change check; `live` = a real judgment. */
    readonly source: 'probe' | 'live';
    readonly degraded: boolean;
}
/**
 * Ask each judge a tiny fixed question (startup and config change). A silent judge failure made
 * every escalation fall to a human without anyone noticing (seen with a provider that only accepts temperature 1).
 */
export declare function probeJudges(ctx: HostContext, config: AiApprovalConfig, signal?: AbortSignal): Promise<AiOpinion[]>;
/** The effective AI-approval setting: profile config, then the hot-reloaded file, then a runtime toggle. */
/** Where the judges in force come from, most specific first. */
export type JudgesSource = 'session' | 'workspace' | 'runtime' | 'local-rules' | 'profile';
/** Judges that apply to one dispatched session only: its own, or its folder's (`local-rules.json` workspaces). */
export interface ScopedJudges {
    readonly judges: readonly Judge[];
    readonly source: 'session' | 'workspace';
}
export declare const isJudge: (j: unknown) => j is Judge;
export declare class AiApproval {
    private override;
    private readonly base;
    private readonly local;
    private readonly usage;
    private readonly judgeHealth;
    /** Called when a judge turns degraded or recovers (events, audit, panel). */
    onHealthChange: ((change: {
        judge: string;
        degraded: boolean;
        health: JudgeHealth;
    }) => void) | undefined;
    /** Judges chosen at runtime (`djy_ai_approval_set`), kept in the plugin data dir across restarts. */
    private judgesOverride;
    private readonly judgesFile;
    private readonly scoped;
    private readonly scopedInUse;
    constructor(base: () => AiApprovalConfig, local: () => Partial<AiApprovalConfig> | undefined, judgesFile?: string, scoped?: (root: string) => ScopedJudges | undefined, scopedInUse?: () => readonly Judge[]);
    /** Replace the judges at runtime (no profile edit, so no desktop reload); `undefined` returns to the configured ones. */
    setJudges(judges: readonly Judge[] | undefined): void;
    /** Record one judge's answer: an error extends its failure streak, any decision clears it. */
    record(opinion: AiOpinion, source: 'probe' | 'live', now?: Date): void;
    /** Every judge in force somewhere: the global ones and those of sessions, batches and folders. */
    inUse(): Judge[];
    /**
     * Health of every judge in use (unchecked judges are listed as not yet checked), so a dead
     * session judge is reported like a dead global one (review S2).
     */
    health(): {
        readonly degraded: boolean;
        readonly judges: ReadonlyArray<JudgeHealth | {
            readonly judge: string;
            readonly unchecked: true;
        }>;
    };
    /**
     * The effective setting; with a dispatch root, that session's own judges (or its folder's) win
     * over the global ones, so orchestrators working in different folders can each pick theirs.
     */
    current(root?: string): AiApprovalConfig & {
        readonly source: 'profile' | 'local-rules' | 'runtime';
        readonly judgesSource: JudgesSource;
    };
    /** Runtime toggle (in memory); `undefined` returns to the configured value. */
    setEnabled(enabled: boolean | undefined): void;
    /**
     * Take one judgment from a session's budget (a sliding 10-minute window). Returns false when the
     * session is over budget: a looping worker must not turn into an unbounded stream of model calls.
     */
    takeBudget(sessionId: string, now?: number): boolean;
}
