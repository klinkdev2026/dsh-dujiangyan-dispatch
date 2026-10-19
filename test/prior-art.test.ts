import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { apply } from '../src/index.ts'
import { canonicalPath } from '../src/paths.ts'
import { FakeHost, type FakeAgent } from './fake-host.ts'

// Problems other DSH plugins hit first (dsh-crew, dsh-agent-teams, dsh-auto-review), checked end to end.

function setup(port: number) {
  const dir = mkdtempSync(path.join(tmpdir(), 'djy-prior-'))
  const ws = path.join(dir, 'ws')
  mkdirSync(path.join(ws, 'proj-a'), { recursive: true })
  mkdirSync(path.join(ws, 'proj-b'), { recursive: true })
  const host = new FakeHost()
  apply(host.ctx, {
    port,
    stateDir: path.join(dir, 'state'),
    workspaceRoots: [ws],
    approvalTimeoutMs: 5000,
    preflight: false,
    roster: { implementer: [{ provider: 'relay', model: 'model-b' }] },
    limits: { providers: { relay: { maxConcurrent: 4, minSpacingMs: 0, jitterMs: 0 } } },
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
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const fwd = (p: string) => p.replace(/\\/g, '/')

async function waitTask(client: Client, taskId: string, done = (s: string) => !['queued', 'running', 'waiting_resources', 'waiting_slot'].includes(s)) {
  for (let i = 0; i < 400; i++) {
    const t = parse(await client.callTool({ name: 'djy_task_get', arguments: { taskId } }))
    if (done(t.status)) return t
    await sleep(10)
  }
  throw new Error(`task ${taskId} did not settle`)
}

test('a worker question ends the task as needs_input instead of hanging', async () => {
  const env = setup(18810)
  try {
    const client = await connect(env.url, env.token)
    const s = parse(await client.callTool({ name: 'djy_session_create', arguments: { cwd: env.ws, role: 'implementer' } }))
    env.host.scripts.set('ASKQ', [{ tool: 'ask', args: {}, ask: [{ id: 'q1', question: 'Overwrite the existing results?', options: [{ label: 'Yes' }, { label: 'No' }] }] }])
    const sub = parse(await client.callTool({ name: 'djy_task_submit', arguments: { sessionId: s.sessionId, prompt: 'ASKQ do it' } }))
    const t = await waitTask(client, sub.taskId)
    assert.equal(t.status, 'needs_input')
    assert.equal(t.questions[0].question, 'Overwrite the existing results?')
    assert.deepEqual(t.questions[0].options.map((o: any) => o.label), ['Yes', 'No'])
    assert.equal((env.host.agentsById.get(s.sessionId) as FakeAgent).cancelled, true, 'the turn is stopped, not left waiting')
    const qs = parse(await client.callTool({ name: 'djy_questions_list', arguments: {} }))
    assert.equal(qs[0].taskId, sub.taskId)
    const events = parse(await client.callTool({ name: 'djy_events_watch', arguments: { cursor: 0, waitSeconds: 0 } }))
    assert.ok(events.events.some((e: any) => e.type === 'task/needs-input'))
    await client.close()
  } finally {
    env.host.dispose()
    await sleep(30)
    rmSync(env.dir, { recursive: true, force: true })
  }
})

test('per-session write scope: a session in a subfolder cannot write its neighbours', async () => {
  const env = setup(18811)
  try {
    const client = await connect(env.url, env.token)
    const a = parse(await client.callTool({ name: 'djy_session_create', arguments: { cwd: path.join(env.ws, 'proj-a'), role: 'implementer' } }))
    assert.deepEqual(a.writeScope.map(fwd), [fwd(canonicalPath(path.join(env.ws, 'proj-a')))])
    const agent = env.host.agentsById.get(a.sessionId) as FakeAgent
    const write = (p: string) => env.host.preExecute(agent, 'write', { file_path: p, content: 'x' })
    assert.equal((await write(path.join(env.ws, 'proj-a', 'out.txt'))).kind, 'allow')
    const other = await write(path.join(env.ws, 'proj-b', 'src.rs'))
    assert.equal(other.kind, 'deny')
    assert.match((other as any).reason, /write-outside-scope/)
    assert.equal((await write(path.join(env.ws, 'proj-a', '..', 'proj-b', 'x.rs'))).kind, 'deny', '.. cannot escape the scope')
    const shell = await env.host.preExecute(agent, 'pwsh', { command: `Remove-Item ${fwd(path.join(env.ws, 'proj-b'))}/*.rs` })
    assert.equal(shell.kind, 'deny')
    assert.match((shell as any).reason, /write-outside-scope/)
    assert.match((await write(path.join(env.dir, 'elsewhere.txt')) as any).reason, /write-outside-root/)
    // the scope survives in the registry; explicit scopes must stay inside the roots
    const listed = parse(await client.callTool({ name: 'djy_session_list', arguments: {} }))
    assert.ok(listed.find((x: any) => x.sessionId === a.sessionId).writeScope)
    const bad = await client.callTool({ name: 'djy_session_create', arguments: { cwd: env.ws, role: 'implementer', writeScope: [env.dir] } })
    assert.equal(bad.isError, true)
    // a session at the root keeps the old behaviour (whole roots)
    const root = parse(await client.callTool({ name: 'djy_session_create', arguments: { cwd: env.ws, role: 'implementer' } }))
    assert.equal(root.writeScope, undefined)
    assert.equal((await env.host.preExecute(env.host.agentsById.get(root.sessionId) as FakeAgent, 'write', { file_path: path.join(env.ws, 'proj-b', 'y'), content: '' })).kind, 'allow')
    await client.close()
  } finally {
    env.host.dispose()
    await sleep(30)
    rmSync(env.dir, { recursive: true, force: true })
  }
})

test('steer: notes reach a running worker; nothing is sent to an idle one', async () => {
  const env = setup(18812)
  try {
    const client = await connect(env.url, env.token)
    const s = parse(await client.callTool({ name: 'djy_session_create', arguments: { cwd: env.ws, role: 'implementer' } }))
    const idle = await client.callTool({ name: 'djy_session_steer', arguments: { sessionId: s.sessionId, message: 'hello' } })
    assert.equal(idle.isError, true)
    env.host.scripts.set('SLOW', [{ tool: 'pwsh', args: { command: 'frobnicate --x' } }])
    const sub = parse(await client.callTool({ name: 'djy_task_submit', arguments: { sessionId: s.sessionId, prompt: 'SLOW work' } }))
    let pending: any[] = []
    for (let i = 0; i < 200 && pending.length === 0; i++) {
      pending = parse(await client.callTool({ name: 'djy_approvals_list', arguments: {} }))
      await sleep(10)
    }
    const steered = parse(await client.callTool({ name: 'djy_session_steer', arguments: { sessionId: s.sessionId, message: 'use the venv python' } }))
    assert.equal(steered.delivered, true)
    const decided = parse(await client.callTool({ name: 'djy_approval_decide', arguments: { id: pending[0].id, decision: 'allow', reason: 'fine', note: 'next time write probes as files' } }))
    assert.equal(decided.note, 'delivered')
    const agent = env.host.agentsById.get(s.sessionId) as FakeAgent
    const texts = agent.steered.map(m => JSON.stringify(m))
    assert.ok(texts.some(t => t.includes('use the venv python')))
    assert.ok(texts.some(t => t.includes('next time write probes as files')))
    assert.equal((await waitTask(client, sub.taskId)).status, 'done')
    await client.close()
  } finally {
    env.host.dispose()
    await sleep(30)
    rmSync(env.dir, { recursive: true, force: true })
  }
})

test('deny circuit breaker: repeated denials pause the task as needs_attention', async () => {
  const env = setup(18813)
  try {
    const client = await connect(env.url, env.token)
    const s = parse(await client.callTool({ name: 'djy_session_create', arguments: { cwd: env.ws, role: 'implementer' } }))
    const push = { tool: 'pwsh', args: { command: 'git push' } }
    env.host.scripts.set('PUSHY', [push, { tool: 'pwsh', args: { command: 'git  push origin' } }, { tool: 'pwsh', args: { command: 'git push --force' } }, push])
    const sub = parse(await client.callTool({ name: 'djy_task_submit', arguments: { sessionId: s.sessionId, prompt: 'PUSHY ship it' } }))
    const t = await waitTask(client, sub.taskId)
    assert.equal(t.status, 'needs_attention')
    assert.match(t.attention, /repeated denials/)
    const agent = env.host.agentsById.get(s.sessionId) as FakeAgent
    assert.match((agent.decisions[0]?.decision as any).reason, /^\[dujiangyan-denied:git-remote\].*Do not retry the same action with a different formulation/)
    assert.ok(agent.decisions.length <= 3, 'the turn stops at the breaker')
    const events = parse(await client.callTool({ name: 'djy_events_watch', arguments: { cursor: 0, waitSeconds: 0 } }))
    assert.ok(events.events.some((e: any) => e.type === 'task/deny-breaker'))
    // a new task starts with a clean breaker
    env.host.scripts.set('CLEAN', [{ tool: 'read', args: { file_path: path.join(env.ws, 'a.txt') } }])
    const next = parse(await client.callTool({ name: 'djy_task_submit', arguments: { sessionId: s.sessionId, prompt: 'CLEAN read' } }))
    assert.equal((await waitTask(client, next.taskId)).status, 'done')
    await client.close()
  } finally {
    env.host.dispose()
    await sleep(30)
    rmSync(env.dir, { recursive: true, force: true })
  }
})
