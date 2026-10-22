import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AiApproval, JUDGE_DEGRADED_AFTER, probeJudges } from '../src/ai-approval.ts'
import { ApprovalQueue } from '../src/approvals.ts'
import { resolveConfig, type Config } from '../src/config.ts'
import { EventLog } from '../src/events.ts'
import { installGate } from '../src/gate.ts'
import type { TaskRecord } from '../src/tasks.ts'
import { Watchdog } from '../src/watchdog.ts'
import { FakeAgent, FakeHost } from './fake-host.ts'

const MIN = 60_000
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const types = (events: EventLog) => events.since(0, 1000).events.map(e => e.type)

function setup(extra: Partial<Config> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'djy-wd-'))
  const ws = path.join(dir, 'ws')
  mkdirSync(ws, { recursive: true })
  const config = resolveConfig({
    stateDir: path.join(dir, 'state'), workspaceRoots: [ws], approvalTimeoutMs: 60 * MIN,
    ...extra,
    aiApproval: { judges: [{ provider: 'relay', model: 'judge-a' }, { provider: 'relay', model: 'judge-b' }], ...extra.aiApproval },
  })
  let clock = Date.parse('2026-10-19T10:00:00Z')
  const events = new EventLog(undefined, 5000, () => new Date(clock))
  const audits: Array<Record<string, unknown>> = []
  const approvals = new ApprovalQueue(events, r => audits.push(r), () => clock)
  const aiApproval = new AiApproval(() => config.aiApproval, () => ({ enabled: true }))
  const running: TaskRecord[] = []
  const steered: Array<{ sessionId: string; text: string }> = []
  let lastSeen: number | undefined = clock
  const wd = new Watchdog({
    config, approvals, events, audit: r => audits.push(r), aiApproval,
    runningTasks: () => running,
    steer: async (sessionId, text) => { steered.push({ sessionId, text }) },
    lastClientSeen: () => lastSeen,
    now: () => clock,
  })
  return {
    ws, config, events, audits, approvals, aiApproval, running, steered, wd,
    advance: (ms: number) => { clock += ms },
    now: () => clock,
    setSeen: (t: number | undefined) => { lastSeen = t },
  }
}

const task = (id: string, sessionId: string, startedAt: string): TaskRecord =>
  ({ id, sessionId, title: `task ${id}`, prompt: 'p', status: 'running', resources: [], holds: [], createdAt: startedAt, startedAt } as unknown as TaskRecord)

test('approval aging: steer once after 1 min, alert at 3 and 8 min, clear when settled', async () => {
  const s = setup()
  s.running.push(task('t1', 's1', new Date(s.now()).toISOString()))
  let id = ''
  const call = s.approvals.request({ sessionId: 's1', taskId: 't1', tool: 'pwsh', summary: '{}', rule: 'unknown-command', reason: 'r', cwd: s.ws, origin: 'pre-execute' }, 60 * MIN, undefined, i => { id = i })
  s.advance(30_000); s.wd.tick()
  assert.equal(s.steered.length, 0)
  s.advance(31_000); s.wd.tick()
  assert.equal(s.steered.length, 1)
  assert.match(s.steered[0]?.text ?? '', /waiting for approval \(unknown-command\).*do not rewrite/)
  s.advance(2 * MIN); s.wd.tick()
  assert.equal(s.steered.length, 1, 'steered only once')
  const aging = () => s.wd.snapshot().alerts.filter(a => a.kind === 'approval-aging')
  let alerts = aging()
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0]?.kind, 'approval-aging')
  assert.equal(alerts[0]?.level, 'warn')
  s.advance(5 * MIN); s.wd.tick()
  alerts = aging()
  assert.equal(alerts[0]?.level, 'critical')
  assert.equal(types(s.events).filter(t => t === 'approval/aging').length, 2)
  assert.equal(s.wd.snapshot().oldestPendingSec, 8 * 60 + 1)
  s.approvals.decide(id, 'allow', 'ok', 'human')
  await call
  s.wd.tick()
  assert.equal(aging().length, 0)
})

test('orchestrator absent: pending approvals with no MCP call for 3 min raise an alert; it clears when a client calls', () => {
  const s = setup()
  void s.approvals.request({ sessionId: 's1', tool: 't', summary: '', rule: 'r', reason: '', cwd: s.ws, origin: 'pre-execute' }, 60 * MIN)
  s.advance(2 * MIN); s.wd.tick()
  assert.equal(s.wd.snapshot().alerts.filter(a => a.kind === 'orchestrator-absent').length, 0)
  s.advance(2 * MIN); s.wd.tick()
  assert.equal(s.wd.snapshot().alerts.filter(a => a.kind === 'orchestrator-absent').length, 1)
  assert.ok(types(s.events).includes('orchestrator/absent'))
  s.setSeen(s.now()); s.wd.tick()
  assert.equal(s.wd.snapshot().alerts.filter(a => a.kind === 'orchestrator-absent').length, 0)
  assert.ok(types(s.events).includes('orchestrator/back'))
  // No pending approvals: an idle orchestrator is fine.
  s.approvals.cancelAll()
  s.setSeen(undefined); s.advance(10 * MIN); s.wd.tick()
  assert.equal(s.wd.snapshot().alerts.length, 0)
})

test('stall detection: silence is reported, a known long wait (job_output wait) is not', () => {
  const s = setup()
  s.running.push(task('t1', 's1', new Date(s.now()).toISOString()), task('t2', 's2', new Date(s.now()).toISOString()))
  s.wd.tick()
  s.events.append('task/tool-call', { taskId: 't2', sessionId: 's2', tool: 'job_output', args: JSON.stringify({ job_id: 'j1', wait: true, timeout_ms: 20 * MIN }) })
  s.advance(11 * MIN); s.wd.tick()
  const snap = s.wd.snapshot()
  assert.deepEqual(snap.stalledTasks.map(t => t.taskId), ['t1'])
  assert.equal(snap.waitingTasks[0]?.taskId, 't2')
  assert.match(snap.waitingTasks[0]?.reason ?? '', /job_output wait/)
  assert.ok(types(s.events).includes('task/stalled'))
  // Activity clears the stall.
  s.events.append('task/tool-call', { taskId: 't1', sessionId: 's1', tool: 'read', args: '{}' })
  s.wd.tick()
  assert.equal(s.wd.snapshot().stalledTasks.length, 0)
  // A task waiting on an approval is not stalled.
  void s.approvals.request({ sessionId: 's1', taskId: 't1', tool: 't', summary: '', rule: 'r', reason: '', cwd: s.ws, origin: 'pre-execute' }, 60 * MIN)
  s.advance(15 * MIN); s.setSeen(s.now()); s.wd.tick()
  assert.equal(s.wd.snapshot().stalledTasks.some(t => t.taskId === 't1'), false)
})

test('AI judge health: three live errors (or one failed probe) degrade a judge; a success recovers it', async () => {
  const s = setup({ aiApproval: { enabled: true } })
  const judge = 'relay/judge-b'
  for (let i = 0; i < JUDGE_DEGRADED_AFTER - 1; i++) s.aiApproval.record({ judge, decision: 'error', reason: 'invalid temperature', latencyMs: 1 }, 'live')
  assert.equal(s.aiApproval.health().degraded, false)
  s.aiApproval.record({ judge, decision: 'error', reason: 'invalid temperature', latencyMs: 1 }, 'live')
  assert.equal(s.aiApproval.health().degraded, true)
  assert.ok(types(s.events).includes('ai/degraded'))
  s.wd.tick()
  assert.equal(s.wd.snapshot().alerts.find(a => a.kind === 'ai-degraded')?.level, 'critical')
  s.aiApproval.record({ judge, decision: 'allow', reason: 'fine', latencyMs: 1 }, 'live')
  assert.equal(s.aiApproval.health().degraded, false)
  assert.ok(types(s.events).includes('ai/recovered'))
  s.wd.tick()
  assert.equal(s.wd.snapshot().alerts.length, 0)
  // A probe failure counts at once; a judgment stopped because a human decided does not count.
  s.aiApproval.record({ judge, decision: 'error', reason: 'stopped: the approval was settled elsewhere', latencyMs: 1 }, 'live')
  assert.equal(s.aiApproval.health().degraded, false)
  s.aiApproval.record({ judge, decision: 'error', reason: '400 unknown model', latencyMs: 1 }, 'probe')
  assert.equal(s.aiApproval.health().degraded, true)
})

test('probeJudges asks each judge the fixed health question', async () => {
  const host = new FakeHost()
  host.modelReplies.set('relay/judge-b', JSON.stringify({ decision: 'allow', reason: 'probe' }))
  host.brokenRoutes.add('relay/judge-a')
  host.modelReplies.set('relay/judge-a', '')
  const config = resolveConfig({ aiApproval: { enabled: true, timeoutMs: 1000, judges: [{ provider: 'relay', model: 'judge-a' }, { provider: 'relay', model: 'judge-b' }] } })
  const opinions = await probeJudges(host.ctx, config.aiApproval)
  const byJudge = Object.fromEntries(opinions.map(o => [o.judge, o.decision]))
  assert.equal(byJudge['relay/judge-b'], 'allow')
  assert.equal(byJudge['relay/judge-a'], 'error')
})

test('safe timeout: the worker is told to defer the step, and the host re-ask about it is rejected, never queued', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'djy-wd-gate-'))
  const ws = path.join(dir, 'ws')
  mkdirSync(ws, { recursive: true })
  const host = new FakeHost()
  const config = resolveConfig({ stateDir: path.join(dir, 'state'), workspaceRoots: [ws], approvalTimeoutMs: 40 })
  const events = new EventLog(undefined)
  const approvals = new ApprovalQueue(events, () => {})
  const registry = { rootOf: () => 'root', get: () => ({ cwd: ws }) } as never
  installGate(host.ctx, { config, registry, approvals, events, audit: () => {}, heldResources: () => [], runningTask: () => 't1' })
  const agent = new FakeAgent(host, 'root', ws, undefined, {})
  // The approval timer is unref'd (the host keeps a real process alive); hold the loop open here.
  const keepAlive = setInterval(() => {}, 1000)
  t.after(() => clearInterval(keepAlive))
  const d = await host.preExecute(agent, 'pwsh', { command: 'frobnicate --x' })
  assert.equal(d.kind, 'deny')
  assert.match((d as { reason: string }).reason, /approval-timeout.*submit this exact call once more near the end/)
  // The host follows up about the same call: rejected at once, nothing new is queued.
  assert.equal(await host.approvalRequest(agent, 'pwsh', 'dujiangyan: no approver answered within 15 min'), 'rejected')
  assert.equal(approvals.list().length, 0)
  assert.ok(types(events).includes('approval/escalation-blocked'))
  // A genuine, unrelated sandbox escalation still goes to a human — flagged as running outside the sandbox.
  const genuine = host.approvalRequest(agent, 'write', 'wants to write outside the sandbox')
  for (let i = 0; i < 50 && approvals.list().length === 0; i++) await sleep(2)
  const p = approvals.list()[0]
  assert.equal(p?.rule, 'sandbox-escalation')
  assert.match(p?.danger ?? '', /OUTSIDE the sandbox/)
  approvals.decide(p?.id ?? '', 'deny', 'no', 'human')
  assert.equal(await genuine, 'rejected')
})

test('unattended timeouts: defer once, then mark blocked, then refuse at once; an approver coming back resets it', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'djy-wd-night-'))
  const ws = path.join(dir, 'ws')
  mkdirSync(ws, { recursive: true })
  const host = new FakeHost()
  const config = resolveConfig({ stateDir: path.join(dir, 'state'), workspaceRoots: [ws], approvalTimeoutMs: 30 })
  const events = new EventLog(undefined)
  const approvals = new ApprovalQueue(events, () => {})
  const registry = { rootOf: () => 'root', get: () => ({ cwd: ws }) } as never
  const blocked: Array<{ taskId: string | undefined; rule: string; fingerprint: string }> = []
  let seen: number | undefined
  installGate(host.ctx, {
    config, registry, approvals, events, audit: () => {}, heldResources: () => [], runningTask: () => 't1',
    approverSeen: () => seen,
    onBlocked: (_root, taskId, step) => { blocked.push({ taskId, rule: step.rule, fingerprint: step.fingerprint }) },
  })
  const agent = new FakeAgent(host, 'root', ws, undefined, {})
  const keepAlive = setInterval(() => {}, 1000)
  t.after(() => clearInterval(keepAlive))
  const call = () => host.preExecute(agent, 'pwsh', { command: 'frobnicate --night' }) as Promise<{ kind: string; reason?: string }>

  const first = await call()
  assert.match(first.reason ?? '', /approval-timeout.*once more near the end/)
  assert.equal(blocked.length, 0)
  const second = await call()
  assert.match(second.reason ?? '', /approval-timeout.*BLOCKED-ON-APPROVAL/)
  assert.equal(blocked.length, 1)
  assert.equal(blocked[0]?.taskId, 't1')
  // Third time: refused at once, nothing is queued for another full timeout.
  const third = call()
  await sleep(1)
  assert.equal(approvals.list().length, 0)
  assert.match((await third).reason ?? '', /approval-unavailable.*do not submit it again/)
  assert.equal(blocked.length, 2)
  assert.equal(blocked[1]?.fingerprint, blocked[0]?.fingerprint)
  assert.ok(types(events).includes('approval/unavailable'))
  // A different call still gets its own first chance.
  assert.match((await host.preExecute(agent, 'pwsh', { command: 'frobnicate --other' }) as { reason: string }).reason, /once more near the end/)

  // The orchestrator calls in again (MCP activity after the timeouts): the same call is asked again.
  seen = Date.now() + 1
  const again = call()
  for (let i = 0; i < 50 && approvals.list().length === 0; i++) await sleep(2)
  assert.equal(approvals.list().length, 1)
  approvals.decide(approvals.list()[0]?.id ?? '', 'allow', 'ok', 'orchestrator')
  assert.equal((await again).kind, 'allow')
})
