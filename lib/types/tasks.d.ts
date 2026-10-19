import type { ResolvedConfig } from './config.ts';
import type { EventLog } from './events.ts';
import { type HostContext } from './host.ts';
import type { UsageMeter } from './llm-hooks.ts';
import type { LeaseManager } from './locks.ts';
import type { DispatchRegistry } from './registry.ts';
import type { SessionManager, WorkerQuestion } from './sessions.ts';
/**
 * `interrupted`: the plugin stopped (desktop restart/quit) or the turn was aborted from outside before it finished.
 * `needs_input`: the worker asked the user a question (see `questions`); answer it in a follow-up task.
 * `needs_attention`: the worker kept hitting denials and was paused (deny circuit breaker); read why, then submit a new task.
 */
export type TaskStatus = 'queued' | 'waiting_resources' | 'waiting_slot' | 'running' | 'done' | 'error' | 'cancelled' | 'interrupted' | 'needs_input' | 'needs_attention';
export declare const FINISHED_STATUSES: ReadonlySet<TaskStatus>;
/** Host-side failures before the turn did anything (prompt assembly not ready after a restart). */
export declare const STARTUP_ERROR: RegExp;
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
    /** Questions the worker asked (status `needs_input`); nothing was chosen on its behalf. */
    questions?: WorkerQuestion[];
    /** Why the task was paused (status `needs_attention`). */
    attention?: string;
    /** The worker's latest narration (tail of its last assistant text), so a reviewer sees what it is doing. */
    latest?: string;
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
    private readonly localFacts;
    private stopping;
    /** Outcome decided outside the turn (a question, the deny breaker); applied when the turn unwinds. */
    private readonly endings;
    constructor(deps: {
        ctx: HostContext;
        config: ResolvedConfig;
        sessions: SessionManager;
        registry: DispatchRegistry;
        leases: LeaseManager;
        events: EventLog;
        usage: UsageMeter;
        /** Extra environment facts from the personal rules file for a session's working directory. */
        localFacts?: (cwd: string | undefined) => readonly string[];
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
    /**
     * The plugin is stopping (desktop restart or quit): every unfinished task ends as `interrupted`
     * now, synchronously, so the record on disk is right even if the process exits before the
     * running turns unwind. Their later completion cannot overwrite this.
     */
    stop(): void;
    /** Cancel every unfinished task of a session (used before the session is closed). */
    cancelSession(sessionId: string): Promise<void>;
    cancel(id: string): Promise<boolean>;
    /** A worker asked the user something: record it on the running task and end the turn (no one will answer). */
    private onQuestion;
    /** The deny circuit breaker tripped for this session's running task: pause it. */
    pauseForAttention(rootSessionId: string, taskId: string | undefined, detail: {
        consecutive: number;
        windowDenies: number;
        lastRule: string;
    }): void;
    private endTurn;
    /**
     * Deliver a message into the running worker's next model step (prior art: dsh-agent-teams
     * steerMemberPrompt — steer, not followup, so it is read now and not queued as a new turn).
     * Only while a task runs: steering an idle agent would start a turn the task runner does not own.
     */
    steer(sessionId: string, text: string, from?: 'orchestrator' | 'watchdog'): Promise<{
        taskId: string;
    }>;
    /** Whether `steer()` can reach this session right now (used to refuse a note before deciding). */
    canSteer(sessionId: string): boolean;
    /** Resources held by the task running on a root session (gate uses this for the bench rule). */
    heldResources(rootSessionId: string): readonly string[];
    runningTask(rootSessionId: string): string | undefined;
    /** The running task on a root session and the worker's latest assistant text (for approval context). */
    approvalContextFor(rootSessionId: string): {
        id: string;
        title?: string;
        prompt: string;
        lastAssistant?: string;
    } | undefined;
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
    private resultOf;
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
