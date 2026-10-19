import { type AiApproval } from './ai-approval.ts';
import { type ApprovalQueue } from './approvals.ts';
import type { ResolvedConfig } from './config.ts';
import type { EventLog } from './events.ts';
import type { HostContext } from './host.ts';
import { type LocalRules } from './local-rules.ts';
import type { DispatchRegistry } from './registry.ts';
/** Heavy commands that wait while another session holds the `bench` lease (quiet mode). */
export declare const QUIET_PATTERNS: readonly RegExp[];
export interface GateDeps {
    readonly config: ResolvedConfig;
    readonly registry: DispatchRegistry;
    readonly approvals: ApprovalQueue;
    readonly events: EventLog;
    readonly audit: (record: Record<string, unknown>) => void;
    /** Resources (e.g. `bench`) held by the task currently running on a root session. */
    readonly heldResources: (rootSessionId: string) => readonly string[];
    /** The task currently running on a root session, for attribution. */
    readonly runningTask: (rootSessionId: string) => string | undefined;
    /** Personal hot-reloaded rules layered over the profile config. */
    readonly localRules?: LocalRules;
    /** Model judges for workspace-confined escalations (off unless enabled). */
    readonly aiApproval?: AiApproval;
    /** Holder of the `bench` lease right now, if any (quiet mode). */
    readonly benchHolder?: () => string | undefined;
    /** Poll interval while a heavy command waits for the bench lease (quiet mode). */
    readonly quietPollMs?: number;
    /** The running task's id/title/prompt and the worker's latest assistant text (approval context). */
    readonly approvalContext?: (rootSessionId: string) => {
        id: string;
        title?: string;
        prompt: string;
        lastAssistant?: string;
    } | undefined;
    /** Called once when a session's task trips the deny circuit breaker (the task is paused). */
    readonly onDenyBreaker?: (root: string, taskId: string | undefined, detail: {
        consecutive: number;
        windowDenies: number;
        lastRule: string;
    }) => void;
}
/** Prefix on every denial a worker receives, so it (and the orchestrator) can tell a gate denial from a tool error. */
export declare const DENY_MARKER = "[dujiangyan-denied";
export declare function installGate(ctx: HostContext, deps: GateDeps): void;
