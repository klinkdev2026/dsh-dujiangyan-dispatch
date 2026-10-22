import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { hasLowLabel, preflightWorkspace } from '../src/preflight.ts'

// LESSONS 1 / findings 45, 52: directories without the Low integrity label are not writable by the
// sandboxed worker. The listing tool (icacls) is injected, so this runs on every platform.

const LOW = 'D:\\ws BUILTIN\\Users:(OI)(CI)(RX)\n    Mandatory Label\\Low Mandatory Level:(OI)(CI)(NW)\n'
const MEDIUM = 'D:\\ws BUILTIN\\Users:(OI)(CI)(RX)\n'

test('hasLowLabel reads the mandatory label line', () => {
  assert.equal(hasLowLabel(LOW), true)
  assert.equal(hasLowLabel(MEDIUM), false)
})

test('preflight lists the cwd and subdirectories without the label, skips build dirs, and never repairs', async t => {
  const ws = mkdtempSync(path.join(tmpdir(), 'djy-pre-'))
  t.after(() => rmSync(ws, { recursive: true, force: true }))
  for (const d of ['labeled', 'old/nested', 'target/release', 'node_modules/x', '.git/objects']) mkdirSync(path.join(ws, d), { recursive: true })
  const asked: string[] = []
  const unlabeled = new Set([ws, path.join(ws, 'old'), path.join(ws, 'old', 'nested')])
  const run = async (dir: string) => {
    asked.push(dir)
    return unlabeled.has(dir) ? MEDIUM : LOW
  }
  const issues = await preflightWorkspace(ws, 'workspace-write', 'win32', run)
  assert.deepEqual(issues.map(i => i.path).sort(), [...unlabeled].sort())
  assert.match(issues[0]?.suggestion ?? '', /setintegritylevel/)
  for (const skipped of ['target', 'node_modules', '.git']) assert.ok(!asked.some(d => d.includes(`${path.sep}${skipped}`)), `${skipped} is not walked`)
  // A listing that failed (empty output) is not reported as a problem.
  assert.deepEqual(await preflightWorkspace(ws, 'workspace-write', 'win32', async () => ''), [])
})

test('preflight only applies to the Windows workspace-write sandbox', async () => {
  const never = async () => { throw new Error('must not list') }
  assert.deepEqual(await preflightWorkspace('/ws', 'workspace-write', 'linux', never), [])
  assert.deepEqual(await preflightWorkspace('D:/ws', 'full-access', 'win32', never), [])
})
