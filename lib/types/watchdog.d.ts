/**
 * Watchdog: nothing may wait silently.
 *
 * The approval chain had a single point of failure — an external orchestrator that must be awake —
 * and no alarm when it failed: approvals sat for the full timeout, a stuck task looked like a busy
 * one, and a failing AI judge quietly routed everything to humans. Every tick this module turns
 * those silent states into alerts (events, audit, the panel banner, desktop notifications from the
 * panel) and steers waiting workers so they do not rewrite a held call.
 */
import type { AiApproval } from './ai-approval.ts';
import type { ApprovalQueue } from './approvals.ts';
import type { ResolvedConfig } from './config.ts';
import type { EventLog } from './events.ts';
import type { TaskRecord } from './tasks.ts';
export type AlertKind = 'approval-aging' | 'ai-degraded' | 'task-stalled' | 'orchestrator-absent';
export interface HealthAlert {
    readonly id: string;
    readonly kind: AlertKind;
    readonly level: 'warn' | 'critical';
    readonly message: string;
    readonly since: string;
    readonly sessionId?: string;
    readonly taskId?: string;
    readonly approvalId?: string;
}
export interface HealthBlock {
    readonly now: string;
    readonly pendingApprovals: number;
    readonly oldestPendingSec: number | undefined;
    readonly ai: ReturnType<AiApproval['health']> & {
        readonly enabled: boolean;
    };
    readonly stalledTasks: ReadonlyArray<{
        taskId: string;
        sessionId: string;
        idleSec: number;
    }>;
    readonly waitingTasks: ReadonlyArray<{
        taskId: string;
        sessionId: string;
        reason: string;
        untilSec: number | undefined;
    }>;
    readonly orchestratorLastSeenSec: number | undefined;
    readonly alerts: readonly HealthAlert[];
}
export interface WatchdogDeps {
    readonly config: ResolvedConfig;
    readonly approvals: ApprovalQueue;
    readonly events: EventLog;
    readonly audit: (record: Record<string, unknown>) => void;
    readonly aiApproval: AiApproval;
    readonly runningTasks: () => readonly TaskRecord[];
    readonly steer: (sessionId: string, text: string) => Promise<unknown>;
    /** Milliseconds timestamp of the last authenticated MCP request (any orchestrator), if any. */
    readonly lastClientSeen: () => number | undefined;
    readonly now?: () => number;
}
export declare class Watchdog {
    private readonly d;
    private readonly now;
    private cursor;
    private epoch;
    private readonly activity;
    private readonly steered;
    private readonly warned;
    private readonly alerts;
    constructor(deps: WatchdogDeps);
    /** Start the periodic tick; returns the stop function. The timer never keeps the host alive. */
    start(): () => void;
    private raise;
    private clear;
    /** One pass over approvals, tasks, AI health and orchestrator presence. */
    tick(): void;
    /** Per-task activity from the event log (tool calls, approvals, steering, quiet-mode waits). */
    private readActivity;
    snapshot(): HealthBlock;
}
