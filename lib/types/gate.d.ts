import { type AiApproval } from './ai-approval.ts';
import { type ApprovalQueue } from './approvals.ts';
import type { ResolvedConfig } from './config.ts';
import type { EventLog } from './events.ts';
import type { HostAgent, HostContext } from './host.ts';
import { type LocalRules } from './local-rules.ts';
import type { EvidenceRecorder } from './evidence.ts';
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
    /** The task whose turn the plugin just stopped on this idle root session (cancel, needs_input, needs_attention). */
    readonly stoppedTask?: (rootSessionId: string) => {
        taskId: string;
        status: string;
    } | undefined;
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
    /** Milliseconds timestamp of the last authenticated MCP request (an orchestrator is around), if any. */
    readonly approverSeen?: () => number | undefined;
    /** Bench rights of the task running on a root session (`command`, `task`, `shared`), if any. */
    readonly benchMode?: (rootSessionId: string) => 'command' | 'task' | 'shared' | undefined;
    /** The machine-wide `bench` lease, taken per benchmark command in `command` mode. */
    readonly benchLease?: {
        acquire(holder: string, signal: AbortSignal): Promise<void>;
        release(holder: string): void;
    };
    /** The orchestrator's quiet-mode switch (`djy_quiet_set`), when set and not expired. */
    readonly quietOverride?: () => boolean | undefined;
    /** Records what each task really ran (calls let through, their results, build and test runs). */
    readonly evidence?: EvidenceRecorder;
    /**
     * A session called tool names of another agent host twice in a row (findings 55/59: a gateway
     * renamed the tools); its route cannot work. Called once per run of such calls.
     */
    readonly onForeignTools?: (agent: HostAgent, root: string, taskId: string | undefined, names: readonly string[]) => void;
    /** A step that timed out again waiting for an approver; the worker was told to skip it. */
    readonly onBlocked?: (root: string, taskId: string | undefined, step: {
        tool: string;
        rule: string;
        summary: string;
        fingerprint: string;
    }) => void;
}
/** Prefix on every denial a worker receives, so it (and the orchestrator) can tell a gate denial from a tool error. */
export declare const DENY_MARKER = "[dujiangyan-denied";
export declare function installGate(ctx: HostContext, deps: GateDeps): void;
