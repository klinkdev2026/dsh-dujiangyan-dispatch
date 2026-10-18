import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { apply } from '../src/index.ts'
import { FakeHost, type FakeAgent } from './fake-host.ts'

type Handler = (req: any, res: any) => Promise<void>

function fakeRequest(method: string, url: string, body?: unknown) {
  const req = new PassThrough() as any
  req.method = method
  req.url = url
  req.headers = { 'content-type': 'application/json' }
  req.end(body === undefined ? '' : JSON.stringify(body))
  return req
}

function fakeResponse() {
  const res: any = { status: 0, body: '' }
  res.writeHead = (s: number) => { res.status = s; return res }
  res.end = (b?: string) => { res.body = b ?? '' }
  return res
}

test('panel routes: host auth fence, snapshot, approve from the panel', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'djy-web-'))
  const ws = path.join(dir, 'ws')
  mkdirSync(ws)
  const host = new FakeHost()
  const routes = new Map<string, Handler>()
  let rejection: number | undefined = 401
  const baseGet = host.ctx.get
  ;(host.ctx as any).get = (name: string) => {
    if (name === 'webServer') return { register: (r: { path: string; handler: Handler }) => { routes.set(r.path, r.handler); return () => routes.delete(r.path) } }
    if (name === 'connection') return { requestRejection: () => rejection }
    return baseGet(name)
  }
  try {
    apply(host.ctx, { port: 18793, stateDir: path.join(dir, 'state'), workspaceRoots: [ws], preflight: false, approvalTimeoutMs: 5000 })
    const state = routes.get('/plugins/dsh-dujiangyan-dispatch/state')
    const approval = routes.get('/plugins/dsh-dujiangyan-dispatch/approval')
    assert.ok(state && approval, 'routes registered')

    // unauthenticated browser → refused by the host fence
    let res = fakeResponse()
    await state(fakeRequest('GET', '/plugins/dsh-dujiangyan-dispatch/state'), res)
    assert.equal(res.status, 401)

    rejection = undefined
    res = fakeResponse()
    await state(fakeRequest('GET', '/plugins/dsh-dujiangyan-dispatch/state?cursor=0'), res)
    assert.equal(res.status, 200)
    const snap = JSON.parse(res.body)
    assert.ok(Array.isArray(snap.sessions) && Array.isArray(snap.approvals) && typeof snap.cursor === 'number')

    res = fakeResponse()
    await approval(fakeRequest('GET', '/plugins/dsh-dujiangyan-dispatch/approval'), res)
    assert.equal(res.status, 405)
    res = fakeResponse()
    await approval(fakeRequest('POST', '/plugins/dsh-dujiangyan-dispatch/approval', { id: 'nope', decision: 'allow' }), res)
    assert.equal(res.status, 409, 'unknown approval')
    res = fakeResponse()
    await approval(fakeRequest('POST', '/plugins/dsh-dujiangyan-dispatch/approval', { id: 'x', decision: 'maybe' }), res)
    assert.equal(res.status, 400)
  } finally {
    host.dispose()
    await new Promise(r => setTimeout(r, 50))
    rmSync(dir, { recursive: true, force: true })
  }
})

test('panel approval settles a real pending gate escalation, attributed to the human', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'djy-web2-'))
  const ws = path.join(dir, 'ws')
  mkdirSync(ws)
  const host = new FakeHost()
  const routes = new Map<string, Handler>()
  const baseGet = host.ctx.get
  ;(host.ctx as any).get = (name: string) => {
    if (name === 'webServer') return { register: (r: { path: string; handler: Handler }) => { routes.set(r.path, r.handler); return () => {} } }
    if (name === 'connection') return { requestRejection: () => undefined }
    return baseGet(name)
  }
  try {
    apply(host.ctx, { port: 18794, stateDir: path.join(dir, 'state'), workspaceRoots: [ws], preflight: false, approvalTimeoutMs: 5000 })
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
    const { readFileSync } = await import('node:fs')
    const token = readFileSync(path.join(dir, 'state', 'token'), 'utf8').trim()
    const client = new Client({ name: 'codex', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:18794/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
    const created = JSON.parse((await client.callTool({ name: 'djy_session_create', arguments: { cwd: ws, role: 'implementer' } }) as any).content[0].text)
    assert.match(created.ok ? 'ok' : '', /ok/)
    const agent = host.agentsById.get(created.sessionId) as FakeAgent
    const pending = host.preExecute(agent, 'pwsh', { command: 'git clone https://example.com/x' })
    await new Promise(r => setTimeout(r, 30))

    let res = fakeResponse()
    await routes.get('/plugins/dsh-dujiangyan-dispatch/state')!(fakeRequest('GET', '/plugins/dsh-dujiangyan-dispatch/state'), res)
    const snap = JSON.parse(res.body)
    assert.equal(snap.approvals.length, 1)
    assert.match(snap.sessions[0].title, /^\[codex\]/)

    res = fakeResponse()
    await routes.get('/plugins/dsh-dujiangyan-dispatch/approval')!(fakeRequest('POST', '/plugins/dsh-dujiangyan-dispatch/approval', { id: snap.approvals[0].id, decision: 'deny', reason: 'clone into vendor/ instead' }), res)
    assert.equal(res.status, 200)
    const decision = await pending
    assert.equal(decision.kind, 'deny')
    assert.match((decision as any).reason, /human \(desktop panel\) denied this call: clone into vendor\/ instead/)
    await client.close()
  } finally {
    host.dispose()
    await new Promise(r => setTimeout(r, 50))
    rmSync(dir, { recursive: true, force: true })
  }
})
