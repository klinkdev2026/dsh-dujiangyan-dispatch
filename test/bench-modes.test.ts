import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ApprovalQueue } from '../src/approvals.ts'
import { resolveConfig } from '../src/config.ts'
import { EventLog } from '../src/events.ts'
import { installGate } from '../src/gate.ts'
import { QuietSwitch } from '../src/quiet.ts'
import { FakeAgent, FakeHost } from './fake-host.ts'

// Findings 32/38/41/51: a task-long bench lease kept every other worker's builds waiting while the
// benchmark task wrote its report. `bench` now holds the machine only while a benchmark command runs.

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const ok = { isError: false, value: { exitCode: 0 }, content: [{ type: 'text', text: 'ok' }] }
type Mode = 'command' | 'task' | 'shared' | undefined

function setup(modes: Record<string, Mode>, quiet?: QuietSwitch) {
  const dir = mkdtempSync(path.join(tmpdir(), 'djy-bench-'))
  const ws = path.join(dir, 'ws')
  mkdirSync(ws, { recursive: true })
  const host = new FakeHost()
  const config = resolveConfig({ stateDir: path.join(dir, 'state'), workspaceRoots: [ws], quietMode: { maxWaitMs: 2000 } })
  const events = new EventLog(undefined)
  const approvals = new ApprovalQueue(events, () => {})
  // A one-holder lease, like the file lease.
  let holder: string | undefined
  const lease = {
    acquire: async (h: string, signal: AbortSignal) => {
      while (holder !== undefined && holder !== h) {
        if (signal.aborted) throw new Error('aborted')
        await sleep(2)
      }
      holder = h
    },
    release: (h: string) => { if (holder === h) holder = undefined },
  }
  const registry = { rootOf: (a: { session: { id: string } }) => a.session.id, get: () => ({ cwd: ws }) } as never
  installGate(host.ctx, {
    config, registry, approvals, events, audit: () => {},
    heldResources: () => [], runningTask: root => `task-${root}`,
    benchMode: root => modes[root],
    benchLease: lease,
    benchHolder: () => holder,
    quietPollMs: 2,
    ...quiet !== undefined ? { quietOverride: () => quiet.current()?.enabled } : {},
  })
  const agent = (id: string) => new FakeAgent(host, id, ws, undefined, {})
  const types = () => events.since(0, 1000).events.map(e => e.type)
  return { host, agent, holder: () => holder, types }
}

test('bench (command mode): the lease is held only while the benchmark command runs', async () => {
  const s = setup({ A: 'command', B: undefined })
  const a = s.agent('A')
  const b = s.agent('B')
  // Before the benchmark: nobody holds the machine, B builds freely.
  assert.equal((await s.host.preExecute(b, 'pwsh', { command: 'cargo build --release' }, undefined, ok)).kind, 'allow')
  assert.equal(s.holder(), undefined)
  // The benchmark starts: A holds the machine until its result arrives.
  const run = { callId: 'bench-1', name: 'pwsh', arguments: { command: 'cargo bench' }, agent: a, signal: new AbortController().signal }
  const decision = await s.host.waterfall('tools/pre-execute', [run], async () => ({ kind: 'allow' as const }))
  assert.equal(decision.kind, 'allow')
  assert.equal(s.holder(), 'task-A')
  // B's heavy command waits while the measurement runs …
  let bDone = false
  const bBuild = s.host.preExecute(b, 'pwsh', { command: 'cargo test --offline' }, undefined, ok).then(d => { bDone = true; return d })
  await sleep(30)
  assert.equal(bDone, false, 'held while the benchmark runs')
  // … and continues the moment the benchmark's result comes in.
  s.host.emit('tools/result', run, ok)
  assert.equal(s.holder(), undefined)
  assert.equal((await bBuild).kind, 'allow')
  // A's own report writing afterwards holds nobody.
  assert.equal((await s.host.preExecute(a, 'pwsh', { command: 'Get-Content results/raw/x.json' }, undefined, ok)).kind, 'allow')
  assert.ok(s.types().includes('bench/acquired') && s.types().includes('bench/released'))
})

test('bench (command mode): parallel benchmarks of one task keep the machine until the last ends (review F1)', async () => {
  const s = setup({ A: 'command', B: undefined })
  const a = s.agent('A')
  const run = (id: string) => ({ callId: id, name: 'pwsh', arguments: { command: 'cargo bench' }, agent: a, signal: new AbortController().signal })
  const one = run('bench-1')
  const two = run('bench-2')
  for (const r of [one, two]) assert.equal((await s.host.waterfall('tools/pre-execute', [r], async () => ({ kind: 'allow' as const }))).kind, 'allow')
  s.host.emit('tools/result', one, ok)
  assert.equal(s.holder(), 'task-A', 'the second benchmark still runs')
  s.host.emit('tools/result', two, ok)
  assert.equal(s.holder(), undefined)
})

test('bench (command mode): a benchmark waits for heavy commands of other sessions already running', async () => {
  const s = setup({ A: 'command', B: undefined })
  const a = s.agent('A')
  const b = s.agent('B')
  const build = { callId: 'build-1', name: 'pwsh', arguments: { command: 'cargo build --release' }, agent: b, signal: new AbortController().signal }
  assert.equal((await s.host.waterfall('tools/pre-execute', [build], async () => ({ kind: 'allow' as const }))).kind, 'allow')
  let started = false
  const bench = s.host.preExecute(a, 'pwsh', { command: 'cargo bench' }).then(d => { started = true; return d })
  await sleep(30)
  assert.equal(started, false, 'the benchmark waits for the running build')
  s.host.emit('tools/result', build, ok)
  assert.equal((await bench).kind, 'allow')
})

test('bench:shared runs benchmarks without holding anyone; no bench rights means no benchmark', async () => {
  const s = setup({ A: 'shared', B: undefined, C: undefined })
  assert.equal((await s.host.preExecute(s.agent('A'), 'pwsh', { command: 'cargo bench' }, undefined, ok)).kind, 'allow')
  assert.equal(s.holder(), undefined)
  assert.equal((await s.host.preExecute(s.agent('C'), 'pwsh', { command: 'cargo bench' })).kind, 'deny')
})

test('djy_quiet_set switch: off lets heavy commands run during a benchmark; it expires on its own', async () => {
  let clock = Date.parse('2026-10-21T10:00:00Z')
  const quiet = new QuietSwitch(() => clock)
  const s = setup({ A: 'command', B: undefined }, quiet)
  const run = { callId: 'bench-2', name: 'pwsh', arguments: { command: 'cargo bench' }, agent: s.agent('A'), signal: new AbortController().signal }
  await s.host.waterfall('tools/pre-execute', [run], async () => ({ kind: 'allow' as const }))
  assert.equal(s.holder(), 'task-A')
  quiet.set(false, 30, 'long non-exclusive soak run', 'claude')
  assert.equal((await s.host.preExecute(s.agent('B'), 'pwsh', { command: 'cargo build' }, undefined, ok)).kind, 'allow')
  clock += 31 * 60_000
  assert.equal(quiet.current(), undefined, 'expired')
  s.host.emit('tools/result', run, ok)
})
