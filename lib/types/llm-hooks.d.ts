import type { EventLog } from './events.ts';
import type { HostContext } from './host.ts';
import { type AdmissionController } from './limiter.ts';
import type { DispatchRegistry } from './registry.ts';
export interface UsageTotals {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cacheHitTokens: number;
    cacheMissTokens: number;
}
export declare class UsageMeter {
    readonly byRoute: Map<string, UsageTotals>;
    private readonly finishListeners;
    record(provider: string, model: string | undefined, usage: Record<string, unknown> | undefined): void;
    countRequest(provider: string, model: string | undefined): void;
    /** Notify the stagger leader logic that some model response completed. */
    onFinish(listener: (provider: string) => void): () => void;
    finished(provider: string): void;
    snapshot(): Record<string, UsageTotals & {
        cacheHitRate: number | null;
    }>;
}
/**
 * Routes (provider + model) that fail deterministically — the provider is up,
 * but this model cannot serve requests through it: a gateway whose API dialect
 * does not match the model (e.g. an `anthropic-messages` gateway serving a
 * Gemini model → 400 "Unknown name anthropic_version"), an unknown model (404), a key without
 * access (401/403). Retrying the same route never helps, so it is benched for a
 * while and dispatched sessions move down their chain.
 */
export declare class RouteHealth {
    private readonly broken;
    private readonly probes;
    private readonly ttlMs;
    private readonly now;
    constructor(ttlMs?: number, now?: () => number);
    static key(route: {
        provider: string;
        model: string;
    }): string;
    markBroken(route: {
        provider: string;
        model: string;
    }, reason: string): void;
    clear(route: {
        provider: string;
        model: string;
    }): void;
    isBroken(route: {
        provider: string;
        model: string;
    }): boolean;
    recordProbe(route: {
        provider: string;
        model: string;
    }, ok: boolean, detail: string, latencyMs: number): void;
    snapshot(): {
        broken: Record<string, {
            reason: string;
            until: string;
        }>;
        probes: Record<string, unknown>;
    };
}
/** A failure that will repeat on every retry of the same route (not rate limits, not the prompt's own size). */
export declare function isDeterministicRouteFailure(failure: unknown): boolean;
export declare function installLlmHooks(ctx: HostContext, deps: {
    limiter: AdmissionController;
    usage: UsageMeter;
    registry: DispatchRegistry;
    events: EventLog;
    health: RouteHealth;
}): void;
/** Probe routes with one tiny real request each; records health and benches deterministic failures. */
export declare function probeRoutes(ctx: HostContext, health: RouteHealth, routes: ReadonlyArray<{
    provider: string;
    model: string;
}>, timeoutMs?: number): Promise<Array<{
    route: string;
    ok: boolean;
    latencyMs: number;
    detail: string;
}>>;
