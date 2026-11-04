/**
 * Fixed-schedule model-request retry executor for DeepSeek Harness.
 *
 * Delays are 2s, 5s, 5s, 5s, 10s for the first five retries, then one attempt
 * every 20s with no limit. Mount this in place of
 * `@deepseek-ai/dsh-llm-retry` when the exponential backoff that package
 * derives from `initialDelayMs`/`maxDelayMs` is not the wanted curve.
 *
 * Recovery runs on the agent loop's `agent/request-error` waterfall, so the
 * failed step is re-run inside the same open turn against the same durable
 * history. Each planned retry is appended as the standard `llm/retry` event
 * (and `llm/retry-started` once the wait finishes), which is what the Chat
 * status row and the Trajectory panel read; the model never sees them.
 *
 * @module dsh-retry
 */
import { randomUUID } from 'node:crypto'

/** Plugin name used by the loader entry. */
export const name = 'dsh-retry'

/** No services are required: the waterfall payload carries the agent. */
export const inject = []

/** Default backoff curve in milliseconds for retries 1..5. */
const DEFAULT_SCHEDULE_MS = [2000, 5000, 5000, 5000, 10000]

/** Default delay for retry 6 and every retry after it. */
const DEFAULT_TAIL_DELAY_MS = 20000

/** Failure codes that are transient enough to repeat the request. */
const DEFAULT_CODES = [
  'EMPTY_RESPONSE',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  'PI_AI_ERROR',
]

function positiveMs(value, fallback, label) {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`dsh-retry: ${label} must be a positive finite number of milliseconds`)
  }
  return value
}

function resolveSettings(config) {
  const source = config ?? {}
  const schedule = source.schedule ?? DEFAULT_SCHEDULE_MS
  if (!Array.isArray(schedule) || schedule.length === 0) {
    throw new Error('dsh-retry: schedule must be a non-empty array of delays in milliseconds')
  }
  const codes = source.retryableCodes ?? DEFAULT_CODES
  if (!Array.isArray(codes) || codes.length === 0 || codes.some((code) => typeof code !== 'string' || code.length === 0)) {
    throw new Error('dsh-retry: retryableCodes must be a non-empty array of non-empty strings')
  }
  return {
    schedule: schedule.map((delay, position) => positiveMs(delay, 0, `schedule[${position}]`)),
    tailDelayMs: positiveMs(source.tailDelayMs, DEFAULT_TAIL_DELAY_MS, 'tailDelayMs'),
    codes: new Set(codes),
  }
}

/**
 * Delay in milliseconds before the given retry attempt.
 * @param retry - 1-based retry number within one step.
 * @param schedule - per-position delays for the bounded head of the curve.
 * @param tailDelayMs - delay used after the schedule is exhausted.
 * @returns the wait before re-issuing the request.
 */
export function delayForRetry(retry, schedule, tailDelayMs) {
  if (!Number.isInteger(retry) || retry < 1) throw new Error('dsh-retry: retry must be a positive integer')
  return retry <= schedule.length ? schedule[retry - 1] : tailDelayMs
}

function cancellableDelay(delayMs, signal) {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    function onAbort() {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Mount the executor.
 * @param ctx - plugin context.
 * @param config - optional schedule overrides from the loader entry.
 */
export function apply(ctx, config = {}) {
  const settings = resolveSettings(config)
  const policyKey = JSON.stringify({ mode: 'schedule', schedule: settings.schedule, tailDelayMs: settings.tailDelayMs })
  const lifetime = new AbortController()
  /** session -> `provider|turn|step` -> retry chain state; memory is enough because a host restart ends the turn. */
  const chains = new WeakMap()
  const active = new Set()

  function chainOf(session) {
    let chain = chains.get(session)
    if (chain === undefined) {
      chain = new Map()
      chains.set(session, chain)
    }
    return chain
  }

  async function recover(payload, next) {
    const { agent, turn, step, provider, failure, signal } = payload
    if (failure === undefined || !settings.codes.has(failure.code)) return next()
    if (signal?.aborted === true) return undefined
    const fused = signal === undefined ? lifetime.signal : AbortSignal.any([signal, lifetime.signal])
    if (fused.aborted) return undefined
    const chain = chainOf(agent.session)
    const key = JSON.stringify([provider, turn, step])
    const previous = chain.get(key)
    const retry = (previous?.retry ?? 0) + 1
    const bounded = retry <= settings.schedule.length
    const retryId = previous?.retryId ?? randomUUID()
    const delayMs = delayForRetry(retry, settings.schedule, settings.tailDelayMs)
    agent.session.append('llm/retry', {
      retryId,
      turn,
      step,
      provider,
      mode: bounded ? 'normal' : 'always',
      policyKey,
      retry,
      ...(bounded ? { maxRetries: settings.schedule.length } : {}),
      delayMs,
      failure,
    })
    chain.set(key, { retry, retryId })
    if (!await cancellableDelay(delayMs, fused)) return undefined
    agent.session.append('llm/retry-started', { retryId, turn, step, retry })
    return { kind: 'retry' }
  }

  ctx.on('agent/request-error', (payload, next) => {
    if (lifetime.signal.aborted) return Promise.resolve(undefined)
    const tracked = recover(payload, next).finally(() => active.delete(tracked))
    active.add(tracked)
    return tracked
  })

  ctx.effect(() => () => {
    lifetime.abort(new Error('dsh-retry plugin disposed'))
  }, 'dsh-retry: abort pending backoff')
}
