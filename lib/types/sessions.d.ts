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
}
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
    /** The live agent for a dispatched session, resuming it after a host restart. */
    agent(sessionId: string): Promise<HostAgent>;
    close(sessionId: string): Promise<boolean>;
    disposeAll(): Promise<void>;
    private attachWorkspace;
    private rename;
}
/** Short, stable label for the client that created a session (MCP clientInfo.name). */
export declare function clientLabel(name: string | undefined): string;
