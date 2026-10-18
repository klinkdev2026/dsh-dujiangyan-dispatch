/**
 * Ordered event log with cursors, so an MCP client can long-poll
 * `events_watch(cursor)` instead of re-reading task state.
 */
import { appendJsonl } from "./store.js";
export class EventLog {
    events = [];
    nextSeq = 1;
    waiters = new Set();
    journal;
    capacity;
    now;
    constructor(journal, capacity = 5000, now = () => new Date()) {
        this.journal = journal;
        this.capacity = capacity;
        this.now = now;
    }
    append(type, data) {
        const event = { seq: this.nextSeq++, at: this.now().toISOString(), type, data };
        this.events.push(event);
        if (this.events.length > this.capacity)
            this.events.splice(0, this.events.length - this.capacity);
        if (this.journal !== undefined) {
            try {
                appendJsonl(this.journal, event);
            }
            catch {
                // The journal is best-effort; the in-memory log stays authoritative for watchers.
            }
        }
        for (const wake of [...this.waiters])
            wake();
        return event;
    }
    /** Events with `seq > cursor`, oldest first. `truncated` means the cursor fell out of the window. */
    since(cursor, limit = 200) {
        const first = this.events[0]?.seq ?? this.nextSeq;
        const truncated = cursor + 1 < first && cursor !== 0;
        const events = this.events.filter(e => e.seq > cursor).slice(0, limit);
        return { events, cursor: events.at(-1)?.seq ?? Math.max(cursor, this.nextSeq - 1), truncated };
    }
    /** Resolve as soon as an event newer than `cursor` exists, or after `waitMs`. */
    async wait(cursor, waitMs, signal, limit = 200) {
        const ready = this.since(cursor, limit);
        if (ready.events.length > 0 || waitMs <= 0)
            return ready;
        await new Promise(resolve => {
            const done = () => {
                clearTimeout(timer);
                this.waiters.delete(done);
                signal?.removeEventListener('abort', done);
                resolve();
            };
            const timer = setTimeout(done, waitMs);
            this.waiters.add(done);
            signal?.addEventListener('abort', done, { once: true });
        });
        return this.since(cursor, limit);
    }
}
