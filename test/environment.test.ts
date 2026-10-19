import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describeFacts, measureFacts } from '../src/environment.ts'
import { hasLowLabel, preflightWorkspace } from '../src/preflight.ts'

test('environment facts: disk is measured, Windows sandbox notes only for win32 workspace-write, extras appended', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'djy-env-'))
  try {
    const win = describeFacts(measureFacts([dir], 'workspace-write', 'win32'), ['venv at ./.venv'])
    assert.match(win, /^\[dujiangyan\] Environment facts/)
    assert.match(win, /Disk, measured at task start: .* GB free/)
    assert.match(win, /SEC_E_NO_CREDENTIALS/)
    assert.match(win, /Named pipes/)
    assert.match(win, /- venv at \.\/\.venv$/m)
    const linux = describeFacts(measureFacts([dir], 'workspace-write', 'linux'))
    assert.doesNotMatch(linux, /Schannel|Named pipes/)
    const fullAccess = describeFacts(measureFacts([dir], 'full-access', 'win32'))
    assert.doesNotMatch(fullAccess, /Schannel/)
    // An unreadable root is skipped, not reported as 0 GB.
    assert.doesNotMatch(describeFacts(measureFacts([path.join(dir, 'missing')], 'workspace-write', 'linux')), /Disk/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('preflight: only Windows workspace-write is checked; directories without the Low label get a repair', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'djy-pre-'))
  try {
    mkdirSync(path.join(dir, 'ok'))
    mkdirSync(path.join(dir, 'bad'))
    mkdirSync(path.join(dir, 'node_modules'))
    const low = String.raw`x.txt Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)`
    const run = async (d: string) => (d.endsWith('bad') ? 'BUILTIN\Users:(RX)' : low)
    const issues = await preflightWorkspace(dir, 'workspace-write', 'win32', run)
    assert.deepEqual(issues.map(i => path.basename(i.path)), ['bad'])
    assert.match(issues[0]?.suggestion ?? '', /\/setintegritylevel \(OI\)\(CI\)L/)
    assert.deepEqual(await preflightWorkspace(dir, 'workspace-write', 'linux', run), [])
    assert.deepEqual(await preflightWorkspace(dir, 'full-access', 'win32', run), [])
    assert.equal(hasLowLabel(low), true)
    assert.equal(hasLowLabel(''), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
