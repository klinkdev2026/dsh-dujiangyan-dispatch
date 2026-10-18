import { type ProviderLimit } from './limiter.ts';
import type { RuleConfig } from './rules.ts';
/** One route of a role's model chain: the first healthy entry serves requests. */
export interface RouteEntry {
    readonly provider: string;
    readonly model: string;
    readonly effort?: string;
}
export interface Config {
    host?: string;
    port?: number;
    stateDir?: string;
    workspaceRoots?: string[];
    permissionPreset?: string;
    agentPreset?: string;
    approvalTimeoutMs?: number;
    /** When an approval times out, hand root sessions to the desktop's own approval prompt. */
    fallbackToHuman?: boolean;
    roster?: Record<string, RouteEntry[]>;
    limits?: {
        defaults?: Partial<ProviderLimit>;
        providers?: Record<string, Partial<ProviderLimit>>;
    };
    /** Optional experiment: stagger task starts behind a leader to warm the provider's prefix cache. Off by default. */
    stagger?: {
        enabled?: boolean;
        baseMs?: number;
        jitterMs?: number;
        leaderWaitMs?: number;
    };
    /** Cap on sessions that exist at once; 0 (default) = unlimited. Idle sessions cost nothing. */
    maxSessions?: number;
    /**
     * Optional cap on sessions running a task at the same time (local load only); 0 (default) = unlimited.
     * API pressure is NOT controlled here: every request already passes the per-provider admission
     * control (concurrency cap, spacing + jitter, 429 backoff, breaker), so any number of sessions
     * can run and their requests are staggered onto each key.
     */
    maxActiveSessions?: number;
    rules?: RuleConfig;
    /** Run the workspace preflight before creating a session (Windows integrity labels). */
    preflight?: boolean;
}
export interface ResolvedConfig {
    readonly host: string;
    readonly port: number;
    readonly stateDir: string;
    readonly workspaceRoots: readonly string[];
    readonly permissionPreset: string;
    readonly agentPreset: string;
    readonly approvalTimeoutMs: number;
    readonly fallbackToHuman: boolean;
    readonly roster: Readonly<Record<string, readonly RouteEntry[]>>;
    readonly limitFor: (provider: string) => ProviderLimit;
    readonly stagger: {
        readonly enabled: boolean;
        readonly baseMs: number;
        readonly jitterMs: number;
        readonly leaderWaitMs: number;
    };
    readonly maxSessions: number;
    readonly maxActiveSessions: number;
    readonly rules: RuleConfig;
    readonly preflight: boolean;
}
/**
 * At personal scale (5–10 agents) the binding limits are the user's own keys —
 * gateway keys often allow only a few concurrent requests — not the provider's
 * capacity. Defaults therefore only cap concurrency per key; the RPM window is
 * off unless a key documents one.
 */
export declare const DEFAULT_PROVIDER_LIMITS: Readonly<Record<string, Partial<ProviderLimit>>>;
export declare const DEFAULT_ROSTER: Readonly<Record<string, readonly RouteEntry[]>>;
export declare function resolveConfig(config?: Config): ResolvedConfig;
