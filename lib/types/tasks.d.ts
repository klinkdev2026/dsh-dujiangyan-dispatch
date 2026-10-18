import type { ResolvedConfig } from './config.ts';
import type { EventLog } from './events.ts';
import type { HostContext } from './host.ts';
import type { UsageMeter } from './llm-hooks.ts';
import type { LeaseManager } from './locks.ts';
import type { DispatchRegistry } from './registry.ts';
import type { SessionManager } from './sessions.ts';
export type TaskStatus = 'queued' | 'waiting_resources' | 'waiting_slot' | 'running' | 'done' | 'error' | 'cancelled';
export interface TaskResult {
    /** Errors the agent reported during the turn (model/provider/session failures). */
    errors: string[];
    assistantText: string;
    toolCalls: Array<{
        name: string;
        args: string;
    }>;
    toolResultCount: number;
    summary: {
        changes: string;
        verification: string;
        leftovers: string;
    };
}
export interface TaskRecord {
    readonly id: string;
    readonly sessionId: string;
    readonly title?: string;
    readonly prompt: string;
    readonly resources: readonly string[];
    status: TaskStatus;
    readonly createdAt: string;
    startedAt?: string;
    finishedAt?: string;
    holds: string[];
    result?: TaskResult;
    error?: string;
}
export declare class TaskManager {
    private readonly tasks;
    private readonly chains;
    private readonly controllers;
    private readonly running;
    private readonly file;
    private lastStartAt;
    private leaderStartAt;
    private readonly ctx;
    private readonly config;
    private readonly sessions;
    private readonly registry;
    private readonly leases;
    private readonly events;
    private readonly usage;
    constructor(deps: {
        ctx: HostContext;
        config: ResolvedConfig;
        sessions: SessionManager;
        registry: DispatchRegistry;
        leases: LeaseManager;
        events: EventLog;
        usage: UsageMeter;
    });
    submit(input: {
        sessionId: string;
        prompt: string;
        title?: string;
        resources?: readonly string[];
    }): TaskRecord;
    get(id: string): TaskRecord | undefined;
    list(filter?: {
        sessionId?: string;
        status?: TaskStatus;
    }): TaskRecord[];
    cancel(id: string): Promise<boolean>;
    /** Resources held by the task running on a root session (gate uses this for the bench rule). */
    heldResources(rootSessionId: string): readonly string[];
    runningTask(rootSessionId: string): string | undefined;
    private run;
    private readonly slotHolders;
    private readonly slotWaiters;
    /** Optional local-load cap (config.maxActiveSessions > 0); unlimited by default. */
    private acquireSlot;
    private releaseSlot;
    /** Number of tasks currently running (for status). */
    get active(): number;
    /** Optional prefix-cache experiment: later starts wait behind a leader's first response. */
    private staggerStart;
    private readonly collecting;
    /** Resolve once the agent reports `running`, an error, or after a grace period (already-running agents). */
    private waitForRun;
    private onSessionEvent;
    private update;
    private persist;
}
/**
 * The same shape `createUserMessage` (dsh-llm 0.2.1-rc.2) builds: a detached,
 * frozen message with a fresh id. Built locally so the plugin carries no
 * runtime dependency on a host package that a `link:` install might resolve
 * to a second copy.
 */
export declare function userMessage(text: string, taskId: string): unknown;
/** The last `{changes, verification, leftovers}` JSON object in the text (also accepts 改动/验证/遗留). */
export declare function parseSummary(text: string): TaskResult['summary'];
