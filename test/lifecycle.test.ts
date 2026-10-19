import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { EventLog } from '../src/events.ts'
import { apply, type Config } from '../src/index.ts'
import { LocalRules, parseLocalRules } from '../src/local-rules.ts'
import { FakeHost, type FakeAgent } from './fake-host.ts'

const parse = (r: any) => JSON.parse(r.content[0].text)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function setup(port: number, opts: { localRules?: unknown; dir?: string; extra?: Partial<Config> } = {}) {
  const dir = opts.dir ?? mkdtempSync(path.join(tmpdir(), 'djy-life-'))
  const ws = path.join(dir, 'ws')
  const ws2 = path.join(dir, 'ws2')
  mkdirSync(ws, { recursive: true })
  mkdirSync(ws2, { recursive: true })
  const stateDir = path.join(dir, 'state')
  mkdirSync(stateDir, { recursive: true })
  if (opts.localRules !== undefined) writeFileSync(path.join(stateDir, 'local-rules.json'), JSON.stringify(opts.localRules))
  const host = new FakeHost()
  apply(host.ctx, {
    port,
    stateDir,
    workspaceRoots: [ws, ws2],
    approvalTimeoutMs: 5000,
    preflight: false,
    startupRetryDelaysMs: [20, 40],
    roster: { implementer: [{ provider: 'deepseek-official', model: 'deepseek-flash' }] },
    ...opts.extra,
  })
  const token = readFileSync(path.join(stateDir, 'token'), 'utf8').trim()
  return { dir, ws, ws2, stateDir, host, token, url: `http://127.0.0.1:${port}/mcp` }
}

async function connect(url: string, token: string): Promise<Client> {
  const client = new Client({ name: 'claude-code-test', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  return client
}

async function waitTask(client: Client, taskId: string, until: (t: any) => boolean): Promise<any> {
  let task: any
  for (let i = 0; i < 100; i++) {
    task = parse(await client.callTool({ name: 'djy_task_get', arguments: { taskId } }))
    if (until(task)) return task
    await sleep(20)
  }
  return task
}

test('event log: a cursor or epoch from an earlier start resets instead of waiting forever', async () => {
  const log = new EventLog(undefined)
  log.append('a', {})
  log.append('b', {})
  const fresh = log.since(0)
  assert.equal(fresh.reset, false)
  assert.equal(fresh.cursor, 2)
  // a cursor beyond the newest event can only come from an earlier start
  const ahead = await log.wait(1069, 5000)
  assert.equal(ahead.reset, true)
  assert.deepEqual(ahead.events.map(e => e.type), ['a', 'b'])
  // a different epoch resets even when the number happens to be in range
  const other = log.since(1, 200, 'deadbeef')
  assert.equal(other.reset, true)
  assert.equal(other.events.length, 2)
  // the current epoch with a valid cursor behaves as before
  const same = log.since(1, 200, log.epoch)
  assert.equal(same.reset, false)
  assert.deepEqual(same.events.map(e => e.type), ['b'])
})

test('local rules: validation rejects bad input with a message', () => {
  assert.equal(parseLocalRules('{"rules":{"denyPatterns":["("]}}').ok, false)
  assert.equal(parseLocalRules('{"hints":[{"match":"x"}]}').ok, false, 'hint without reason')
  assert.equal(parseLocalRules('{"rulez":{}}').ok, false, 'unknown key')
  assert.equal(parseLocalRules('{"workspaces":{"D:/a":{"workspaces":{}}}}').ok, false, 'no nesting')
  assert.equal(parseLocalRules('not json').ok, false)
  assert.equal(parseLocalRules('{"$comment":"x","rules":{"allowCommands":["fsutil"]},"facts":["f"],"hints":[{"match":"a","reason":"b","tool":"pwsh"}]}').ok, true)
})

test('local rules: invalid file keeps the last good version; deleting it clears the rules', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'djy-lr-'))
  try {
    const events = new EventLog(undefined)
    const audit: any[] = []
    const lr = new LocalRules({ stateDir: dir, events, audit: r => audit.push(r), base: () => ({ allowCommands: ['base'] }) })
    assert.deepEqual(lr.reload(), { ok: true, present: false })
    writeFileSync(lr.file, JSON.stringify({ rules: { allowCommands: ['mine'] }, facts: ['top'], workspaces: { [path.join(dir, 'p')]: { facts: ['scoped'] } } }))
    assert.equal(lr.reload().ok, true)
    assert.deepEqual(lr.effective(undefined).rules.allowCommands, ['base', 'mine'])
    assert.deepEqual(lr.effective(path.join(dir, 'p', 'sub')).facts, ['top', 'scoped'])
    assert.deepEqual(lr.effective(path.join(dir, 'q')).facts, ['top'])

    writeFileSync(lr.file, '{ broken')
    const bad = lr.reload()
    assert.equal(bad.ok, false)
    assert.deepEqual(lr.effective(undefined).rules.allowCommands, ['base', 'mine'], 'last good version stays in force')
    assert.match(lr.status().lastError ?? '', /not valid JSON/)
    assert.ok(events.since(0).events.some(e => e.type === 'rules/invalid'))
    assert.ok(audit.some(r => r.type === 'rules/invalid'))

    rmSync(lr.file)
    assert.deepEqual(lr.reload(), { ok: true, present: false })
    assert.deepEqual(lr.effective(undefined).rules.allowCommands, ['base'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('hints only redirect escalations; workspace scoping; protected data dir; facts and bench patterns reach the gate', async () => {
  const env = setup(18796, {
    localRules: {
      rules: { benchPatterns: ['measure\\.exe'] },
      hints: [
        { match: 'curl', reason: 'no network probes: the orchestrator fetches dependencies' },
        { match: 'cargo', reason: 'should never fire on an allowed call' },
        { match: 'git', reason: 'should never fire on a denied call' },
      ],
      facts: ['KLayout version: pipe klayout_app -b -v through Out-String'],
    },
  })
  try {
    // scope a hint to ws2 only, written after start → exercised through djy_rules_reload
    const client = await connect(env.url, env.token)
    const a = parse(await client.callTool({ name: 'djy_session_create', arguments: { cwd: env.ws, role: 'implementer' } }))
    const b = parse(await client.callTool({ name: 'djy_session_create', arguments: { cwd: env.ws2, role: 'implementer' } }))
    const agentA = env.host.agentsById.get(a.sessionId) as FakeAgent
    const agentB = env.host.agentsById.get(b.sessionId) as FakeAgent

    const curl = await env.host.preExecute(agentA, 'pwsh', { command: 'curl.exe -I https://crates.io' })
    assert.equal(curl.kind, 'deny')
    assert.match((curl as any).reason, /\[dujiangyan-denied:hint:1\] no network probes/)
    assert.equal((await env.host.preExecute(agentA, 'pwsh', { command: 'cargo build --offline' })).kind, 'allow', 'hint does not touch allowed calls')
    const push = await env.host.preExecute(agentA, 'pwsh', { command: 'git push' })
    assert.equal(push.kind, 'deny')
    assert.match((push as any).reason, /git-remote/, 'a deny keeps its own rule')
    const bench = await env.host.preExecute(agentA, 'pwsh', { command: `& ${path.join(env.ws, 'target', 'measure.exe').replace(/\\/g, '/')} --n 10` })
    assert.equal(bench.kind, 'deny')
    assert.match((bench as any).reason, /bench/)

    // protected plugin data dir: workers can neither write the rules nor read the token
    assert.equal((await env.host.preExecute(agentA, 'write', { file_path: path.join(env.stateDir, 'local-rules.json'), content: '{}' })).kind, 'deny')
    assert.equal((await env.host.preExecute(agentA, 'pwsh', { command: `Set-Content -Path ${path.join(env.stateDir, 'local-rules.json').replace(/\\/g, '/')} -Value x` })).kind, 'deny')
    assert.equal((await env.host.preExecute(agentA, 'read', { file_path: path.join(env.stateDir, 'token') })).kind, 'deny')

    // invalid file → reload refused, previous rules still in force
    writeFileSync(path.join(env.stateDir, 'local-rules.json'), '{"hints":[{"match":"(","reason":"x"}]}')
    const refused = await client.callTool({ name: 'djy_rules_reload', arguments: {} })
    assert.equal(refused.isError, true)
    assert.equal((await env.host.preExecute(agentA, 'pwsh', { command: 'curl.exe https://x.y' })).kind, 'deny', 'last good hints still apply')

    // workspace-scoped hint
    writeFileSync(path.join(env.stateDir, 'local-rules.json'), JSON.stringify({
      workspaces: { [env.ws2]: { hints: [{ match: 'curl', reason: 'ws2 only' }], facts: ['ws2 fact'] } },
    }))
    assert.notEqual((await client.callTool({ name: 'djy_rules_reload', arguments: {} })).isError, true)
    const inB = await env.host.preExecute(agentB, 'pwsh', { command: 'curl.exe https://x.y' })
    assert.match((inB as any).reason, /ws2 only/)
    const inA = env.host.preExecute(agentA, 'pwsh', { command: 'curl.exe https://x.y' })
    await sleep(50)
    const pending = parse(await client.callTool({ name: 'djy_approvals_list', arguments: {} }))
    assert.equal(pending.length, 1, 'outside ws2 the escalation waits for an approver as usual')
    await client.callTool({ name: 'djy_approval_decide', arguments: { id: pending[0].id, decision: 'deny', reason: 'no' } })
    await inA
    const got = parse(await client.callTool({ name: 'djy_rules_get', arguments: { cwd: env.ws2 } }))
    assert.equal(got.present, true)
    assert.deepEqual(got.effective.facts, ['ws2 fact'])
    assert.equal(got.effective.hints[0].reason, 'ws2 only')

    // facts reach the worker prompt
    const task = parse(await client.callTool({ name: 'djy_task_submit', arguments: { sessionId: b.sessionId, prompt: 'make data' } }))
    await waitTask(client, task.taskId, t => t.status === 'done' || t.status === 'error')
    assert.match(JSON.stringify(agentB.received.at(-1)), /ws2 fact/)

    // the file watcher picks up a save without an explicit reload
    writeFileSync(path.join(env.stateDir, 'local-rules.json'), JSON.stringify({ facts: ['watched'] }))
    let watched: any
    for (let i = 0; i < 60; i++) {
      watched = parse(await client.callTool({ name: 'djy_rules_get', arguments: { cwd: env.ws } }))
      if (watched.effective.facts.includes('watched')) break
      await sleep(50)
    }
    assert.deepEqual(watched.effective.facts, ['watched'])
    const ev = parse(await client.callTool({ name: 'djy_events_watch', arguments: { cursor: 0, waitSeconds: 0 } }))
    assert.ok(ev.events.some((e: any) => e.type === 'rules/reloaded'))
    assert.ok(ev.events.some((e: any) => e.type === 'rules/invalid'))
    await client.close()
  } finally {
    env.host.dispose()
    await sleep(50)
    rmSync(env.dir, { recursive: true, force: true })
  }
})

test('startup failures are retried; a desktop restart marks unfinished tasks interrupted, not done', async () => {
  const env = setup(18797)
  let client = await connect(env.url, env.token)
  try {
    const s = parse(await client.callTool({ name: 'djy_session_create', arguments: { cwd: env.ws, role: 'implementer' } }))
    const agent = env.host.agentsById.get(s.sessionId) as FakeAgent

    // 1. the first two turns fail in prompt assembly → retried, then the task runs
    env.host.startupFailures = 2
    const retried = parse(await client.callTool({ name: 'djy_task_submit', arguments: { sessionId: s.sessionId, prompt: 'make data' } }))
    const ok = await waitTask(client, retried.taskId, t => t.status === 'done' || t.status === 'error')
    assert.equal(ok.status, 'done')
    let ev = parse(await client.callTool({ name: 'djy_events_watch', arguments: { cursor: 0, waitSeconds: 0 } }))
    assert.equal(ev.events.filter((e: any) => e.type === 'task/retry' && e.data.taskId === retried.taskId).length, 2)

    // 2. a third startup failure is reported, not retried forever
    env.host.startupFailures = 3
    const failed = parse(await client.callTool({ name: 'djy_task_submit', arguments: { sessionId: s.sessionId, prompt: 'make data' } }))
    const err = await waitTask(client, failed.taskId, t => t.status === 'done' || t.status === 'error')
    assert.equal(err.status, 'error')
    assert.match(err.error, /has no value for this assembly/)
    env.host.startupFailures = 0

    // 3. a task stuck on an approval when the desktop restarts → interrupted
    env.host.scripts.set('needs approval', [{ tool: 'pwsh', args: { command: 'git clone https://example.com/x' } }])
    const stuck = parse(await client.callTool({ name: 'djy_task_submit', arguments: { sessionId: s.sessionId, prompt: 'needs approval', resources: ['bench'] } }))
    await waitTask(client, stuck.taskId, t => t.status === 'running')
    for (let i = 0; i < 50 && parse(await client.callTool({ name: 'djy_approvals_list', arguments: {} })).length === 0; i++) await sleep(20)
    ev = parse(await client.callTool({ name: 'djy_events_watch', arguments: { cursor: 0, waitSeconds: 0 } }))
    const oldCursor = ev.cursor
    const oldEpoch = ev.epoch
    await client.close()
    env.host.dispose() // desktop quits: plugin stops
    await sleep(100) // let the cancelled approval unwind the turn
    const persisted = JSON.parse(readFileSync(path.join(env.stateDir, 'tasks.json'), 'utf8')) as any[]
    const rec = persisted.find(t => t.id === stuck.taskId)
    assert.equal(rec.status, 'interrupted')
    assert.match(rec.result.errors.join(' '), /interrupted by plugin stop\/restart/)
    assert.equal(rec.holds.length, 0)
    void agent

    // 4. restart on the same state: the record survives, a task left "running" on disk becomes interrupted, cursors reset
    persisted.push({ ...rec, id: 'task_left_running', status: 'running', result: undefined, error: undefined })
    writeFileSync(path.join(env.stateDir, 'tasks.json'), JSON.stringify(persisted))
    const env2 = setup(18798, { dir: env.dir })
    try {
      client = await connect(env2.url, env2.token)
      assert.equal(parse(await client.callTool({ name: 'djy_task_get', arguments: { taskId: stuck.taskId } })).status, 'interrupted')
      const left = parse(await client.callTool({ name: 'djy_task_get', arguments: { taskId: 'task_left_running' } }))
      assert.equal(left.status, 'interrupted')
      const listed = parse(await client.callTool({ name: 'djy_task_list', arguments: { status: 'interrupted' } }))
      assert.ok(listed.length >= 2)
      const after = parse(await client.callTool({ name: 'djy_events_watch', arguments: { cursor: oldCursor, epoch: oldEpoch, waitSeconds: 5 } }))
      assert.equal(after.reset, true, 'the old cursor does not hang after a restart')
      assert.notEqual(after.epoch, oldEpoch)
      await client.close()
    } finally {
      env2.host.dispose()
    }
  } finally {
    await sleep(50)
    rmSync(env.dir, { recursive: true, force: true })
  }
})

test('cancel: a queued task ends at once; a running one is cancelled with a cause; limits, preflight and close work over MCP', async () => {
  const env = setup(18799)
  const client = await connect(env.url, env.token)
  try {
    const s = parse(await client.callTool({ name: 'djy_session_create', arguments: { cwd: env.ws, role: 'implementer' } }))
    const agent = env.host.agentsById.get(s.sessionId) as FakeAgent
    // A task held on a pending approval keeps the session busy, so the next one stays queued.
    env.host.scripts.set('needs approval', [{ tool: 'pwsh', args: { command: 'git clone https://example.com/x' } }])
    const busy = parse(await client.callTool({ name: 'djy_task_submit', arguments: { sessionId: s.sessionId, prompt: 'needs approval' } }))
    await waitTask(client, busy.taskId, t => t.status === 'running')
    const queued = parse(await client.callTool({ name: 'djy_task_submit', arguments: { sessionId: s.sessionId, prompt: 'make data' } }))
    assert.equal(parse(await client.callTool({ name: 'djy_task_get', arguments: { taskId: queued.taskId } })).status, 'queued')

    assert.deepEqual(parse(await client.callTool({ name: 'djy_task_cancel', arguments: { taskId: queued.taskId } })), { cancelled: queued.taskId })
    const now = parse(await client.callTool({ name: 'djy_task_get', arguments: { taskId: queued.taskId } }))
    assert.equal(now.status, 'cancelled', 'no waiting for the queue to reach it')
    const ev = parse(await client.callTool({ name: 'djy_events_watch', arguments: { cursor: 0, waitSeconds: 0 } }))
    assert.ok(ev.events.some((e: any) => e.type === 'task/cancelled' && e.data.taskId === queued.taskId))
    assert.equal((await client.callTool({ name: 'djy_task_cancel', arguments: { taskId: queued.taskId } })).isError, true, 'second cancel refused')

    parse(await client.callTool({ name: 'djy_task_cancel', arguments: { taskId: busy.taskId } }))
    const ended = await waitTask(client, busy.taskId, t => t.status === 'cancelled')
    assert.equal(ended.status, 'cancelled')
    assert.ok(agent.cancelCauses.length > 0 && agent.cancelCauses.every(c => c != null && typeof (c as { kind?: unknown }).kind === 'string'), 'host cancel always gets a cause')
    await sleep(50)
    assert.equal(parse(await client.callTool({ name: 'djy_task_get', arguments: { taskId: queued.taskId } })).status, 'cancelled', 'the queue reaching it does not revive it')

    const limits = parse(await client.callTool({ name: 'djy_limits_set', arguments: { provider: 'deepseek-official', maxConcurrent: 3 } }))
    assert.equal(limits.effective.maxConcurrent, 3)
    const pre = parse(await client.callTool({ name: 'djy_preflight', arguments: { cwd: env.ws } }))
    assert.ok(Array.isArray(pre.issues))
    assert.match(pre.facts, /Environment facts/)

    assert.deepEqual(parse(await client.callTool({ name: 'djy_session_close', arguments: { sessionId: s.sessionId } })), { closed: s.sessionId })
    assert.equal((await client.callTool({ name: 'djy_session_close', arguments: { sessionId: s.sessionId } })).isError, true)
  } finally {
    await client.close()
    env.host.dispose()
    await sleep(50)
    rmSync(env.dir, { recursive: true, force: true })
  }
})

test('slots: a cancelled waiter leaves the queue, so the next waiter gets the freed slot (review M1)', async () => {
  const env = setup(18800, { extra: { maxActiveSessions: 1 } })
  const client = await connect(env.url, env.token)
  try {
    const mk = async () => parse(await client.callTool({ name: 'djy_session_create', arguments: { cwd: env.ws, role: 'implementer' } })).sessionId as string
    const [s1, s2, s3] = [await mk(), await mk(), await mk()]
    env.host.scripts.set('needs approval', [{ tool: 'pwsh', args: { command: 'git clone https://example.com/x' } }])
    const a = parse(await client.callTool({ name: 'djy_task_submit', arguments: { sessionId: s1, prompt: 'needs approval' } }))
    await waitTask(client, a.taskId, t => t.status === 'running')
    const b = parse(await client.callTool({ name: 'djy_task_submit', arguments: { sessionId: s2, prompt: 'make data' } }))
    await waitTask(client, b.taskId, t => t.status === 'waiting_slot')
    const c = parse(await client.callTool({ name: 'djy_task_submit', arguments: { sessionId: s3, prompt: 'make data' } }))
    await waitTask(client, c.taskId, t => t.status === 'waiting_slot')
    parse(await client.callTool({ name: 'djy_task_cancel', arguments: { taskId: b.taskId } })) // first in line, now dead
    assert.equal((await waitTask(client, b.taskId, t => t.status === 'cancelled')).status, 'cancelled')
    parse(await client.callTool({ name: 'djy_task_cancel', arguments: { taskId: a.taskId } })) // frees the slot
    assert.equal((await waitTask(client, c.taskId, t => t.status === 'done')).status, 'done', 'the live waiter is woken, not the cancelled one')
  } finally {
    await client.close()
    env.host.dispose()
    await sleep(50)
    rmSync(env.dir, { recursive: true, force: true })
  }
})

test('bench: a task whose lease was taken over loses bench rights at once (review M3)', async () => {
  const env = setup(18801)
  const client = await connect(env.url, env.token)
  try {
    const s = parse(await client.callTool({ name: 'djy_session_create', arguments: { cwd: env.ws, role: 'implementer' } }))
    const agent = env.host.agentsById.get(s.sessionId) as FakeAgent
    env.host.scripts.set('bench later', [{ waitMs: 300, tool: 'pwsh', args: { command: 'cargo bench' } }])
    const t = parse(await client.callTool({ name: 'djy_task_submit', arguments: { sessionId: s.sessionId, prompt: 'bench later', resources: ['bench'] } }))
    await waitTask(client, t.taskId, x => x.status === 'running')
    const lock = path.join(env.stateDir, 'locks', 'bench.lock')
    const rec = JSON.parse(readFileSync(lock, 'utf8'))
    writeFileSync(lock, JSON.stringify({ ...rec, holder: 'someone-else', epoch: rec.epoch + 1, expiresAt: Date.now() + 60_000 }))
    await waitTask(client, t.taskId, x => x.status !== 'running')
    const d = agent.decisions.find(x => x.tool === 'pwsh')?.decision as { kind: string; reason?: string } | undefined
    assert.equal(d?.kind, 'deny', 'bench command refused once the lease file names another holder')
  } finally {
    await client.close()
    env.host.dispose()
    await sleep(50)
    rmSync(env.dir, { recursive: true, force: true })
  }
})
