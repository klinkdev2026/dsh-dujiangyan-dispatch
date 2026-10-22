import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSummary } from '../src/tasks.ts'

test('summary: values containing braces are parsed (seen from glm-5.3)', () => {
  const text = 'Report above.\n\n{"changes":"region.rs","verification":"corpus 25 x {1,20} threads 0 diffs","leftovers":"rerun 25×{1,8,20}"}'
  assert.deepEqual(parseSummary(text), { changes: 'region.rs', verification: 'corpus 25 x {1,20} threads 0 diffs', leftovers: 'rerun 25×{1,8,20}' })
})

test('summary: the last summary object wins; braces in earlier code and escaped quotes are skipped', () => {
  const text = 'fn f() { let a = {}; }\n{"changes":"old"}\n```json\n{"changes":"x \\"q\\" }","verification":"ok","leftovers":""}\n```'
  assert.deepEqual(parseSummary(text), { changes: 'x "q" }', verification: 'ok', leftovers: '' })
})

test('summary: list values are joined, Chinese keys accepted, missing JSON gives empty fields', () => {
  assert.deepEqual(parseSummary('{"改动":["a","b"],"验证":"v"}'), { changes: 'a; b', verification: 'v', leftovers: '' })
  assert.deepEqual(parseSummary('No action taken while the pending call waits.'), { changes: '', verification: '', leftovers: '' })
})
