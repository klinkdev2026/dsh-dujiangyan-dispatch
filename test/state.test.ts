import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ApprovalQueue, summarizeArgs } from '../src/approvals.ts'
import { EventLog } from '../src/events.ts'
import { LeaseManager } from '../src/locks.ts'
import { readJsonl, writeJsonAtomic, readJson } from '../src/store.ts'

const tmp = () => mkdtempSync(path.join(tmpdir(), 'djy-'))

test('approval: first decision wins, later ones are refused', async () => {
  const events = new EventLog(undefined)
  const audit: unknown[] = []
  const q = new ApprovalQueue(events, r => audit.push(r))
  const pending = q.request({ sessionId: 's', tool: 'pwsh', summary: '{}', rule: 'unknown-command', reason: 'x', cwd: '/', origin: 'pre-execute' }, 60_000)
  const [item] = q.list()
  assert.ok(item)
  assert.equal(q.decide(item.id, 'allow', 'looks fine', 'claude'), true)
  assert.equal(q.decide(item.id, 'deny', 'too late', 'codex'), false)
  assert.deepEqual(await pending, { kind: 'allow', reason: 'looks fine', decider: 'claude' })
  assert.equal(q.list().length, 0)
  assert.equal(audit.length, 2)
  assert.deepEqual(events.since(0).events.map(e => e.type), ['approval/pending', 'approval/settled'])
})

test('approval: timeout and abort', async () => {
  const q = new ApprovalQueue(new EventLog(undefined), () => {})
  const base = { sessionId: 's', tool: 't', summary: '', rule: 'r', reason: '', cwd: '/', origin: 'pre-execute' as const }
  // The approval timer is unref'd so a pending approval never keeps the host alive;
  // hold the loop open here, or Node 22's runner ends the file before the timeout fires.
  const keepAlive = setInterval(() => {}, 1000)
  try {
    assert.deepEqual(await q.request(base, 10), { kind: 'timeout' })
  } finally {
    clearInterval(keepAlive)
  }
  const ctrl = new AbortController()
  const p = q.request(base, 60_000, ctrl.signal)
  ctrl.abort()
  assert.deepEqual(await p, { kind: 'cancelled' })
})

test('summarizeArgs masks secrets and bounds content', () => {
  const s = summarizeArgs({ command: 'ls', api_key: 'sk-123', content: 'x'.repeat(500) })
  assert.ok(!s.includes('sk-123'))
  assert.ok(s.includes('(500 chars)'))
})

test('event log: cursors and long-poll wakeups', async () => {
  const log = new EventLog(undefined, 3)
  const waiting = log.wait(0, 5000)
  log.append('a', {})
  const first = await waiting
  assert.equal(first.events.length, 1)
  log.append('b', {})
  log.append('c', {})
  log.append('d', {})
  const r = log.since(1)
  assert.deepEqual(r.events.map(e => e.type), ['b', 'c', 'd'])
  assert.equal(r.cursor, 4)
  assert.equal((await log.wait(4, 10)).events.length, 0)
})

test('leases: exclusive, re-entrant, stale takeover, epoch increments', async () => {
  const dir = tmp()
  try {
    let alive = true
    const a = new LeaseManager(dir, 60_000, Date.now, () => alive)
    const r1 = a.tryAcquire('bench', 'task-1')
    assert.equal(r1?.epoch, 1)
    assert.equal(a.tryAcquire('bench', 'task-2'), undefined)
    assert.ok(a.tryAcquire('bench', 'task-1'), 're-entrant for the same holder')
    assert.equal(a.holder('bench')?.holder, 'task-1')

    // Holder process gone → takeover.
    const foreign = { ...r1, pid: 999_999, holder: 'other-process' }
    writeFileSync(path.join(dir, 'bench.lock'), JSON.stringify(foreign))
    alive = false
    const r2 = a.tryAcquire('bench', 'task-2')
    assert.equal(r2?.holder, 'task-2')
    assert.equal(r2?.epoch, 2)
    alive = true

    // FIFO waiter is woken by release.
    const waited = a.acquire('bench', 'task-3', undefined, 60_000)
    assert.equal(a.queued('bench'), 1)
    assert.equal(a.release('bench', 'task-2'), true)
    assert.equal((await waited).holder, 'task-3')
    a.releaseAll()
    assert.equal(a.list().length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('store: atomic JSON and torn JSONL lines', () => {
  const dir = tmp()
  try {
    const f = path.join(dir, 'a', 'state.json')
    writeJsonAtomic(f, { x: 1 })
    writeJsonAtomic(f, { x: 2 })
    assert.deepEqual(readJson(f, {}), { x: 2 })
    const j = path.join(dir, 'j.jsonl')
    writeFileSync(j, '{"a":1}\n{"a":2}\n{"a":')
    assert.deepEqual(readJsonl(j), [{ a: 1 }, { a: 2 }])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
