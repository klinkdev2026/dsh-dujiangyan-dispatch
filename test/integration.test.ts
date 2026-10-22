import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { apply } from '../src/index.ts'
import { FakeHost, type FakeAgent } from './fake-host.ts'

function setup(port: number) {
  const dir = mkdtempSync(path.join(tmpdir(), 'djy-int-'))
  const ws = path.join(dir, 'ws')
  mkdirSync(ws)
  const host = new FakeHost()
  apply(host.ctx, {
    port,
    stateDir: path.join(dir, 'state'),
    workspaceRoots: [ws],
    approvalTimeoutMs: 2000,
    preflight: false,
    roster: {
      implementer: [
        { provider: 'relay', model: 'model-b' },
        { provider: 'deepseek-official', model: 'deepseek-flash' },
      ],
    },
    limits: { providers: { relay: { maxConcurrent: 4, minSpacingMs: 0, jitterMs: 0, breakerThreshold: 2, breakerCooldownMs: 60_000 } } },
  })
  const token = readFileSync(path.join(dir, 'state', 'token'), 'utf8').trim()
  return { dir, ws, host, token, url: `http://127.0.0.1:${port}/mcp` }
}

async function connect(url: string, token: string): Promise<Client> {
  const client = new Client({ name: 'claude-code-test', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  return client
}

const parse = (r: any) => JSON.parse(r.content[0].text)

test('end to end: MCP auth, sessions, gate tiers, approvals, lineage, tasks', async () => {
  const env = setup(18790)
  try {
    // ── auth ──
    const noToken = await fetch(env.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    assert.equal(noToken.status, 401)
    const browser = await fetch(env.url, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example', authorization: `Bearer ${env.token}` }, body: '{}' })
    assert.equal(browser.status, 403)
    const textPlain = await fetch(env.url, { method: 'POST', headers: { 'content-type': 'text/plain', authorization: `Bearer ${env.token}` }, body: '{}' })
    assert.equal(textPlain.status, 415)

    const client = await connect(env.url, env.token)
    const tools = (await client.listTools()).tools.map(t => t.name)
    assert.ok(tools.includes('djy_session_create') && tools.includes('djy_approval_decide'))

    // ── session outside roots is refused; inside works with preset applied ──
    const outside = await client.callTool({ name: 'djy_session_create', arguments: { cwd: env.dir } })
    assert.equal(outside.isError, true)
    const created = parse(await client.callTool({ name: 'djy_session_create', arguments: { cwd: env.ws, role: 'implementer', title: 'S0' } }))
    assert.equal(created.ok, true)
    assert.equal(created.route.provider, 'relay')
    const sid = created.sessionId as string
    assert.equal(env.host.presets.get(sid), 'workspace-write')
    const listed = parse(await client.callTool({ name: 'djy_session_list', arguments: {} }))
    assert.equal(listed[0].createdBy, 'claude', 'creator recorded from MCP clientInfo')
    assert.match(listed[0].title, /^\[claude\] S0$/)
    // sessions are not capped by default: idle sessions cost nothing
    for (let i = 0; i < 9; i++) {
      const extra = parse(await client.callTool({ name: 'djy_session_create', arguments: { cwd: env.ws, role: 'implementer' } }))
      assert.equal(extra.ok, true, `session ${i + 2} created`)
    }
    assert.equal(parse(await client.callTool({ name: 'djy_session_list', arguments: {} })).length, 10)
    const agent = env.host.agentsById.get(sid) as FakeAgent

    // ── gate tiers on the dispatched session ──
    assert.equal((await env.host.preExecute(agent, 'write', { file_path: path.join(env.ws, 'a.txt'), content: 'x' })).kind, 'allow')
    assert.equal((await env.host.preExecute(agent, 'read', { file_path: path.join(process.env['USERPROFILE'] ?? process.env['HOME'] ?? '/', '.dsh', '.credentials.yaml') })).kind, 'deny')
    assert.equal((await env.host.preExecute(agent, 'run_code', { code: 'x' })).kind, 'deny')

    // escalate → approve through MCP
    const pending = env.host.preExecute(agent, 'pwsh', { command: 'git clone https://example.com/x' })
    await new Promise(r => setTimeout(r, 50))
    const list = parse(await client.callTool({ name: 'djy_approvals_list', arguments: {} }))
    assert.equal(list.length, 1)
    assert.equal(list[0].rule, 'git-network')
    await client.callTool({ name: 'djy_approval_decide', arguments: { id: list[0].id, decision: 'allow', reason: 'public repo, read only' } })
    assert.equal((await pending).kind, 'allow')
    const again = await client.callTool({ name: 'djy_approval_decide', arguments: { id: list[0].id, decision: 'deny', reason: 'x' } })
    assert.equal(again.isError, true, 'second decision refused')
    // A late note is not silently dropped: the reply says who settled it and what became of the note.
    const late = parse(await client.callTool({ name: 'djy_approval_decide', arguments: { id: list[0].id, decision: 'allow', reason: 'x', note: 'use the mirror' } }))
    assert.match(late.error, /already settled \(allow by /)
    assert.match(late.note, /not delivered: no running task/)

    // escalate → deny carries the reason to the worker
    const pending2 = env.host.preExecute(agent, 'pwsh', { command: 'npm install' })
    await new Promise(r => setTimeout(r, 50))
    const [p2] = parse(await client.callTool({ name: 'djy_approvals_list', arguments: {} }))
    await client.callTool({ name: 'djy_approval_decide', arguments: { id: p2.id, decision: 'deny', reason: 'use the venv instead' } })
    const d2 = await pending2
    assert.equal(d2.kind, 'deny')
    assert.match((d2 as { reason: string }).reason, /use the venv instead/)

    // ── child sessions inherit the gate; the user's own sessions do not ──
    const child = agent.spawnChild('child-1')
    assert.equal((await env.host.preExecute(child, 'write', { file_path: path.join(env.dir, 'outside.txt'), content: '' })).kind, 'deny')
    // timeout on a child (approval policy never) → deny, not ask
    assert.equal((await env.host.preExecute(child, 'mystery_tool', {})).kind, 'deny')
    const manual = await env.host.ctx.agents.create({ sessionId: 'manual', meta: { cwd: env.dir } })
    assert.equal((await env.host.preExecute(manual.agent, 'write', { file_path: path.join(env.dir, 'x'), content: '' })).kind, 'allow')
    // timeout on a root session → a safe deny telling the worker to defer the step (no desktop ask by default)
    // (a different call: the child's identical call above already timed out once in this task)
    const timedOut = await env.host.preExecute(agent, 'mystery_tool', { x: 1 })
    assert.equal(timedOut.kind, 'deny')
    assert.match((timedOut as { reason: string }).reason, /approval-timeout.*submit this exact call once more near the end/)

    // ── a task runs, its tool calls go through the gate, the summary is parsed ──
    env.host.scripts.set('make data', [
      { tool: 'write', args: { file_path: path.join(env.ws, 'data.json'), content: '{}' } },
      { tool: 'pwsh', args: { command: '.\\bench_all.ps1' } },
    ])
    const submitted = parse(await client.callTool({ name: 'djy_task_submit', arguments: { sessionId: sid, prompt: 'make data' } }))
    let task: any
    for (let i = 0; i < 50; i++) {
      task = parse(await client.callTool({ name: 'djy_task_get', arguments: { taskId: submitted.taskId } }))
      if (task.status === 'done' || task.status === 'error') break
      await new Promise(r => setTimeout(r, 20))
    }
    assert.equal(task.status, 'done')
    assert.equal(task.result.summary.changes, 'wrote data')
    assert.equal(task.result.toolCalls.length, 2, 'the task waited for the turn instead of returning at once')
    // The gate's own record: the write ran (with its result), the benchmark without a lease was refused.
    assert.deepEqual(task.evidence.calls, { allowed: 1, approved: 0, denied: 1 })
    assert.equal(task.evidence.commands[0].tool, 'write')
    assert.equal(task.evidence.commands[0].ok, true)
    const sent = agent.received.at(-1) as { source: { kind: string; taskId: string } }
    assert.equal(sent.source.kind, 'dujiangyan-dispatch', 'v4 needs a producer-owned source kind')
    assert.equal(sent.source.taskId, submitted.taskId)

    // events_watch works with no arguments (defaults applied server-side)
    const bare = await client.callTool({ name: 'djy_events_watch', arguments: {} })
    assert.notEqual(bare.isError, true)
    const guide = parse(await client.callTool({ name: 'djy_guide', arguments: {} }))
    assert.ok(guide.pitfalls.length >= 5)
    assert.equal(agent.decisions.find(d => d.tool === 'pwsh')?.decision.kind, 'deny', 'bench script without the lease is denied')

    // ── with the bench lease the same script is allowed ──
    agent.decisions.length = 0
    const benchTask = parse(await client.callTool({ name: 'djy_task_submit', arguments: { sessionId: sid, prompt: 'make data', resources: ['bench'] } }))
    for (let i = 0; i < 50; i++) {
      task = parse(await client.callTool({ name: 'djy_task_get', arguments: { taskId: benchTask.taskId } }))
      if (task.status === 'done' || task.status === 'error') break
      await new Promise(r => setTimeout(r, 20))
    }
    assert.equal(task.status, 'done')
    assert.equal(agent.decisions.find(d => d.tool === 'pwsh')?.decision.kind, 'allow')
    const locks = parse(await client.callTool({ name: 'djy_locks_list', arguments: {} }))
    assert.equal(locks.length, 0, 'lease released after the task')

    // ── events are watchable with a cursor ──
    const watched = parse(await client.callTool({ name: 'djy_events_watch', arguments: { cursor: 0, waitSeconds: 0 } }))
    const types = new Set(watched.events.map((e: any) => e.type))
    // `bench` (the default mode) takes the machine for the benchmark command only, not for the task.
    for (const t of ['session/created', 'gate/decision', 'approval/pending', 'approval/settled', 'task/done', 'bench/acquired', 'bench/released']) assert.ok(types.has(t), t)
    assert.ok(!types.has('lease/acquired'), 'no task-long lease in bench mode')
    await client.close()
  } finally {
    env.host.dispose()
    await new Promise(r => setTimeout(r, 50))
    rmSync(env.dir, { recursive: true, force: true })
  }
})

test('a listed-but-unusable route is probed, benched, and failed over to the next route', async () => {
  const env = setup(18792)
  try {
    env.host.validRoutes.add('relay/broken-model')
    env.host.brokenRoutes.add('relay/broken-model')
    const client = await connect(env.url, env.token)

    // 1. probe: listed in the catalog, but a real request fails deterministically
    const probe = parse(await client.callTool({ name: 'djy_routes_probe', arguments: { provider: 'relay', models: ['broken-model', 'model-b'] } }))
    assert.deepEqual(probe.map((p: any) => [p.route, p.ok]), [['relay/broken-model', false], ['relay/model-b', true]])
    let status = parse(await client.callTool({ name: 'djy_status', arguments: {} }))
    assert.ok(status.routeHealth.broken['relay/broken-model'])
    assert.equal(status.routeHealth.broken['relay/model-b'], undefined)
    // health block: nothing pending, nothing stalled, AI approval off
    assert.equal(status.health.pendingApprovals, 0)
    assert.deepEqual(status.health.alerts, [])
    assert.equal(status.health.ai.enabled, false)
    assert.equal(typeof status.health.orchestratorLastSeenSec, 'number', 'the MCP call itself counts as orchestrator presence')
    const ai = parse(await client.callTool({ name: 'djy_ai_approval_get', arguments: {} }))
    assert.equal(ai.health.degraded, false)

    // 2. a session whose only route is benched is refused up front
    const refused = await client.callTool({ name: 'djy_session_create', arguments: { cwd: env.ws, route: { provider: 'relay', model: 'broken-model' } } })
    assert.equal(refused.isError, true)

    // 3. mid-session: the active route starts returning 400 → bench it, retry the step, switch down the chain
    const created = parse(await client.callTool({ name: 'djy_session_create', arguments: { cwd: env.ws, role: 'implementer' } }))
    const agent = env.host.agentsById.get(created.sessionId) as FakeAgent
    const request = () => env.host.waterfall<any>('agent/request', [{ agent }], async () => ({ provider: 'relay', model: 'model-b' }))
    const requestError = (failure: unknown) => env.host.waterfall<any>('agent/request-error', [{ agent, provider: 'relay', failure }], async () => undefined)
    assert.equal((await request()).model, 'model-b')
    const action = await requestError({ status: 400, code: 'BAD_REQUEST', message: 'Unknown name "anthropic_version"' })
    assert.deepEqual(action, { kind: 'retry' })
    const switched = await request()
    assert.equal(`${switched.provider}/${switched.model}`, 'deepseek-official/deepseek-flash')
    status = parse(await client.callTool({ name: 'djy_status', arguments: {} }))
    assert.ok(status.routeHealth.broken['relay/model-b'])

    // 4. a prompt-size 400 is not the route's fault: no benching, the failure surfaces normally
    assert.equal(await requestError({ status: 400, message: 'This model maximum context length is 128000 tokens' }), undefined)
    status = parse(await client.callTool({ name: 'djy_status', arguments: {} }))
    assert.equal(status.routeHealth.broken['deepseek-official/deepseek-flash'], undefined)

    // 5. at most one failover per request: a second deterministic failure right after the switch surfaces
    const three = parse(await client.callTool({ name: 'djy_session_create', arguments: { cwd: env.ws, route: { provider: 'deepseek-official', model: 'deepseek-v4-pro', effort: 'high' }, fallbacks: [{ provider: 'deepseek-official', model: 'deepseek-flash' }] } }))
    const agent3 = env.host.agentsById.get(three.sessionId) as FakeAgent
    const request3 = () => env.host.waterfall<any>('agent/request', [{ agent: agent3 }], async () => ({ provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' }))
    const error3 = () => env.host.waterfall<any>('agent/request-error', [{ agent: agent3, provider: 'deepseek-official', failure: { status: 404, message: 'model not found' } }], async () => undefined)
    await request3()
    assert.deepEqual(await error3(), { kind: 'retry' })
    const moved = await request3()
    assert.equal(moved.model, 'deepseek-flash')
    assert.equal(moved.reasoningEffort, undefined, 'the effort id of the previous route is dropped on failover')
    assert.equal(await error3(), undefined, 'no second failover within the same request')

    const events = parse(await client.callTool({ name: 'djy_events_watch', arguments: { cursor: 0, waitSeconds: 0 } }))
    assert.ok(events.events.some((e: any) => e.type === 'route/broken'))
    assert.ok(events.events.some((e: any) => e.type === 'route/switch' && e.data.reason === 'route-broken'))
    await client.close()
  } finally {
    env.host.dispose()
    await new Promise(r => setTimeout(r, 50))
    rmSync(env.dir, { recursive: true, force: true })
  }
})

test('rate limits open the breaker and divert dispatched sessions to the fallback route', async () => {
  const env = setup(18791)
  try {
    const client = await connect(env.url, env.token)
    const created = parse(await client.callTool({ name: 'djy_session_create', arguments: { cwd: env.ws, role: 'implementer' } }))
    const agent = env.host.agentsById.get(created.sessionId) as FakeAgent

    const request = (provider: string, model: string) =>
      env.host.waterfall<any>('agent/request', [{ agent }], async () => ({ provider, model, reasoningEffort: 'high' }))

    assert.deepEqual(await request('relay', 'model-b'), { provider: 'relay', model: 'model-b', reasoningEffort: 'high' })
    await env.host.stream('relay', 'model-b', { kind: 'error', failure: { status: 429, providerRetryAfterMs: 10 } })
    await env.host.stream('relay', 'model-b', { kind: 'error', failure: { status: 429 } })
    const status = parse(await client.callTool({ name: 'djy_status', arguments: {} }))
    assert.equal(status.providers.relay.circuit, 'open')
    assert.equal(status.providers.relay.cap, 1)

    const diverted = await request('relay', 'model-b')
    assert.equal(diverted.provider, 'deepseek-official')
    assert.equal(diverted.model, 'deepseek-flash')
    assert.equal(diverted.reasoningEffort, undefined, 'effort dropped when switching models')

    // the user's own session keeps its route
    const manual = await env.host.ctx.agents.create({ sessionId: 'manual2', meta: { cwd: env.dir } })
    const kept = await env.host.waterfall<any>('agent/request', [{ agent: manual.agent }], async () => ({ provider: 'relay', model: 'model-b' }))
    assert.equal(kept.provider, 'relay')

    const usage = status.usage['relay/model-b']
    assert.equal(usage.requests, 2)
    assert.equal(usage.cacheHitTokens, 160)
    await client.close()
  } finally {
    env.host.dispose()
    await new Promise(r => setTimeout(r, 50))
    rmSync(env.dir, { recursive: true, force: true })
  }
})

test('desktop archive state: archived/missing sessions are flagged and refuse new tasks; batches label each run', async () => {
  const env = setup(18795)
  const archived: string[] = []
  const workspaceSessions: string[] = []
  const baseGet = env.host.ctx.get
  ;(env.host.ctx as any).get = (name: string) => name === 'workspaceRegistry'
    ? { archivedSessionIds: archived, list: () => [{ path: env.ws, sessionIds: workspaceSessions }], resolveByPath: async () => ({ path: env.ws, attachSession: async (id: string) => { workspaceSessions.push(id) } }) }
    : baseGet(name)
  try {
    const client = await connect(env.url, env.token)
    const a = parse(await client.callTool({ name: 'djy_session_create', arguments: { cwd: env.ws, role: 'implementer' } }))
    const b = parse(await client.callTool({ name: 'djy_session_create', arguments: { cwd: env.ws, role: 'implementer', batch: 'nightly' } }))
    let list = parse(await client.callTool({ name: 'djy_session_list', arguments: {} }))
    const byId = (id: string) => list.find((s: any) => s.sessionId === id)
    assert.match(byId(a.sessionId).batch, /^claude · \d\d-\d\d \d\d:\d\d$/, 'default batch = this connection')
    assert.equal(byId(b.sessionId).batch, 'nightly')
    assert.equal(byId(a.sessionId).desktop, 'active')

    archived.push(a.sessionId) // the user archives it in the sidebar
    list = parse(await client.callTool({ name: 'djy_session_list', arguments: {} }))
    assert.equal(byId(a.sessionId).desktop, 'archived')
    const refused = await client.callTool({ name: 'djy_task_submit', arguments: { sessionId: a.sessionId, prompt: 'x' } })
    assert.equal(refused.isError, true)

    workspaceSessions.splice(workspaceSessions.indexOf(b.sessionId), 1) // gone from every workspace
    list = parse(await client.callTool({ name: 'djy_session_list', arguments: {} }))
    assert.equal(byId(b.sessionId).desktop, 'missing')
    await client.close()
  } finally {
    env.host.dispose()
    await new Promise(r => setTimeout(r, 50))
    rmSync(env.dir, { recursive: true, force: true })
  }
})

test('findings 59: a route that renames tools is benched after two foreign calls; with no route left the task ends as an error', async () => {
  const env = setup(18803)
  try {
    const client = await connect(env.url, env.token)
    // With a fallback: the next request of the turn moves down the chain.
    const created = parse(await client.callTool({ name: 'djy_session_create', arguments: { cwd: env.ws, role: 'implementer' } }))
    const agent = env.host.agentsById.get(created.sessionId) as FakeAgent
    const request = () => env.host.waterfall<any>('agent/request', [{ agent }], async () => ({ provider: 'relay', model: 'model-b' }))
    assert.equal((await request()).model, 'model-b')
    const first = await env.host.preExecute(agent, 'Bash', { command: 'ls' })
    assert.equal(first.kind, 'deny')
    assert.match((first as { reason?: string }).reason ?? '', /rewriting tool names/)
    let status = parse(await client.callTool({ name: 'djy_status', arguments: {} }))
    assert.equal(status.routeHealth.broken['relay/model-b'], undefined, 'one foreign call is not enough')
    await env.host.preExecute(agent, 'Read', { file_path: 'x' })
    status = parse(await client.callTool({ name: 'djy_status', arguments: {} }))
    assert.match(status.routeHealth.broken['relay/model-b'].reason, /rewrites tool names/)
    assert.equal((await request()).model, 'deepseek-flash')

    // No fallback: the running task ends as an error, not done.
    env.host.validRoutes.add('relay/model-c')
    const lone = parse(await client.callTool({ name: 'djy_session_create', arguments: { cwd: env.ws, route: { provider: 'relay', model: 'model-c' } } }))
    const loneAgent = env.host.agentsById.get(lone.sessionId) as FakeAgent
    await env.host.waterfall<any>('agent/request', [{ agent: loneAgent }], async () => ({ provider: 'relay', model: 'model-c' }))
    env.host.scripts.set('renamed tools', [{ tool: 'Bash', args: { command: 'ls' } }, { tool: 'Write', args: { file_path: 'a', content: 'b' } }, { tool: 'Bash', args: { command: 'ls' } }])
    const t = parse(await client.callTool({ name: 'djy_task_submit', arguments: { sessionId: lone.sessionId, prompt: 'renamed tools' } }))
    let task: any
    for (let i = 0; i < 200; i++) {
      task = parse(await client.callTool({ name: 'djy_task_get', arguments: { taskId: t.taskId } }))
      if (task.status !== 'queued' && task.status !== 'running') break
      await new Promise(r => setTimeout(r, 10))
    }
    assert.equal(task.status, 'error')
    assert.match(task.error, /relay\/model-c rewrites tool names/)
    const events = parse(await client.callTool({ name: 'djy_events_watch', arguments: { cursor: 0, waitSeconds: 0 } })).events
    assert.ok(events.some((e: any) => e.type === 'route/foreign-tools' && e.data.argumentNames.includes('command')), 'evidence for the gateway report')
    await client.close()
  } finally {
    env.host.dispose()
    await new Promise(r => setTimeout(r, 50))
    rmSync(env.dir, { recursive: true, force: true })
  }
})
