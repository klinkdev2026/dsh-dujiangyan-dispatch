import type { ResolvedConfig, RouteEntry } from './config.ts';
import type { EventLog } from './events.ts';
import type { HostAgent, HostContext } from './host.ts';
import { type PreflightIssue } from './preflight.ts';
import type { RouteHealth } from './llm-hooks.ts';
import type { DispatchRegistry } from './registry.ts';
export interface CreateSessionInput {
    readonly role?: string;
    readonly route?: RouteEntry;
    /** Fallback routes tried in order after `route` (forms the session's chain). */
    readonly fallbacks?: readonly RouteEntry[];
    readonly cwd: string;
    readonly title?: string;
    /** Create the session even when preflight reports issues. */
    readonly ignorePreflight?: boolean;
    /** The MCP client that asked (e.g. claude-code, codex); shown as a title prefix. */
    readonly createdBy?: string;
    /** Batch label grouping sessions of one dispatch run. */
    readonly batch?: string;
    /**
     * Paths the session may write (inside the roots). Default: the cwd when it is a strict
     * subdirectory of a root (one spike folder), else the whole roots (unchanged behaviour).
     */
    readonly writeScope?: readonly string[];
}
/** A question a worker put to the user (`user-questions/request`), handed to the orchestrator instead. */
export interface WorkerQuestion {
    readonly id: string;
    readonly question: string;
    readonly detail?: string;
    readonly options?: ReadonlyArray<{
        label: string;
    }>;
}
/** What a session does with a question nobody is there to answer. */
export type QuestionHandler = (sessionId: string, questions: readonly WorkerQuestion[]) => void;
export type CreateSessionResult = {
    readonly ok: true;
    readonly sessionId: string;
    readonly route: RouteEntry;
    readonly chain: readonly RouteEntry[];
    readonly skippedRoutes: ReadonlyArray<{
        route: RouteEntry;
        error: string;
    }>;
    readonly warnings: readonly string[];
    readonly writeScope?: readonly string[];
} | {
    readonly ok: false;
    readonly error: string;
    readonly preflight?: readonly PreflightIssue[];
};
export declare class SessionManager {
    private readonly handles;
    private readonly ctx;
    private readonly config;
    private readonly registry;
    private readonly events;
    private readonly health;
    /** Set by the task manager: records the question on the running task and ends its turn. */
    onQuestion: QuestionHandler | undefined;
    constructor(ctx: HostContext, config: ResolvedConfig, registry: DispatchRegistry, events: EventLog, health?: RouteHealth);
    /** Validate each route against the host's adapters; keep the usable ones in order. */
    validateChain(chain: readonly RouteEntry[]): Promise<{
        valid: RouteEntry[];
        skipped: Array<{
            route: RouteEntry;
            error: string;
        }>;
    }>;
    create(input: CreateSessionInput): Promise<CreateSessionResult>;
    /** The canonical write scope for a new session, or an error when a path is outside the roots. */
    private resolveWriteScope;
    /**
     * Prior art: dsh-crew worker-question.mjs. No one answers a dispatched worker's question, so the
     * request must not hang: hand it to the orchestrator (the task ends as needs_input) and refuse it.
     */
    private installQuestionHandoff;
    /** The live agent for a dispatched session, resuming it after a host restart. */
    agent(sessionId: string): Promise<HostAgent>;
    close(sessionId: string): Promise<boolean>;
    disposeAll(): Promise<void>;
    /** Re-apply the sandbox preset on a resumed session; refuse to hand out the session if that fails. */
    private applyPermissionPreset;
    private attachWorkspace;
    private rename;
}
/** Short, stable label for the client that created a session (MCP clientInfo.name). */
export declare function clientLabel(name: string | undefined): string;
