import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isDeterministicRouteFailure, RouteHealth } from '../src/llm-hooks.ts'

test('deterministic route failures vs transient ones (typical gateway responses)', () => {
  assert.equal(isDeterministicRouteFailure({ status: 400, message: 'Invalid JSON payload received. Unknown name "anthropic_version"' }), true)
  assert.equal(isDeterministicRouteFailure({ status: 400, message: 'The requested operation is unsupported.' }), true)
  assert.equal(isDeterministicRouteFailure({ status: 500, message: '{"error":{"type":"api_error","message":"not available (request id: x)"}}' }), true, 'retired model, not overload')
  assert.equal(isDeterministicRouteFailure({ status: 404 }), true)
  assert.equal(isDeterministicRouteFailure({ code: 'MISSING_CREDENTIAL' }), true)
  assert.equal(isDeterministicRouteFailure({ status: 429, message: 'Rate limit reached' }), false)
  assert.equal(isDeterministicRouteFailure({ status: 503, message: 'upstream overloaded' }), false)
  assert.equal(isDeterministicRouteFailure({ status: 400, message: 'maximum context length is 128000 tokens' }), false)
})

test('route health benches for a TTL and a successful probe clears it', () => {
  let now = 0
  const h = new RouteHealth(1000, () => now)
  const r = { provider: 'relay', model: 'model-c' }
  h.markBroken(r, 'not available')
  assert.equal(h.isBroken(r), true)
  now = 1001
  assert.equal(h.isBroken(r), false, 'expires')
  h.markBroken(r, 'again')
  h.recordProbe(r, true, 'finish:stop', 10)
  assert.equal(h.isBroken(r), false, 'probe success clears')
})
