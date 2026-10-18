export interface DjyEvent {
    readonly seq: number;
    readonly at: string;
    readonly type: string;
    readonly data: Readonly<Record<string, unknown>>;
}
export declare class EventLog {
    private readonly events;
    private nextSeq;
    private readonly waiters;
    private readonly journal;
    private readonly capacity;
    private readonly now;
    constructor(journal: string | undefined, capacity?: number, now?: () => Date);
    append(type: string, data: Record<string, unknown>): DjyEvent;
    /** Events with `seq > cursor`, oldest first. `truncated` means the cursor fell out of the window. */
    since(cursor: number, limit?: number): {
        events: DjyEvent[];
        cursor: number;
        truncated: boolean;
    };
    /** Resolve as soon as an event newer than `cursor` exists, or after `waitMs`. */
    wait(cursor: number, waitMs: number, signal?: AbortSignal, limit?: number): Promise<ReturnType<EventLog['since']>>;
}
