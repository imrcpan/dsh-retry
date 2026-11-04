import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, delayForRetry, inject, name } from '../index.js'

const SCHEDULE = [2000, 5000, 5000, 5000, 10000]
const TAIL = 20000

/** Mount the plugin against a recording context and return its listener plus the appended events. */
function harness(config = {}) {
  const events = []
  const listeners = []
  let disposer
  const ctx = {
    on: (event, listener) => { if (event === 'agent/request-error') listeners.push(listener) },
    effect: (factory) => { disposer = factory() },
    logger: { warn: () => {} },
  }
  apply(ctx, { schedule: [2, 5, 5, 5, 10], tailDelayMs: 20, ...config })
  const agent = { session: { append: (type, data) => { events.push({ type, data }); return { type } } } }
  const signal = new AbortController().signal
  const failureOf = (code) => ({ message: 'upstream error ' + code, code })
  const call = (code, extra = {}) => listeners[0]({ agent, turn: 1, step: 1, provider: 'token', failure: failureOf(code), signal, ...extra }, async () => 'delegated')
  return { events, listeners, call, dispose: () => disposer() }
}

test('exposes the plugin contract', () => {
  assert.equal(name, 'dsh-retry')
  assert.deepEqual(inject, [])
})

test('keeps the delay curve across the bounded head and the unlimited tail', () => {
  const expected = [2000, 5000, 5000, 5000, 10000, 20000, 20000, 20000, 20000]
  expected.forEach((delay, index) => assert.equal(delayForRetry(index + 1, SCHEDULE, TAIL), delay))
  assert.throws(() => delayForRetry(0, SCHEDULE, TAIL))
  assert.throws(() => delayForRetry(1.5, SCHEDULE, TAIL))
})

test('retries the same step on the same chain and numbers the attempts', async () => {
  const { events, call } = harness()
  for (let attempt = 0; attempt < 8; attempt++) assert.deepEqual(await call('PI_AI_ERROR'), { kind: 'retry' })
  const planned = events.filter((event) => event.type === 'llm/retry')
  const started = events.filter((event) => event.type === 'llm/retry-started')
  assert.equal(planned.length, 8)
  assert.equal(started.length, 8)
  assert.deepEqual(planned.map((event) => event.data.delayMs), [2, 5, 5, 5, 10, 20, 20, 20])
  assert.deepEqual(planned.map((event) => event.data.retry), [1, 2, 3, 4, 5, 6, 7, 8])
  assert.deepEqual(planned.map((event) => event.data.mode), ['normal', 'normal', 'normal', 'normal', 'normal', 'always', 'always', 'always'])
  assert.deepEqual(planned.map((event) => event.data.maxRetries), [5, 5, 5, 5, 5, undefined, undefined, undefined])
  assert.equal(new Set(planned.map((event) => event.data.retryId)).size, 1)
  assert.deepEqual(events.map((event) => event.type), Array.from({ length: 8 }, () => ['llm/retry', 'llm/retry-started']).flat())
})

test('restarts the curve and the chain id on a different step', async () => {
  const { events, call } = harness()
  await call('PI_AI_ERROR')
  await call('PI_AI_ERROR', { step: 2 })
  const planned = events.filter((event) => event.type === 'llm/retry')
  assert.deepEqual(planned.map((event) => event.data.delayMs), [2, 2])
  assert.notEqual(planned[0].data.retryId, planned[1].data.retryId)
})

test('retries pooled-account codes and prefix wildcards', async () => {
  const { call } = harness({ retryableCodes: ['PI_AI_ERROR', 'AUTH', 'ACCOUNT_QUOTA', 'HTTP_*'] })
  for (const code of ['PI_AI_ERROR', 'AUTH', 'ACCOUNT_QUOTA', 'HTTP_404', 'HTTP_409', 'HTTP_422']) {
    assert.deepEqual(await call(code), { kind: 'retry' }, code + ' must retry')
  }
})

test('delegates permanent, request-side and aborted failures', async () => {
  const { events, call } = harness({ retryableCodes: ['PI_AI_ERROR', 'AUTH', 'QUOTA'] })
  for (const code of ['CONTEXT_WINDOW_EXCEEDED', 'INVALID_REQUEST', 'NO_ADAPTER', 'UNSUPPORTED_REASONING_EFFORT', 'MISSING_CREDENTIAL', 'ABORTED', 'UNKNOWN']) {
    assert.equal(await call(code), 'delegated', code + ' must delegate')
  }
  assert.equal(events.length, 0)
})

test('aborts a pending wait when the turn is cancelled', async () => {
  const { events, call } = harness()
  const controller = new AbortController()
  const pending = call('PI_AI_ERROR', { signal: controller.signal })
  controller.abort()
  assert.equal(await pending, undefined)
  assert.equal(events.filter((event) => event.type === 'llm/retry-started').length, 0)
})

test('rejects invalid configuration at mount', () => {
  assert.throws(() => harness({ retryableCodes: [] }), /non-empty/)
  assert.throws(() => harness({ retryableCodes: ['*'] }), /wildcard/)
  assert.throws(() => harness({ schedule: [] }), /schedule/)
  assert.throws(() => harness({ tailDelayMs: 0 }), /tailDelayMs/)
})
