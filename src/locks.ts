/**
 * Named exclusive leases (e.g. `bench`) shared by every process on the host.
 *
 * A lease is a file `<dir>/<name>.lock` created with `wx`, holding
 * `{holder, pid, epoch, expiresAt}`. The holder renews it on a heartbeat. A
 * lease whose expiry passed, or whose process no longer exists, may be taken
 * over; the epoch increases on every takeover so a stale holder can detect it
 * lost the lease. Liveness uses `process.kill(pid, 0)`, which works on
 * Windows, macOS and Linux without /proc, ps or lsof.
 */
import { openSync, closeSync, writeSync, readFileSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { ensureDir, writeJsonAtomic } from './store.ts'
import { safeKey } from './paths.ts'

export interface LeaseRecord {
  readonly name: string
  readonly holder: string
  readonly pid: number
  readonly epoch: number
  readonly acquiredAt: string
  readonly expiresAt: number
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM' // exists, owned by someone else
  }
}

export class LeaseManager {
  private readonly heartbeats = new Map<string, ReturnType<typeof setInterval>>()
  private readonly queues = new Map<string, object[]>()
  private readonly wakers = new Map<string, Set<() => void>>()
  /** Called when a held lease could not be renewed; `now` is whoever holds it at that moment. */
  onLost?: (name: string, holder: string, now: LeaseRecord | undefined) => void

  private readonly dir: string
  private readonly ttlMs: number
  private readonly now: () => number
  private readonly isAlive: (pid: number) => boolean

  constructor(dir: string, ttlMs = 60_000, now: () => number = () => Date.now(), isAlive: (pid: number) => boolean = pidAlive) {
    this.dir = dir
    this.ttlMs = ttlMs
    this.now = now
    this.isAlive = isAlive
    ensureDir(dir)
  }

  private file(name: string): string {
    return path.join(this.dir, `${safeKey(name)}.lock`)
  }

  read(name: string): LeaseRecord | undefined {
    try {
      return JSON.parse(readFileSync(this.file(name), 'utf8')) as LeaseRecord
    } catch {
      return undefined
    }
  }

  private stale(rec: LeaseRecord): boolean {
    return rec.expiresAt <= this.now() || !this.isAlive(rec.pid)
  }

  /** Try once to take `name` for `holder`. Re-entrant for the same holder. */
  tryAcquire(name: string, holder: string): LeaseRecord | undefined {
    const file = this.file(name)
    const current = this.read(name)
    if (current !== undefined) {
      if (current.holder === holder && current.pid === process.pid) return this.renew(name, holder)
      if (!this.stale(current)) return undefined
      rmSync(file, { force: true })
    } else if (existsSync(file)) {
      // Unreadable lock file: another process may be between `open(wx)` and `write`.
      // Treat it as stale only once it is old enough not to be mid-write.
      let age = 0
      try {
        age = this.now() - statSync(file).mtimeMs
      } catch {
        // Vanished meanwhile; fall through to the create race.
      }
      if (age < 2000) return undefined
      rmSync(file, { force: true })
    }
    const rec: LeaseRecord = {
      name,
      holder,
      pid: process.pid,
      epoch: (current?.epoch ?? 0) + 1,
      acquiredAt: new Date(this.now()).toISOString(),
      expiresAt: this.now() + this.ttlMs,
    }
    let fd: number
    try {
      fd = openSync(file, 'wx')
    } catch {
      return undefined // someone else won the race
    }
    try {
      writeSync(fd, JSON.stringify(rec))
    } finally {
      closeSync(fd)
    }
    this.startHeartbeat(name, holder)
    return rec
  }

  /** Wait (FIFO within this process, polling across processes) until `name` is held by `holder`. */
  async acquire(name: string, holder: string, signal?: AbortSignal, pollMs = 1000): Promise<LeaseRecord> {
    const ticket = {}
    const queue = this.queues.get(name) ?? []
    this.queues.set(name, queue)
    queue.push(ticket)
    try {
      for (;;) {
        if (signal?.aborted === true) throw signal.reason
        if (queue[0] === ticket) {
          const rec = this.tryAcquire(name, holder)
          if (rec !== undefined) return rec
        }
        await this.sleep(name, pollMs, signal)
      }
    } finally {
      const i = queue.indexOf(ticket)
      if (i >= 0) queue.splice(i, 1)
      this.wake(name)
    }
  }

  private sleep(name: string, ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>(resolve => {
      const done = () => {
        clearTimeout(timer)
        this.wakers.get(name)?.delete(done)
        signal?.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      timer.unref?.()
      if (!this.wakers.has(name)) this.wakers.set(name, new Set())
      this.wakers.get(name)?.add(done)
      signal?.addEventListener('abort', done, { once: true })
    })
  }

  private wake(name: string): void {
    for (const done of [...this.wakers.get(name) ?? []]) done()
  }

  renew(name: string, holder: string): LeaseRecord | undefined {
    const current = this.read(name)
    if (current === undefined || current.holder !== holder || current.pid !== process.pid) return undefined
    const rec = { ...current, expiresAt: this.now() + this.ttlMs }
    writeJsonAtomic(this.file(name), rec)
    return rec
  }

  release(name: string, holder: string): boolean {
    const hb = this.heartbeats.get(`${name}\0${holder}`)
    if (hb !== undefined) clearInterval(hb)
    this.heartbeats.delete(`${name}\0${holder}`)
    const current = this.read(name)
    if (current === undefined || current.holder !== holder || current.pid !== process.pid) return false
    rmSync(this.file(name), { force: true })
    this.wake(name)
    return true
  }

  holder(name: string): LeaseRecord | undefined {
    const rec = this.read(name)
    return rec !== undefined && !this.stale(rec) ? rec : undefined
  }

  list(): LeaseRecord[] {
    const out: LeaseRecord[] = []
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.lock')) continue
      const rec = this.holder(f.slice(0, -5))
      if (rec !== undefined) out.push(rec)
    }
    return out
  }

  queued(name: string): number {
    return this.queues.get(name)?.length ?? 0
  }

  releaseAll(): void {
    for (const key of [...this.heartbeats.keys()]) {
      const [name, holder] = key.split('\0') as [string, string]
      this.release(name, holder)
    }
  }

  private startHeartbeat(name: string, holder: string): void {
    const key = `${name}\0${holder}`
    if (this.heartbeats.has(key)) return
    const hb = setInterval(() => {
      if (this.renew(name, holder) === undefined) {
        clearInterval(hb)
        this.heartbeats.delete(key)
        // Taken over (our renewals stalled past the TTL) or removed: say so instead of failing silently.
        this.onLost?.(name, holder, this.read(name))
      }
    }, Math.max(1000, Math.floor(this.ttlMs / 3)))
    hb.unref?.()
    this.heartbeats.set(key, hb)
  }
}
