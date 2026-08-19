import assert from 'node:assert/strict'
import test from 'node:test'
import { AgyAdapter } from '../lib/provider/agy.js'
import { sanitizeAgyLogRecord } from '../lib/agy/log.js'

function result() {
  return {
    exitCode: 0,
    signal: null,
    termination: 'completed',
    stdoutLines: [],
    stderr: '',
    durationMs: 1,
  }
}

test('AgyAdapter emits redacted structured lifecycle metadata', async () => {
  const logs = []
  const promptSecret = 'prompt-secret-must-not-be-logged'
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    agent: 'deepseek-proxy',
    toolPolicy: 'agy-owned',
    modelDiscovery: 'off',
  }, {
    logger: record => logs.push(record),
    runAgyProcess: async request => {
      request.onStdoutLine?.(JSON.stringify({ event: 'init', conversation_id: 'conversation-safe' }))
      request.onStdoutLine?.(JSON.stringify({ event: 'step_update', step_update: {
        step_type: 'tool',
        text_delta: 'ok',
      } }))
      request.onStdoutLine?.(JSON.stringify({ event: 'result', result: {
        status: 'SUCCESS',
        response: 'ok',
        usage: { totalTokens: 2 },
      } }))
      return result()
    },
  })

  for await (const _chunk of adapter.stream({
    provider: 'agy-test',
    model: 'gemini-test',
    system: promptSecret,
    messages: [{ role: 'user', content: [{ type: 'text', text: promptSecret }] }],
    tools: [{ name: 'fixture', description: 'fixture', parameters: { secret: promptSecret } }],
    reasoningEffort: 'high',
  })) {}

  assert.deepEqual(logs.map(log => log.event), ['agy.request.started', 'agy.request.completed'])
  const completed = logs[1]
  assert.equal(completed.provider, 'agy-test')
  assert.equal(completed.toolPolicy, 'agy-owned')
  assert.equal(completed.toolSchemaCount, 1)
  assert.equal(completed.reasoningEffort, 'high')
  assert.equal(completed.purpose, undefined)
  assert.equal(completed.modelDiscoverySource, 'static')
  assert.equal(completed.processAttemptCount, 1)
  assert.equal(completed.retryMaxRetries, 0)
  assert.deepEqual(completed.usage, { inputTokens: 2, outputTokens: 0 })
  assert.equal(completed.conversationId, 'conversation-safe')
  assert.equal(completed.eventCount, 3)
  assert.equal(completed.toolEventCount, 1)
  assert.equal(completed.permissionEventCount, 0)
  assert.deepEqual(completed.eventCategoryCounts, {
    init: 1,
    step_update: 0,
    checkpoint: 0,
    agent_response: 0,
    result: 1,
    tool: 1,
    permission: 0,
    error: 0,
    unknown: 0,
  })
  assert.equal(completed.finalStatus, 'SUCCESS')
  assert.equal(typeof completed.requestId, 'string')
  assert.equal(typeof completed.durationMs, 'number')
  assert.equal(Object.hasOwn(completed, 'prompt'), false)
  assert.equal(JSON.stringify(logs).includes(promptSecret), false)
})

test('log sanitizer drops runtime fields outside the whitelist', () => {
  const safe = sanitizeAgyLogRecord({
    event: 'agy.request.failed',
    requestId: 'request-1',
    provider: 'agy',
    model: 'gemini-test',
    agent: 'deepseek-proxy',
    toolPolicy: 'reject',
    toolSchemaCount: 0,
    attempt: 1,
    eventCount: 0,
    toolEventCount: 0,
    permissionEventCount: 0,
    eventCategoryCounts: {
      init: 0,
      step_update: 0,
      checkpoint: 0,
      agent_response: 0,
      result: 0,
      tool: 0,
      permission: 0,
      error: 0,
      unknown: 0,
    },
    prompt: 'secret prompt',
    stderr: 'secret stderr',
  })

  assert.equal(Object.hasOwn(safe, 'prompt'), false)
  assert.equal(Object.hasOwn(safe, 'stderr'), false)
  assert.equal(JSON.stringify(safe).includes('secret'), false)
})

test('AgyAdapter limits active AGY processes across separate sessions', async () => {
  let active = 0
  let maximum = 0
  const adapter = new AgyAdapter({
    maxConcurrent: 1,
    maxQueue: 2,
    queueTimeoutMs: 1_000,
  }, {
    runAgyProcess: async request => {
      active += 1
      maximum = Math.max(maximum, active)
      request.onStdoutLine?.(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'ok' } }))
      await new Promise(resolve => setTimeout(resolve, 15))
      active -= 1
      return result()
    },
  })
  const consume = async sessionId => {
    for await (const _chunk of adapter.stream({
      provider: 'agy-test',
      model: 'gemini-test',
      sessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text: sessionId }] }],
    })) {}
  }

  await Promise.all([consume('one'), consume('two')])
  assert.equal(maximum, 1)
  assert.deepEqual(adapter.getConcurrencyStats(), {
    active: 0,
    queued: 0,
    maxConcurrent: 1,
    maxQueue: 2,
    queueTimeoutMs: 1_000,
  })
})
