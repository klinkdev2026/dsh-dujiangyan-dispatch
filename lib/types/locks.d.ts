export interface LeaseRecord {
    readonly name: string;
    readonly holder: string;
    readonly pid: number;
    readonly epoch: number;
    readonly acquiredAt: string;
    readonly expiresAt: number;
}
export declare class LeaseManager {
    private readonly heartbeats;
    private readonly queues;
    private readonly wakers;
    private readonly dir;
    private readonly ttlMs;
    private readonly now;
    private readonly isAlive;
    constructor(dir: string, ttlMs?: number, now?: () => number, isAlive?: (pid: number) => boolean);
    private file;
    read(name: string): LeaseRecord | undefined;
    private stale;
    /** Try once to take `name` for `holder`. Re-entrant for the same holder. */
    tryAcquire(name: string, holder: string): LeaseRecord | undefined;
    /** Wait (FIFO within this process, polling across processes) until `name` is held by `holder`. */
    acquire(name: string, holder: string, signal?: AbortSignal, pollMs?: number): Promise<LeaseRecord>;
    private sleep;
    private wake;
    renew(name: string, holder: string): LeaseRecord | undefined;
    release(name: string, holder: string): boolean;
    holder(name: string): LeaseRecord | undefined;
    list(): LeaseRecord[];
    queued(name: string): number;
    releaseAll(): void;
    private startHeartbeat;
}
