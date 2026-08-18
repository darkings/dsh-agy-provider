import assert from 'node:assert/strict'
import test from 'node:test'
import { AgyAdapter } from '../lib/provider/agy.js'
import { classifyAgyFailure } from '../lib/agy/errors.js'

function processResult(stderr = '', exitCode = 0, termination = exitCode === 0 ? 'completed' : 'non-zero') {
  return {
    exitCode,
    signal: null,
    termination,
    stdoutLines: [],
    stderr,
    durationMs: 1,
  }
}

function request() {
  return {
    provider: 'agy-test',
    model: 'gemini-test',
    system: 'reply',
    messages: [],
  }
}

test('classifyAgyFailure maps authentication, quota, model, and context details', () => {
  const cases = [
    ['authentication required', 'AUTH'],
    ['quota exceeded', 'QUOTA'],
    ['HTTP 429: too many requests', 'RATE_LIMIT'],
    ['model gemini-test not found', 'MODEL_NOT_FOUND'],
    ['agent deepseek-proxy not found', 'AGY_AGENT_MISSING'],
    ['context window exceeded', 'CONTEXT_WINDOW_EXCEEDED'],
    ['unclassified provider failure', 'AGY_EXIT'],
  ]
  for (const [detail, expected] of cases) assert.equal(classifyAgyFailure(detail, 'AGY_EXIT'), expected)
})

test('AgyAdapter maps an AGY error event to a stable auth code', async () => {
  const adapter = new AgyAdapter({}, {
    runAgyProcess: async requestValue => {
      requestValue.onStdoutLine?.(JSON.stringify({
        event: 'error_message',
        error_message: { code: 'AUTH_REQUIRED', message: 'authentication required' },
      }))
      return processResult()
    },
  })
  await assert.rejects(
    async () => {
      for await (const _chunk of adapter.stream(request())) {}
    },
    error => error.code === 'AUTH',
  )
})

test('AgyAdapter maps status and stderr details without exposing raw classification to logs', async () => {
  const statusAdapter = new AgyAdapter({}, {
    runAgyProcess: async requestValue => {
      requestValue.onStdoutLine?.(JSON.stringify({ event: 'result', result: { status: 'QUOTA_EXCEEDED' } }))
      return processResult()
    },
  })
  await assert.rejects(
    async () => {
      for await (const _chunk of statusAdapter.stream(request())) {}
    },
    error => error.code === 'QUOTA',
  )

  const logs = []
  const stderrAdapter = new AgyAdapter({}, {
    logger: record => logs.push(record),
    runAgyProcess: async () => processResult('model gemini-test not found\n', 1),
  })
  await assert.rejects(
    async () => {
      for await (const _chunk of stderrAdapter.stream(request())) {}
    },
    error => error.code === 'MODEL_NOT_FOUND',
  )
  assert.equal(logs.at(-1)?.errorCode, 'MODEL_NOT_FOUND')
  assert.equal(Object.hasOwn(logs.at(-1) ?? {}, 'stderr'), false)
})

test('AgyAdapter keeps process, parser, status, and empty-response codes stable', async () => {
  const cases = [
    {
      expected: 'TIMEOUT',
      run: async () => processResult('', null, 'timeout'),
    },
    {
      expected: 'ABORTED',
      run: async () => processResult('', null, 'aborted'),
    },
    {
      expected: 'AGY_PARSE',
      run: async requestValue => {
        requestValue.onStdoutLine?.('not-json')
        return processResult()
      },
    },
    {
      expected: 'AGY_STATUS',
      run: async requestValue => {
        requestValue.onStdoutLine?.(JSON.stringify({ event: 'result', result: { status: 'FAILED' } }))
        return processResult()
      },
    },
    {
      expected: 'EMPTY_RESPONSE',
      run: async () => processResult(),
    },
  ]
  for (const item of cases) {
    const adapter = new AgyAdapter({}, { runAgyProcess: item.run })
    await assert.rejects(
      async () => {
        for await (const _chunk of adapter.stream(request())) {}
      },
      error => error.code === item.expected,
    )
  }
})
