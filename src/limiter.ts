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
  readonly maxConcurrent: number
  /** Requests per rolling minute; 0 disables the window. */
  readonly rpm: number
  /** Minimum gap between two request starts. */
  readonly minSpacingMs: number
  /** Uniform random extra gap added to the spacing (0..jitterMs). */
  readonly jitterMs: number
  /** Consecutive successes before the adaptive cap grows by one. */
  readonly increaseAfter: number
  /** Consecutive rate-limit/overload failures that open the circuit. */
  readonly breakerThreshold: number
  /** How long an open circuit rejects traffic before a half-open probe. */
  readonly breakerCooldownMs: number
}

export const DEFAULT_LIMIT: ProviderLimit = {
  maxConcurrent: 4,
  rpm: 60,
  minSpacingMs: 500,
  jitterMs: 500,
  increaseAfter: 20,
  breakerThreshold: 5,
  breakerCooldownMs: 120_000,
}

/** How a leased request ended. Only rate limits and overloads move the cap and the breaker. */
export type Outcome = 'ok' | 'rate_limited' | 'overloaded' | 'error' | 'cancelled'

/** 0 interactive/approval, 1 normal task work, 2 background. */
export type Priority = 0 | 1 | 2

export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  random(): number
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms)
    t.unref?.()
    return t
  },
  clearTimeout: h => clearTimeout(h as ReturnType<typeof setTimeout>),
  random: () => Math.random(),
}

export interface Lease {
  readonly provider: string
  /** Return the lease; idempotent. `retryAfterMs` is the provider-requested delay, when known. */
  release(outcome: Outcome, retryAfterMs?: number): void
}

export interface ProviderSnapshot {
  readonly cap: number
  readonly maxConcurrent: number
  readonly inFlight: number
  readonly queued: number
  readonly circuit: 'closed' | 'open' | 'half-open'
  readonly openForMs: number
  readonly counts: Readonly<Record<Outcome, number>>
}

interface Waiter {
  readonly priority: Priority
  readonly seq: number
  readonly resolve: (lease: Lease) => void
  readonly reject: (err: unknown) => void
  readonly onAbort?: () => void
  readonly signal?: AbortSignal
}

class ProviderState {
  cap: number
  limit: ProviderLimit
  inFlight = 0
  readonly queue: Waiter[] = []
  readonly starts: number[] = []
  nextStartAt = 0
  successStreak = 0
  failures = 0
  openUntil = 0
  halfOpen = false
  timer: unknown = undefined
  timerAt = 0
  readonly counts: Record<Outcome, number> = { ok: 0, rate_limited: 0, overloaded: 0, error: 0, cancelled: 0 }

  constructor(limit: ProviderLimit) {
    this.limit = limit
    this.cap = Math.max(1, limit.maxConcurrent)
  }
}

export class AdmissionController {
  private readonly states = new Map<string, ProviderState>()
  private seq = 0

  private readonly limitFor: (provider: string) => ProviderLimit
  private readonly clock: Clock

  constructor(limitFor: (provider: string) => ProviderLimit = () => DEFAULT_LIMIT, clock: Clock = realClock) {
    this.limitFor = limitFor
    this.clock = clock
  }

  /** Wait for an admission slot on `provider`. Rejects with the signal's reason when aborted. */
  acquire(provider: string, options: { priority?: Priority; signal?: AbortSignal } = {}): Promise<Lease> {
    const state = this.state(provider)
    const { priority = 1, signal } = options
    if (signal?.aborted === true) return Promise.reject(signal.reason)
    return new Promise<Lease>((resolve, reject) => {
      const waiter: Waiter = {
        priority,
        seq: this.seq++,
        resolve,
        reject,
        ...signal !== undefined
          ? {
              signal,
              onAbort: () => {
                const i = state.queue.indexOf(waiter)
                if (i >= 0) state.queue.splice(i, 1)
                reject(signal.reason)
              },
            }
          : {},
      }
      if (waiter.onAbort !== undefined) signal?.addEventListener('abort', waiter.onAbort, { once: true })
      state.queue.push(waiter)
      state.queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq)
      this.pump(provider, state)
    })
  }

  /**
   * Override a provider's limits at runtime (in memory only; the profile config
   * applies again after a restart). Changing `maxConcurrent` also resets the
   * adaptive cap to the new ceiling.
   */
  setLimit(provider: string, patch: Partial<ProviderLimit>): ProviderLimit {
    const s = this.state(provider)
    const next: ProviderLimit = { ...s.limit, ...patch }
    ;(s as { limit: ProviderLimit }).limit = next
    if (patch.maxConcurrent !== undefined) s.cap = Math.max(1, next.maxConcurrent)
    if (patch.breakerThreshold !== undefined || patch.breakerCooldownMs !== undefined) {
      s.failures = 0
      s.openUntil = 0
      s.halfOpen = false
    }
    this.pump(provider, s)
    return next
  }

  /** True while the provider's circuit is open (callers may route to a fallback). */
  isOpen(provider: string): boolean {
    const state = this.states.get(provider)
    return state !== undefined && state.openUntil > this.clock.now()
  }

  snapshot(): Record<string, ProviderSnapshot> {
    const now = this.clock.now()
    const out: Record<string, ProviderSnapshot> = {}
    for (const [provider, s] of this.states) {
      out[provider] = {
        cap: s.cap,
        maxConcurrent: s.limit.maxConcurrent,
        inFlight: s.inFlight,
        queued: s.queue.length,
        circuit: s.openUntil > now ? 'open' : s.halfOpen ? 'half-open' : 'closed',
        openForMs: Math.max(0, s.openUntil - now),
        counts: { ...s.counts },
      }
    }
    return out
  }

  private state(provider: string): ProviderState {
    let s = this.states.get(provider)
    if (s === undefined) {
      s = new ProviderState(this.limitFor(provider))
      this.states.set(provider, s)
    }
    return s
  }

  private schedule(provider: string, s: ProviderState, at: number): void {
    if (s.timer !== undefined && s.timerAt <= at) return
    if (s.timer !== undefined) this.clock.clearTimeout(s.timer)
    s.timerAt = at
    s.timer = this.clock.setTimeout(() => {
      s.timer = undefined
      this.pump(provider, s)
    }, Math.max(0, at - this.clock.now()))
  }

  private pump(provider: string, s: ProviderState): void {
    while (s.queue.length > 0) {
      const now = this.clock.now()
      if (s.openUntil > now) {
        this.schedule(provider, s, s.openUntil)
        return
      }
      if (s.openUntil !== 0) {
        s.openUntil = 0
        s.halfOpen = true
      }
      const cap = s.halfOpen ? 1 : s.cap
      if (s.inFlight >= cap) return // a release pumps again
      while (s.starts.length > 0 && (s.starts[0] as number) <= now - 60_000) s.starts.shift()
      if (s.limit.rpm > 0 && s.starts.length >= s.limit.rpm) {
        this.schedule(provider, s, (s.starts[0] as number) + 60_000)
        return
      }
      if (now < s.nextStartAt) {
        this.schedule(provider, s, s.nextStartAt)
        return
      }
      const waiter = s.queue.shift() as Waiter
      if (waiter.onAbort !== undefined) waiter.signal?.removeEventListener('abort', waiter.onAbort)
      s.inFlight++
      s.starts.push(now)
      s.nextStartAt = now + s.limit.minSpacingMs + Math.floor(this.clock.random() * s.limit.jitterMs)
      waiter.resolve(this.lease(provider, s))
    }
  }

  private lease(provider: string, s: ProviderState): Lease {
    let released = false
    return {
      provider,
      release: (outcome, retryAfterMs) => {
        if (released) return
        released = true
        s.inFlight = Math.max(0, s.inFlight - 1)
        s.counts[outcome]++
        const now = this.clock.now()
        if (outcome === 'ok') {
          s.failures = 0
          s.halfOpen = false
          if (++s.successStreak >= s.limit.increaseAfter && s.cap < s.limit.maxConcurrent) {
            s.cap++
            s.successStreak = 0
          }
        } else if (outcome === 'rate_limited' || outcome === 'overloaded') {
          s.cap = Math.max(1, Math.floor(s.cap / 2))
          s.successStreak = 0
          s.failures++
          const wait = retryAfterMs !== undefined && retryAfterMs > 0 ? retryAfterMs : 0
          s.nextStartAt = Math.max(s.nextStartAt, now + wait)
          if (s.halfOpen || s.failures >= s.limit.breakerThreshold) {
            s.openUntil = now + Math.max(s.limit.breakerCooldownMs, wait)
            s.halfOpen = false
          }
        }
        this.pump(provider, s)
      },
    }
  }
}

/** Classify a provider failure (Harness `LlmFailure`-like or a thrown error) into an outcome. */
export function outcomeOf(failure: unknown): { outcome: Outcome; retryAfterMs?: number } {
  const f = (failure ?? {}) as { status?: unknown; code?: unknown; providerRetryAfterMs?: unknown; name?: unknown; failure?: unknown }
  if (f.failure !== undefined && typeof f.failure === 'object') return outcomeOf(f.failure)
  const status = typeof f.status === 'number' ? f.status : undefined
  const code = typeof f.code === 'string' ? f.code.toUpperCase() : ''
  const retryAfterMs = typeof f.providerRetryAfterMs === 'number' ? f.providerRetryAfterMs : undefined
  const withRetry = (outcome: Outcome) => retryAfterMs !== undefined ? { outcome, retryAfterMs } : { outcome }
  if (f.name === 'AbortError' || code === 'ABORTED' || code === 'CANCELLED') return { outcome: 'cancelled' }
  if (status === 429 || /RATE|QUOTA|TOO_MANY/.test(code)) return withRetry('rate_limited')
  if ((status !== undefined && status >= 500) || /OVERLOAD|UNAVAILABLE|TIMEOUT|GATEWAY|NETWORK|ECONN|ETIMEDOUT/.test(code)) return withRetry('overloaded')
  return withRetry('error')
}
