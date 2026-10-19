/**
 * Ordered event log with cursors, so an MCP client can long-poll
 * `events_watch(cursor)` instead of re-reading task state.
 *
 * Sequence numbers restart with every plugin start, so each log carries an
 * `epoch` (one per start). A cursor from an earlier epoch — or one beyond the
 * newest event, which can only come from an earlier start — is answered with
 * `reset: true` and the events from the beginning, instead of waiting forever.
 */
import { randomUUID } from 'node:crypto'
import { appendJsonl } from './store.ts'

export interface DjyEvent {
  readonly seq: number
  readonly at: string
  readonly type: string
  readonly data: Readonly<Record<string, unknown>>
}

export interface EventPage {
  readonly events: DjyEvent[]
  readonly cursor: number
  /** The cursor fell out of the retained window; older events were dropped. */
  readonly truncated: boolean
  /** Identifies this plugin start; pass it back with the cursor. */
  readonly epoch: string
  /** The cursor belonged to an earlier start: the events are from the beginning of this one. */
  readonly reset: boolean
}

export class EventLog {
  readonly epoch = randomUUID().slice(0, 8)
  private readonly events: DjyEvent[] = []
  private nextSeq = 1
  private readonly waiters = new Set<() => void>()

  private readonly journal: string | undefined
  private readonly capacity: number
  private readonly now: () => Date

  constructor(journal: string | undefined, capacity = 5000, now: () => Date = () => new Date()) {
    this.journal = journal
    this.capacity = capacity
    this.now = now
  }

  append(type: string, data: Record<string, unknown>): DjyEvent {
    const event: DjyEvent = { seq: this.nextSeq++, at: this.now().toISOString(), type, data }
    this.events.push(event)
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity)
    if (this.journal !== undefined) {
      try {
        appendJsonl(this.journal, { ...event, epoch: this.epoch })
      } catch {
        // The journal is best-effort; the in-memory log stays authoritative for watchers.
      }
    }
    for (const wake of [...this.waiters]) wake()
    return event
  }

  /** Whether a client's cursor/epoch belongs to an earlier start of the plugin. */
  private stale(cursor: number, epoch: string | undefined): boolean {
    return (epoch !== undefined && epoch !== this.epoch) || cursor > this.nextSeq - 1
  }

  /** Events with `seq > cursor`, oldest first. */
  since(cursor: number, limit = 200, epoch?: string): EventPage {
    const reset = this.stale(cursor, epoch)
    const from = reset ? 0 : cursor
    const first = this.events[0]?.seq ?? this.nextSeq
    const truncated = from + 1 < first && from !== 0
    const events = this.events.filter(e => e.seq > from).slice(0, limit)
    return { events, cursor: events.at(-1)?.seq ?? Math.max(from, this.nextSeq - 1), truncated, epoch: this.epoch, reset }
  }

  /** Resolve as soon as an event newer than `cursor` exists (or the cursor is stale), or after `waitMs`. */
  async wait(cursor: number, waitMs: number, signal?: AbortSignal, limit = 200, epoch?: string): Promise<EventPage> {
    const ready = this.since(cursor, limit, epoch)
    // An already-aborted signal never fires 'abort' again: return now instead of sleeping the full wait.
    if (ready.events.length > 0 || ready.reset || waitMs <= 0 || signal?.aborted === true) return ready
    await new Promise<void>(resolve => {
      const done = () => {
        clearTimeout(timer)
        this.waiters.delete(done)
        signal?.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, waitMs)
      this.waiters.add(done)
      signal?.addEventListener('abort', done, { once: true })
    })
    return this.since(cursor, limit, epoch)
  }
}
