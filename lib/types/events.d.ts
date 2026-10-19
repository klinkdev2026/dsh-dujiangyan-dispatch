export interface DjyEvent {
    readonly seq: number;
    readonly at: string;
    readonly type: string;
    readonly data: Readonly<Record<string, unknown>>;
}
export interface EventPage {
    readonly events: DjyEvent[];
    readonly cursor: number;
    /** The cursor fell out of the retained window; older events were dropped. */
    readonly truncated: boolean;
    /** Identifies this plugin start; pass it back with the cursor. */
    readonly epoch: string;
    /** The cursor belonged to an earlier start: the events are from the beginning of this one. */
    readonly reset: boolean;
}
export declare class EventLog {
    readonly epoch: string;
    private readonly events;
    private nextSeq;
    private readonly waiters;
    private readonly journal;
    private readonly capacity;
    private readonly now;
    constructor(journal: string | undefined, capacity?: number, now?: () => Date);
    append(type: string, data: Record<string, unknown>): DjyEvent;
    /** Whether a client's cursor/epoch belongs to an earlier start of the plugin. */
    private stale;
    /** Events with `seq > cursor`, oldest first. */
    since(cursor: number, limit?: number, epoch?: string): EventPage;
    /** Resolve as soon as an event newer than `cursor` exists (or the cursor is stale), or after `waitMs`. */
    wait(cursor: number, waitMs: number, signal?: AbortSignal, limit?: number, epoch?: string): Promise<EventPage>;
}
