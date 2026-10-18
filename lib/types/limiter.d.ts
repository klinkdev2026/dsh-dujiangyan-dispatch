/**
 * 宝瓶口 (Baopingkou) — request admission control per LLM provider.
 *
 * Every model request takes a lease before it reaches the provider and returns
 * it with an outcome. Per provider this enforces: a concurrency cap that adapts
 * (AIMD: halve on 429/overload, +1 after a streak of successes), a requests-per-
 * minute window, a minimum start spacing with random jitter (so a team never
 * fires in the same instant), `Retry-After`, and a circuit breaker with a
 * half-open probe. The controller owns no retries: Harness' own retry layer
 * re-enters through `acquire`, so every attempt is admitted here exactly once.
 */
export interface ProviderLimit {
    /** Configured concurrency ceiling (in-flight requests). */
    readonly maxConcurrent: number;
    /** Requests per rolling minute; 0 disables the window. */
    readonly rpm: number;
    /** Minimum gap between two request starts. */
    readonly minSpacingMs: number;
    /** Uniform random extra gap added to the spacing (0..jitterMs). */
    readonly jitterMs: number;
    /** Consecutive successes before the adaptive cap grows by one. */
    readonly increaseAfter: number;
    /** Consecutive rate-limit/overload failures that open the circuit. */
    readonly breakerThreshold: number;
    /** How long an open circuit rejects traffic before a half-open probe. */
    readonly breakerCooldownMs: number;
}
export declare const DEFAULT_LIMIT: ProviderLimit;
/** How a leased request ended. Only rate limits and overloads move the cap and the breaker. */
export type Outcome = 'ok' | 'rate_limited' | 'overloaded' | 'error' | 'cancelled';
/** 0 interactive/approval, 1 normal task work, 2 background. */
export type Priority = 0 | 1 | 2;
export interface Clock {
    now(): number;
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
    random(): number;
}
export declare const realClock: Clock;
export interface Lease {
    readonly provider: string;
    /** Return the lease; idempotent. `retryAfterMs` is the provider-requested delay, when known. */
    release(outcome: Outcome, retryAfterMs?: number): void;
}
export interface ProviderSnapshot {
    readonly cap: number;
    readonly maxConcurrent: number;
    readonly inFlight: number;
    readonly queued: number;
    readonly circuit: 'closed' | 'open' | 'half-open';
    readonly openForMs: number;
    readonly counts: Readonly<Record<Outcome, number>>;
}
export declare class AdmissionController {
    private readonly states;
    private seq;
    private readonly limitFor;
    private readonly clock;
    constructor(limitFor?: (provider: string) => ProviderLimit, clock?: Clock);
    /** Wait for an admission slot on `provider`. Rejects with the signal's reason when aborted. */
    acquire(provider: string, options?: {
        priority?: Priority;
        signal?: AbortSignal;
    }): Promise<Lease>;
    /**
     * Override a provider's limits at runtime (in memory only; the profile config
     * applies again after a restart). Changing `maxConcurrent` also resets the
     * adaptive cap to the new ceiling.
     */
    setLimit(provider: string, patch: Partial<ProviderLimit>): ProviderLimit;
    /** True while the provider's circuit is open (callers may route to a fallback). */
    isOpen(provider: string): boolean;
    snapshot(): Record<string, ProviderSnapshot>;
    private state;
    private schedule;
    private pump;
    private lease;
}
/** Classify a provider failure (Harness `LlmFailure`-like or a thrown error) into an outcome. */
export declare function outcomeOf(failure: unknown): {
    outcome: Outcome;
    retryAfterMs?: number;
};
