import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mergeRules, parseLocalRules } from '../src/local-rules.ts'
import { MAX_KNOWN_WAIT_MS } from '../src/watchdog.ts'

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')

// The rule engine and the admission controller are the host-independent core (Kimi review): they
// may use each other's pure helpers and node built-ins, never the host, tasks, MCP or the gate.
const CORE: Readonly<Record<string, readonly string[]>> = {
  'rules.ts': ['./paths.ts'],
  'paths.ts': [],
  'limiter.ts': [],
}

test('the pure core imports nothing host- or orchestration-specific', () => {
  for (const [file, allowed] of Object.entries(CORE)) {
    const text = readFileSync(path.join(src, file), 'utf8')
    const specifiers = [...text.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map(m => m[1] as string)
    for (const s of specifiers) {
      assert.ok(s.startsWith('node:') || allowed.includes(s), `${file} imports ${s}; the core must stay host-independent`)
    }
  }
})

test('local-rules: a pattern in both the profile config and the file is listed once', () => {
  const bench = ['[\\\\/]measure\\.exe\\b', 'run_all\\.ps1\\b']
  const merged = mergeRules({ benchPatterns: bench, allowCommands: ['gci'] }, [
    { rules: { benchPatterns: [...bench, 'extra\\.exe'], allowCommands: ['gci', 'gc'], allowEnv: [{ name: 'PATH', prepend: ['C:/P'] }] } },
    { rules: { allowEnv: [{ name: 'PATH', prepend: ['C:/P'] }] } },
  ])
  assert.deepEqual(merged.benchPatterns, [...bench, 'extra\\.exe'])
  assert.deepEqual(merged.allowCommands, ['gci', 'gc'])
  assert.equal(merged.allowEnv?.length, 1)
})

test('local-rules: allowEnv and allowPrograms are validated and merged across layers', () => {
  const ok = parseLocalRules(JSON.stringify({
    rules: { allowEnv: [{ name: 'PATH', prepend: ['C:/Python313'] }] },
    workspaces: { 'D:/ws': { rules: { allowPrograms: [{ path: 'C:/Apps/k.exe', args: '^-b\\b', scriptFlag: '-r' }], allowEnv: [{ name: 'PYTHONHOME', values: ['C:/Python313'] }] } } },
  }))
  assert.equal(ok.ok, true)
  if (!ok.ok) return
  const merged = mergeRules({}, [ok.value, ok.value.workspaces?.['D:/ws'] ?? {}])
  assert.deepEqual(merged.allowEnv?.map(e => e.name), ['PATH', 'PYTHONHOME'])
  assert.equal(merged.allowPrograms?.[0]?.path, 'C:/Apps/k.exe')

  const bad: Array<[unknown, RegExp]> = [
    [{ rules: { allowEnv: [{ name: 'PATH' }] } }, /give prepend, append or values/],
    [{ rules: { allowEnv: [{ name: 'PA TH', values: ['x'] }] } }, /environment variable name/],
    [{ rules: { allowEnv: [{ name: 'PATH', prepend: 'C:/x' }] } }, /prepend: expected an array/],
    [{ rules: { allowEnv: [{ name: 'PATH', values: ['x'], extra: 1 }] } }, /unknown key "extra"/],
    [{ rules: { allowPrograms: [{ path: 'klayout.exe' }] } }, /absolute path/],
    [{ rules: { allowPrograms: [{ path: 'C:/k.exe', args: '(' }] } }, /invalid regular expression/],
    [{ rules: { allowPrograms: [{ path: 'C:/k.exe', scriptFlag: 'r' }] } }, /scriptFlag/],
    [{ rules: { allowPrograms: { path: 'C:/k.exe' } } }, /expected an array/],
  ]
  for (const [value, re] of bad) {
    const r = parseLocalRules(JSON.stringify(value))
    assert.equal(r.ok, false, JSON.stringify(value))
    if (!r.ok) assert.match(r.error, re)
  }
})

test('the stall alarm can be excused by a call\'s own timeout for at most an hour', () => {
  assert.equal(MAX_KNOWN_WAIT_MS, 60 * 60_000)
})
