import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resolveConfig } from '../src/config.ts'
import { EventLog } from '../src/events.ts'
import { DispatchRegistry } from '../src/registry.ts'
import { SessionManager } from '../src/sessions.ts'
import { FakeHost } from './fake-host.ts'

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'djy-resume-'))
  const ws = path.join(dir, 'ws')
  mkdirSync(ws)
  const host = new FakeHost()
  const config = resolveConfig({ stateDir: path.join(dir, 'state'), workspaceRoots: [ws], preflight: false })
  const registry = new DispatchRegistry(host.ctx, path.join(dir, 'state'))
  return { dir, ws, host, config, registry }
}

// Regression: after a desktop restart an idle session was resumed without its route, so the
// persona section's {{model}} had no value and every turn failed; the preset was not re-applied.
test('cold resume re-sends the saved route and re-applies the permission preset', async () => {
  const env = setup()
  try {
    const before = new SessionManager(env.host.ctx, env.config, env.registry, new EventLog(undefined))
    const created = await before.create({ cwd: env.ws, route: { provider: 'relay', model: 'model-b' }, fallbacks: [{ provider: 'deepseek-official', model: 'deepseek-flash' }] })
    assert.equal(created.ok, true)
    const sid = created.ok ? created.sessionId : ''

    // Simulate a restart: a fresh manager, the host no longer holds the live agent, presets forgotten.
    env.host.agentsById.delete(sid)
    env.host.presets.clear()
    const after = new SessionManager(env.host.ctx, env.config, env.registry, new EventLog(undefined))
    const agent = await after.agent(sid)

    assert.equal(env.host.resumeCalls.length, 1)
    assert.deepEqual(env.host.resumeCalls[0]?.agentOptions, { provider: 'relay', model: 'model-b' })
    assert.equal(env.host.presets.get(agent.session.id), 'workspace-write')
  } finally {
    rmSync(env.dir, { recursive: true, force: true })
  }
})

test('cold resume refuses the session when the permission preset cannot be re-applied', async () => {
  const env = setup()
  try {
    const before = new SessionManager(env.host.ctx, env.config, env.registry, new EventLog(undefined))
    const created = await before.create({ cwd: env.ws, route: { provider: 'relay', model: 'model-b' } })
    const sid = created.ok ? created.sessionId : ''
    env.host.agentsById.delete(sid)
    const realGet = env.host.ctx.get
    env.host.ctx.get = name => (name === 'permissionPresets' ? { set: () => { throw new Error('preset service unavailable') } } : realGet(name))
    const after = new SessionManager(env.host.ctx, env.config, env.registry, new EventLog(undefined))
    await assert.rejects(after.agent(sid), /refusing to resume/)
  } finally {
    rmSync(env.dir, { recursive: true, force: true })
  }
})
