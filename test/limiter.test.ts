import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AdmissionController, outcomeOf, type Clock, type Lease, type ProviderLimit } from '../src/limiter.ts'

/** Deterministic clock: timers fire only when `advance` passes them. */
function fakeClock(randomValue = 0): Clock & { advance(ms: number): Promise<void>; t: number } {
  const timers: Array<{ at: number; fn: () => void; id: number }> = []
  let id = 0
  const clock = {
    t: 0,
    now: () => clock.t,
    setTimeout: (fn: () => void, ms: number) => {
      timers.push({ at: clock.t + ms, fn, id: ++id })
      return id
    },
    clearTimeout: (h: unknown) => {
      const i = timers.findIndex(x => x.id === h)
      if (i >= 0) timers.splice(i, 1)
    },
    random: () => randomValue,
    async advance(ms: number) {
      const end = clock.t + ms
      for (;;) {
        timers.sort((a, b) => a.at - b.at)
        const next = timers[0]
        if (next === undefined || next.at > end) break
        timers.shift()
        clock.t = next.at
        next.fn()
        await Promise.resolve()
      }
      clock.t = end
      await Promise.resolve()
    },
  }
  return clock
}

const limit = (over: Partial<ProviderLimit> = {}): ProviderLimit => ({
  maxConcurrent: 2, rpm: 0, minSpacingMs: 1000, jitterMs: 0, increaseAfter: 3, breakerThreshold: 3, breakerCooldownMs: 10_000, ...over,
})

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

test('starts are staggered by minSpacing and capped by concurrency', async () => {
  const clock = fakeClock()
  const ac = new AdmissionController(() => limit(), clock)
  const got: Array<{ at: number; lease: Lease }> = []
  for (let i = 0; i < 3; i++) void ac.acquire('ds').then(lease => got.push({ at: clock.now(), lease }))
  await settle()
  assert.deepEqual(got.map(g => g.at), [0])
  await clock.advance(1000)
  await settle()
  assert.deepEqual(got.map(g => g.at), [0, 1000])
  await clock.advance(5000)
  await settle()
  assert.equal(got.length, 2, 'cap 2 blocks the third')
  got[0]?.lease.release('ok')
  await settle()
  assert.equal(got.length, 3)
})

test('429 halves the cap, honors Retry-After, and opens the breaker', async () => {
  const clock = fakeClock()
  const ac = new AdmissionController(() => limit({ maxConcurrent: 4, minSpacingMs: 0 }), clock)
  const leases: Lease[] = []
  for (let i = 0; i < 4; i++) leases.push(await ac.acquire('ds'))
  leases[0]?.release('rate_limited', 5000)
  assert.equal(ac.snapshot()['ds']?.cap, 2)
  leases[1]?.release('rate_limited')
  leases[2]?.release('overloaded')
  const snap = ac.snapshot()['ds']
  assert.equal(snap?.cap, 1)
  assert.equal(snap?.circuit, 'open')
  assert.equal(ac.isOpen('ds'), true)
  leases[3]?.release('ok')

  let probe: Lease | undefined
  void ac.acquire('ds').then(l => { probe = l })
  await clock.advance(9_000)
  await settle()
  assert.equal(probe, undefined, 'still open')
  await clock.advance(1_000)
  await settle()
  assert.ok(probe, 'half-open probe admitted')
  assert.equal(ac.snapshot()['ds']?.circuit, 'half-open')
  probe?.release('ok')
  assert.equal(ac.snapshot()['ds']?.circuit, 'closed')
})

test('successes grow the cap back to the ceiling', async () => {
  const clock = fakeClock()
  const ac = new AdmissionController(() => limit({ maxConcurrent: 2, minSpacingMs: 0, increaseAfter: 2 }), clock)
  ;(await ac.acquire('p')).release('rate_limited')
  assert.equal(ac.snapshot()['p']?.cap, 1)
  ;(await ac.acquire('p')).release('ok')
  ;(await ac.acquire('p')).release('ok')
  assert.equal(ac.snapshot()['p']?.cap, 2)
})

test('rpm window delays the next start', async () => {
  const clock = fakeClock()
  const ac = new AdmissionController(() => limit({ rpm: 2, minSpacingMs: 0, maxConcurrent: 10 }), clock)
  ;(await ac.acquire('p')).release('ok')
  ;(await ac.acquire('p')).release('ok')
  let third = false
  void ac.acquire('p').then(() => { third = true })
  await clock.advance(59_000)
  await settle()
  assert.equal(third, false)
  await clock.advance(1_000)
  await settle()
  assert.equal(third, true)
})

test('priority 0 jumps the queue; abort removes a waiter', async () => {
  const clock = fakeClock()
  const ac = new AdmissionController(() => limit({ maxConcurrent: 1, minSpacingMs: 0 }), clock)
  const first = await ac.acquire('p')
  const order: string[] = []
  void ac.acquire('p', { priority: 2 }).then(l => { order.push('bg'); l.release('ok') })
  const ctrl = new AbortController()
  const aborted = ac.acquire('p', { signal: ctrl.signal }).then(() => 'granted', () => 'aborted')
  void ac.acquire('p', { priority: 0 }).then(l => { order.push('urgent'); l.release('ok') })
  ctrl.abort(new Error('stop'))
  assert.equal(await aborted, 'aborted')
  first.release('ok')
  await settle()
  await settle()
  assert.deepEqual(order, ['urgent', 'bg'])
})

test('jitter spreads starts', async () => {
  const clock = fakeClock(0.5)
  const ac = new AdmissionController(() => limit({ maxConcurrent: 5, minSpacingMs: 1000, jitterMs: 2000 }), clock)
  const at: number[] = []
  for (let i = 0; i < 3; i++) void ac.acquire('p').then(() => at.push(clock.now()))
  await settle()
  await clock.advance(10_000)
  await settle()
  assert.deepEqual(at, [0, 2000, 4000])
})

test('setLimit raises the ceiling at runtime and admits queued requests', async () => {
  const clock = fakeClock()
  const ac = new AdmissionController(() => limit({ maxConcurrent: 1, minSpacingMs: 0 }), clock)
  await ac.acquire('p')
  let second = false
  void ac.acquire('p').then(() => { second = true })
  await settle()
  assert.equal(second, false)
  ac.setLimit('p', { maxConcurrent: 5 })
  await settle()
  assert.equal(second, true)
  assert.equal(ac.snapshot()['p']?.cap, 5)
})

test('outcomeOf maps provider failures', () => {
  assert.deepEqual(outcomeOf({ status: 429, providerRetryAfterMs: 3000 }), { outcome: 'rate_limited', retryAfterMs: 3000 })
  assert.equal(outcomeOf({ code: 'QUOTA_EXCEEDED' }).outcome, 'rate_limited')
  assert.equal(outcomeOf({ status: 503 }).outcome, 'overloaded')
  assert.equal(outcomeOf({ failure: { status: 529 } }).outcome, 'overloaded')
  assert.equal(outcomeOf({ status: 400, code: 'INVALID_REQUEST' }).outcome, 'error')
  assert.equal(outcomeOf({ name: 'AbortError' }).outcome, 'cancelled')
})
