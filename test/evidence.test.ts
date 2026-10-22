import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ApprovalQueue } from '../src/approvals.ts'
import { resolveConfig } from '../src/config.ts'
import { EventLog } from '../src/events.ts'
import { checkKind, EvidenceRecorder, MAX_COMMANDS, outcomeOf } from '../src/evidence.ts'
import { installGate } from '../src/gate.ts'
import { FakeAgent, FakeHost } from './fake-host.ts'

const ok = (text = 'ok') => ({ isError: false, value: { exitCode: 0 }, content: [{ type: 'text', text }] })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

test('checks are recognized from the command: test before lint before build', () => {
  assert.equal(checkKind('cargo test --offline --release -p my_app'), 'test')
  assert.equal(checkKind('cd x; cargo build --offline --release 2>&1 | Select-String error; cargo test --lib'), 'test')
  assert.equal(checkKind('cargo clippy --offline -- -D warnings'), 'lint')
  assert.equal(checkKind('cargo build --release'), 'build')
  assert.equal(checkKind('npm test'), 'test')
  assert.equal(checkKind('node --experimental-strip-types --test test/a.test.ts'), 'test')
  assert.equal(checkKind('python -m pytest -q'), 'test')
  assert.equal(checkKind('Get-ChildItem results'), undefined)
})

test('outcome: exit code from the value, else the rendered marker; errors and time-outs fail', () => {
  assert.deepEqual(outcomeOf(ok()), { ok: true, exitCode: 0, text: 'ok' })
  assert.equal(outcomeOf({ isError: false, value: { exitCode: 101 }, content: [] }).ok, false)
  assert.equal(outcomeOf({ isError: false, content: [{ type: 'text', text: 'boom\n[exit code: 3]' }] }).exitCode, 3)
  assert.equal(outcomeOf({ isError: false, value: { exitCode: null, timedOut: true }, content: [] }).ok, false)
  assert.equal(outcomeOf({ isError: true, error: { message: 'x' }, content: [] }).ok, false)
  assert.equal(outcomeOf(undefined).ok, true)
})

test('recorder: commands, checks with the runner summary, bounds, and take()', () => {
  let clock = 1_000
  const r = new EvidenceRecorder(() => clock)
  const exec = { callId: 'c1' }
  r.started(exec, 't1', 'pwsh', { command: 'cargo test --offline 2>&1 | Select-String "test result"', token: 'x' }, 'shell:cargo')
  clock += 2500
  r.finished(exec, ok('running 12 tests\ntest result: ok. 12 passed; 0 failed; 0 ignored'))
  // A piped test run exits 0 even when tests fail: the runner summary decides.
  const piped = { callId: 'c2' }
  r.started(piped, 't1', 'pwsh', { command: 'cargo test 2>&1 | Out-String' }, 'shell:cargo')
  r.finished(piped, ok('test result: FAILED. 11 passed; 1 failed'))
  r.denied('t1')
  const ev = r.get('t1')
  assert.deepEqual(ev?.calls, { allowed: 2, approved: 0, denied: 1 })
  assert.equal(ev?.commands[0]?.ms, 2500)
  assert.equal(ev?.commands[0]?.exitCode, 0)
  assert.deepEqual(ev?.checks.map(c => [c.kind, c.ok]), [['test', true], ['test', false]])
  assert.match(ev?.checks[0]?.summary ?? '', /12 passed; 0 failed/)
  // A result for an execution the gate never let through is ignored.
  r.finished({ callId: 'other' }, ok())
  // The host may hand a copy of the execution: the call id still matches.
  r.started({ callId: 'c3' }, 't1', 'pwsh', { command: 'cargo build' }, 'shell:cargo', 'orchestrator')
  r.finished({ callId: 'c3' }, { isError: false, value: { exitCode: 101 }, content: [] })
  assert.deepEqual(r.get('t1')?.checks.at(-1), { kind: 'build', cmd: 'cargo build', at: new Date(clock).toISOString(), ok: false, exitCode: 101 })
  assert.equal(r.get('t1')?.calls.approved, 1)

  for (let i = 0; i < MAX_COMMANDS + 5; i++) r.started({ callId: `n${i}` }, 't2', 'read', { file_path: `f${i}` }, 'read:read')
  assert.equal(r.get('t2')?.commands.length, MAX_COMMANDS)
  assert.equal(r.get('t2')?.truncated, true)
  assert.ok(r.take('t2') !== undefined)
  assert.equal(r.get('t2'), undefined)
})

test('secrets in recorded commands are masked', () => {
  const r = new EvidenceRecorder()
  r.started({}, 't', 'pwsh', { command: 'curl -H "Authorization: Bearer sk-abcdefghijklmnop1234" https://x' }, 'network-read', 'human')
  assert.doesNotMatch(r.get('t')?.commands[0]?.cmd ?? '', /abcdefghijklmnop1234/)
})

test('through the gate: allowed and approved calls are recorded with their results, refused ones counted', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'djy-ev-'))
  const ws = path.join(dir, 'ws')
  mkdirSync(ws, { recursive: true })
  const host = new FakeHost()
  const config = resolveConfig({ stateDir: path.join(dir, 'state'), workspaceRoots: [ws], approvalTimeoutMs: 2000 })
  const events = new EventLog(undefined)
  const approvals = new ApprovalQueue(events, () => {})
  const evidence = new EvidenceRecorder()
  const registry = { rootOf: () => 'root', get: () => ({ cwd: ws }) } as never
  installGate(host.ctx, { config, registry, approvals, events, audit: () => {}, heldResources: () => [], runningTask: () => 't1', evidence })
  const agent = new FakeAgent(host, 'root', ws, undefined, {})
  const keepAlive = setInterval(() => {}, 1000)
  t.after(() => clearInterval(keepAlive))

  assert.equal((await host.preExecute(agent, 'pwsh', { command: 'cargo test --offline' }, undefined, ok('test result: ok. 3 passed; 0 failed'))).kind, 'allow')
  assert.equal((await host.preExecute(agent, 'pwsh', { command: 'Remove-Item C:/outside -Recurse' }, undefined, ok())).kind, 'deny')
  const held = host.preExecute(agent, 'pwsh', { command: 'git clone https://example.com/x' }, undefined, ok())
  for (let i = 0; i < 50 && approvals.list().length === 0; i++) await sleep(2)
  approvals.decide(approvals.list()[0]?.id ?? '', 'allow', 'public', 'orchestrator')
  assert.equal((await held).kind, 'allow')

  const ev = evidence.get('t1')
  assert.deepEqual(ev?.calls, { allowed: 1, approved: 1, denied: 1 })
  assert.deepEqual(ev?.commands.map(c => [c.cmd, c.ok, c.decider]), [['cargo test --offline', true, undefined], ['git clone https://example.com/x', true, 'orchestrator']])
  assert.match(ev?.checks[0]?.summary ?? '', /3 passed/)
})
