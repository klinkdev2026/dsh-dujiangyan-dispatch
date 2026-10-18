import type { RouteEntry } from './config.ts';
import type { HostAgent, HostContext, HostSession } from './host.ts';
export interface DispatchedSession {
    readonly sessionId: string;
    readonly role?: string;
    readonly title?: string;
    /** Which orchestrator created it (claude, codex, …). */
    readonly createdBy?: string;
    /** Dispatch batch: one orchestrator run (MCP connection) unless the caller names it. */
    readonly batch?: string;
    readonly cwd: string;
    /** The route chain; requests use its first healthy entry. */
    readonly chain: readonly RouteEntry[];
    readonly createdAt: string;
    closedAt?: string;
}
export declare class DispatchRegistry {
    private readonly roots;
    private readonly rootOfCache;
    private readonly file;
    private readonly ctx;
    constructor(ctx: HostContext, stateDir: string);
    private readonly closed;
    add(rec: DispatchedSession): void;
    close(sessionId: string): void;
    get(sessionId: string): DispatchedSession | undefined;
    list(): DispatchedSession[];
    get size(): number;
    /**
     * How the desktop currently sees a dispatched session: archived from the
     * sidebar (the user can do that at any time), present, or gone from every
     * workspace (then opening it would start an unrelated empty conversation).
     */
    desktopState(sessionId: string): 'active' | 'archived' | 'missing' | 'unknown';
    /** The dispatch root a session descends from, or undefined when it is not in the lineage. */
    rootOf(agentOrSession: HostAgent | HostSession | undefined): string | undefined;
    private headerOf;
    private persist;
}
