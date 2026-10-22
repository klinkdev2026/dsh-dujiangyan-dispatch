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
    // findings 57: a sandbox request for the current mode is judged as if absent, the orchestrator hears of it once.
    const noop = { command: 'Get-ChildItem', sandbox_permissions: 'workspace-write', justification: 'build' }
    assert.equal((await env.host.preExecute(agentA, 'pwsh', noop)).kind, 'allow')
    assert.equal((await env.host.preExecute(agentA, 'pwsh', noop)).kind, 'allow')
    const wider = env.host.preExecute(agentA, 'pwsh', { ...noop, sandbox_permissions: 'danger-full-access' })
    const hints = parse(await client.callTool({ name: 'djy_events_watch', arguments: { cursor: 0, waitSeconds: 0 } })).events.filter((e: any) => e.type === 'gate/hint')
    assert.equal(hints.length, 1)
    let held: any
    for (let i = 0; i < 100 && held === undefined; i++) {
      held = parse(await client.callTool({ name: 'djy_approvals_list', arguments: {} })).find((p: any) => p.rule === 'sandbox-escalation')
      if (held === undefined) await sleep(10)
    }
    assert.ok(held, 'a wider mode still waits for an approver')
    await client.callTool({ name: 'djy_approval_decide', arguments: { id: held.id, decision: 'deny', reason: 'test' } })
    assert.equal((await wider).kind, 'deny')
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

test('local rules: extra workspace roots apply without a restart; unsafe roots are refused', async () => {
  const env = setup(18814)
  const other = path.join(env.dir, 'other')
  mkdirSync(other, { recursive: true })
  try {
    const client = await connect(env.url, env.token)
    const create = () => client.callTool({ name: 'djy_session_create', arguments: { cwd: other, role: 'implementer' } })
    const refused = await create()
    assert.equal(refused.isError, true)
    assert.match(JSON.stringify(refused), /workspaceRoots/, 'the refusal says how to add a root')

    const rules = path.join(env.stateDir, 'local-rules.json')
    writeFileSync(rules, JSON.stringify({ workspaceRoots: [other] }))
    assert.notEqual((await client.callTool({ name: 'djy_rules_reload', arguments: {} })).isError, true)
    const s = parse(await create())
    assert.ok(s.sessionId)
    const agent = env.host.agentsById.get(s.sessionId) as FakeAgent
    assert.equal((await env.host.preExecute(agent, 'write', { file_path: path.join(other, 'a.txt'), content: 'x' })).kind, 'allow', 'the gate uses the new root')
    assert.ok(parse(await client.callTool({ name: 'djy_status', arguments: {} })).workspaceRoots.length >= 3)

    for (const bad of [env.dir, path.join(env.stateDir, 'sub'), path.parse(env.dir).root, 'relative/dir']) {
      writeFileSync(rules, JSON.stringify({ workspaceRoots: [bad] }))
      assert.equal((await client.callTool({ name: 'djy_rules_reload', arguments: {} })).isError, true, `refused: ${bad}`)
    }
    assert.ok(parse(await create()).sessionId, 'the last good roots stay in force')
    await client.close()
  } finally {
    env.host.dispose()
    await sleep(50)
    rmSync(env.dir, { recursive: true, force: true })
  }
})

test('AI judges change at runtime: probed first, kept across restarts, no profile edit', async () => {
  const env = setup(18815, { extra: { aiApproval: { enabled: true, timeoutMs: 500, judges: [{ provider: 'relay', model: 'old' }] } } })
  env.host.modelReplies.set('relay/good', JSON.stringify({ decision: 'allow', reason: 'probe' }))
  env.host.modelReplies.set('relay/bad', 'hang')
  try {
    const client = await connect(env.url, env.token)
    const set = (args: unknown) => client.callTool({ name: 'djy_ai_approval_set', arguments: args as Record<string, unknown> })
    const broken = await set({ judges: [{ provider: 'relay', model: 'good' }, { provider: 'relay', model: 'bad' }] })
    assert.equal(broken.isError, true, 'a judge that fails its probe is not installed')
    assert.deepEqual(parse(await client.callTool({ name: 'djy_ai_approval_get', arguments: {} })).judges, [{ provider: 'relay', model: 'old' }])

    const ok = parse(await set({ judges: [{ provider: 'relay', model: 'good' }] }))
    assert.deepEqual(ok.judges, [{ provider: 'relay', model: 'good' }])
    assert.equal(ok.judgesSource, 'runtime')
    await client.close()
  } finally {
    env.host.dispose()
    await sleep(50)
  }
  // a restart keeps the runtime choice
  const again = setup(18815, { dir: env.dir })
  try {
    const client = await connect(again.url, again.token)
    const got = parse(await client.callTool({ name: 'djy_ai_approval_get', arguments: {} }))
    assert.deepEqual(got.judges, [{ provider: 'relay', model: 'good' }])
    assert.deepEqual(parse(await client.callTool({ name: 'djy_ai_approval_set', arguments: { judges: null } })).judgesSource, 'profile')
    await client.close()
  } finally {
    again.host.dispose()
    await sleep(50)
    rmSync(env.dir, { recursive: true, force: true })
  }
})

test('AI judges per session, batch and folder: each orchestrator can use its own', async () => {
  const say = JSON.stringify({ decision: 'allow', reason: 'probe' })
  const env = setup(18816, {
    extra: { aiApproval: { enabled: true, timeoutMs: 500, judges: [{ provider: 'relay', model: 'global' }] } },
  })
  for (const m of ['global', 'folder', 'own', 'night']) env.host.modelReplies.set(`relay/${m}`, Array(20).fill(say))
  writeFileSync(path.join(env.stateDir, 'local-rules.json'), JSON.stringify({ workspaces: { [env.ws2]: { aiApproval: { judges: [{ provider: 'relay', model: 'folder' }] } } } }))
  try {
    const client = await connect(env.url, env.token)
    assert.notEqual((await client.callTool({ name: 'djy_rules_reload', arguments: {} })).isError, true)
    const create = async (args: Record<string, unknown>) => parse(await client.callTool({ name: 'djy_session_create', arguments: { role: 'implementer', ...args } }))
    const own = await create({ cwd: env.ws, judges: [{ provider: 'relay', model: 'own' }] })
    const plain = await create({ cwd: env.ws, batch: 'night' })
    const inFolder = await create({ cwd: env.ws2, batch: 'night' })
    assert.deepEqual(own.judges, ['relay/own'])
    const judgesOf = async (sessionId: string) => parse(await client.callTool({ name: 'djy_ai_approval_get', arguments: { sessionId } }))
    assert.deepEqual((await judgesOf(plain.sessionId)).judges, [{ provider: 'relay', model: 'global' }])
    assert.equal((await judgesOf(inFolder.sessionId)).judgesSource, 'workspace')

    // a judged escalation asks the judges of the calling session
    env.host.modelCalls.length = 0
    const agent = env.host.agentsById.get(own.sessionId) as FakeAgent
    assert.equal((await env.host.preExecute(agent, 'pwsh', { command: 'frobnicate --all' })).kind, 'allow')
    assert.deepEqual([...new Set(env.host.modelCalls.map(c => c.route))], ['relay/own'])

    // a batch switches together; other sessions keep theirs
    const batch = parse(await client.callTool({ name: 'djy_ai_approval_set', arguments: { batch: 'night', judges: [{ provider: 'relay', model: 'night' }] } }))
    assert.deepEqual(batch.sessions.sort(), [plain.sessionId, inFolder.sessionId].sort())
    assert.deepEqual((await judgesOf(inFolder.sessionId)).judges, [{ provider: 'relay', model: 'night' }])
    assert.deepEqual((await judgesOf(own.sessionId)).judges, [{ provider: 'relay', model: 'own' }])
    assert.deepEqual(parse(await client.callTool({ name: 'djy_ai_approval_get', arguments: {} })).judges, [{ provider: 'relay', model: 'global' }], 'global judges unchanged')
    // null returns a session to its folder judges
    await client.callTool({ name: 'djy_ai_approval_set', arguments: { sessionId: inFolder.sessionId, judges: null } })
    assert.deepEqual((await judgesOf(inFolder.sessionId)).judges, [{ provider: 'relay', model: 'folder' }])
    assert.equal((await client.callTool({ name: 'djy_ai_approval_set', arguments: { batch: 'none', judges: null } })).isError, true)
    await client.close()
  } finally {
    env.host.dispose()
    await sleep(50)
    rmSync(env.dir, { recursive: true, force: true })
  }
})

test('the orchestrator is told it is the approver: server instructions, submit reply, waitingForYou', async () => {
  const env = setup(18817)
  try {
    const client = await connect(env.url, env.token)
    assert.match(client.getInstructions() ?? '', /first approver/)
    const s = parse(await client.callTool({ name: 'djy_session_create', arguments: { cwd: env.ws, role: 'implementer' } }))
    env.host.scripts.set('needs a decision', [{ tool: 'pwsh', args: { command: 'frobnicate --all' } }])
    const sub = parse(await client.callTool({ name: 'djy_task_submit', arguments: { sessionId: s.sessionId, prompt: 'needs a decision' } }))
    assert.match(sub.approver, /ask your user/)
    const t = await waitTask(client, sub.taskId, x => x.waitingForYou !== undefined)
    assert.equal(t.waitingForYou[0].rule, 'unknown-command')
    await client.callTool({ name: 'djy_approval_decide', arguments: { id: t.waitingForYou[0].id, decision: 'deny', reason: 'test' } })
    await client.close()
  } finally {
    env.host.dispose()
    await sleep(50)
    rmSync(env.dir, { recursive: true, force: true })
  }
})

test('approval timeouts: event polling does not reset the count, listing approvals does (review F2)', async () => {
  const env = setup(18818, { extra: { approvalTimeoutMs: 40 } })
  try {
    const client = await connect(env.url, env.token)
    const s = parse(await client.callTool({ name: 'djy_session_create', arguments: { cwd: env.ws, role: 'implementer' } }))
    const agent = env.host.agentsById.get(s.sessionId) as FakeAgent
    const call = async () => ((await env.host.preExecute(agent, 'pwsh', { command: 'frobnicate --night' })) as { reason?: string }).reason ?? ''
    assert.match(await call(), /once more near the end/)
    await client.callTool({ name: 'djy_events_watch', arguments: { cursor: 0, waitSeconds: 0 } })
    assert.match(await call(), /BLOCKED-ON-APPROVAL/, 'polling events is not handling approvals')
    await client.callTool({ name: 'djy_approvals_list', arguments: {} })
    assert.match(await call(), /once more near the end/, 'an approver looking at approvals starts the count again')
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
    // findings 58: the cancelled turn keeps calling tools; the gate refuses and stops it again.
    const causes = agent.cancelCauses.length
    const stray = await env.host.preExecute(agent, 'read', { file_path: path.join(env.ws, 'x.txt') })
    assert.equal(stray.kind, 'deny')
    assert.match((stray as { reason?: string }).reason ?? '', /task ended \(cancelled\)/)
    assert.ok(agent.cancelCauses.length > causes, 'the turn is cancelled again')
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
    const t = parse(await client.callTool({ name: 'djy_task_submit', arguments: { sessionId: s.sessionId, prompt: 'bench later', resources: ['bench:task'] } }))
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

test('a turn cut off by the output-token limit is continued, not reported as done; endless cut-offs need attention', async () => {
  const env = setup(18802)
  const client = await connect(env.url, env.token)
  try {
    const s = parse(await client.callTool({ name: 'djy_session_create', arguments: { cwd: env.ws, role: 'implementer' } }))
    const agent = env.host.agentsById.get(s.sessionId) as FakeAgent
    env.host.scripts.set('write the report', [{ tool: 'read', args: { file_path: 'a.txt' } }, { tool: '', args: {}, cutOff: true }])
    env.host.scripts.set('output-token limit', [{ tool: 'read', args: { file_path: 'b.txt' } }])
    const t = parse(await client.callTool({ name: 'djy_task_submit', arguments: { sessionId: s.sessionId, prompt: 'write the report' } }))
    const done = await waitTask(client, t.taskId, x => x.status !== 'running' && x.status !== 'queued')
    assert.equal(done.status, 'done')
    assert.equal(done.result.summary.changes, 'wrote data', 'the summary comes from the continued turn')
    const sent = agent.received.map(m => JSON.stringify(m))
    assert.ok(sent.at(-1)?.includes('output-token limit'), 'the worker was told to continue in smaller pieces')
    const ev = parse(await client.callTool({ name: 'djy_events_watch', arguments: { cursor: 0, waitSeconds: 0 } }))
    assert.equal(ev.events.filter((e: any) => e.type === 'task/continued' && e.data.taskId === t.taskId).length, 1)

    env.host.scripts.set('output-token limit', [{ tool: '', args: {}, cutOff: true }])
    const stuck = parse(await client.callTool({ name: 'djy_task_submit', arguments: { sessionId: s.sessionId, prompt: 'write the report' } }))
    const end = await waitTask(client, stuck.taskId, x => x.status !== 'running' && x.status !== 'queued')
    assert.equal(end.status, 'needs_attention')
    assert.match(end.result.errors.join(' '), /output-token limit/)
  } finally {
    await client.close()
    env.host.dispose()
    await sleep(50)
    rmSync(env.dir, { recursive: true, force: true })
  }
})
