import assert from 'node:assert/strict'
import test from 'node:test'
import { realpath } from 'node:fs/promises'
import { AgyAdapter } from '../lib/provider/agy.js'
import { AgyProcessError } from '../lib/agy/process.js'
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
  assert.equal(completed.toolCallCount, 0)
  assert.equal(completed.bridgeOutcome, 'agy-owned')
  assert.equal(completed.reasoningEffort, 'high')
  assert.equal(completed.purpose, undefined)
  assert.equal(completed.modelDiscoverySource, 'static')
  assert.equal(completed.processAttemptCount, 1)
  assert.equal(completed.retryMaxRetries, 5)
  assert.deepEqual(completed.usage, { inputTokens: 2, outputTokens: 0 })
  assert.match(completed.conversationFingerprint, /^[0-9a-f]{16}$/)
  assert.equal(completed.conversationId, undefined)
  assert.equal(completed.eventCount, 3)
  assert.equal(completed.toolEventCount, 1)
  assert.equal(completed.toolEventKind, 'step-type-tool')
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

test('AgyAdapter charges step usage and keeps cumulative result usage as telemetry', async () => {
  const logs = []
  const chunks = []
  const adapter = new AgyAdapter({ model: 'gemini-test', modelDiscovery: 'off' }, {
    logger: record => logs.push(record),
    runAgyProcess: async request => {
      request.onStdoutLine?.(JSON.stringify({ event: 'step_update', step_update: {
        text_delta: 'turn',
        usage: { input_tokens: 7, output_tokens: 1, cache_read_tokens: 2 },
      } }))
      request.onStdoutLine?.(JSON.stringify({ event: 'result', result: {
        status: 'SUCCESS',
        response: 'turn',
        usage: { input_tokens: 12, output_tokens: 4, cache_read_tokens: 8 },
      } }))
      return result()
    },
  })

  for await (const chunk of adapter.stream({
    provider: 'agy-test',
    model: 'gemini-test',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'usage' }] }],
  })) chunks.push(chunk)

  assert.deepEqual(chunks.find(chunk => chunk.type === 'usage')?.usage, {
    inputTokens: 7,
    outputTokens: 1,
    cacheReadTokens: 2,
  })
  const completed = logs.at(-1)
  assert.equal(completed?.usageSource, 'step')
  assert.deepEqual(completed?.usage, { inputTokens: 7, outputTokens: 1, cacheReadTokens: 2 })
  assert.deepEqual(completed?.cumulativeUsage, { inputTokens: 12, outputTokens: 4, cacheReadTokens: 8 })
  assert.equal(completed?.cacheHit, true)
  assert.equal(completed?.cacheTokenShare, 2 / 9)
})

test('failed AGY requests log safe process diagnostics', async () => {
  const logs = []
  const adapter = new AgyAdapter({ modelDiscovery: 'off' }, {
    logger: record => logs.push(record),
    runAgyProcess: async () => {
      throw new AgyProcessError(
        'AGY stdout handler failed (AgyParserError:INVALID_JSON_LINE stage=stdout-handler line=7 length=19)',
        'OUTPUT_HANDLER_FAILED',
        { cause: new Error('internal parser detail') },
        {
          stage: 'stdout-handler',
          errorName: 'AgyParserError',
          errorCode: 'INVALID_JSON_LINE',
          lineNumber: 7,
          lineLength: 19,
          lineHash: '0123456789abcdef',
          stdoutLineCount: 7,
          stdoutBytes: 1_024,
          stderrBytes: 12,
        },
      )
    },
  })

  await assert.rejects(
    async () => {
      for await (const _chunk of adapter.stream({
        provider: 'agy-test',
        model: 'gemini-test',
        system: 'diagnostic prompt must not be logged',
        messages: [],
      })) {}
    },
    error => error.code === 'AGY_OUTPUT_HANDLER_FAILED'
      && error.message.includes('INVALID_JSON_LINE')
      && error.message.includes('line=7'),
  )

  const failed = logs.at(-1)
  assert.equal(failed?.event, 'agy.request.failed')
  assert.equal(failed?.errorCode, 'AGY_OUTPUT_HANDLER_FAILED')
  assert.deepEqual(failed?.processDiagnostic, {
    stage: 'stdout-handler',
    errorName: 'AgyParserError',
    errorCode: 'INVALID_JSON_LINE',
    lineNumber: 7,
    lineLength: 19,
    lineHash: '0123456789abcdef',
    stdoutLineCount: 7,
    stdoutBytes: 1_024,
    stderrBytes: 12,
  })
  assert.equal(JSON.stringify(logs).includes('diagnostic prompt must not be logged'), false)
})

test('DSH-owned telemetry reports only allowlisted DSH capability and bridge outcome', async () => {
  const cwd = await realpath(process.cwd())
  const session = { id: 'session-telemetry', header: { id: 'session-telemetry', cwd }, events: [] }
  const services = {
    sessions: { get: id => id === session.id ? session : undefined },
    workspaceRegistry: {
      resolveByPath: async path => ({ path, sessionIds: [session.id], status: async () => 'ok' }),
    },
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: cwd }) },
    permissionPresets: { current: () => 'workspace-write' },
    approval: { config: { policy: 'ask' }, overrideOf: () => undefined },
  }
  const logs = []
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    toolPolicy: 'dsh-owned',
    modelDiscovery: 'off',
  }, {
    logger: record => logs.push(record),
    dshContext: { get: name => services[name] },
    runAgyProcess: async request => {
      request.onStdoutLine?.(JSON.stringify({ event: 'result', result: {
        status: 'SUCCESS',
        response: '{"kind":"tool_call","name":"fixture","arguments":{"value":"你好"}}',
      } }))
      return result()
    },
  })

  for await (const _chunk of adapter.stream({
    provider: 'agy-test',
    model: 'gemini-test',
    sessionId: session.id,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'call fixture' }] }],
    tools: [{
      name: 'fixture',
      description: 'fixture',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['value'],
        properties: { value: { type: 'string' } },
      },
    }],
  })) {}

  const completed = logs.at(-1)
  assert.equal(completed.event, 'agy.request.completed')
  assert.equal(completed.permissionPreset, 'workspace-write')
  assert.equal(completed.sandboxMode, 'workspace-write')
  assert.equal(completed.approvalPolicy, 'ask')
  assert.equal(completed.toolSchemaCount, 1)
  assert.equal(completed.toolCallCount, 1)
  assert.equal(completed.bridgeOutcome, 'dsh-tool-call')
  assert.equal(JSON.stringify(logs).includes(cwd), false)
})

test('DSH context rejection is observable without spawning AGY', async () => {
  const logs = []
  let spawned = false
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    toolPolicy: 'dsh-owned',
    modelDiscovery: 'off',
  }, {
    logger: record => logs.push(record),
    runAgyProcess: async () => {
      spawned = true
      throw new Error('must not spawn')
    },
  })

  await assert.rejects(
    async () => {
      for await (const _chunk of adapter.stream({
        provider: 'agy-test',
        model: 'gemini-test',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'read' }] }],
        tools: [{ name: 'fixture', description: 'fixture', parameters: { type: 'object' } }],
      })) {}
    },
    error => error.code === 'DSH_SESSION_REQUIRED',
  )
  assert.equal(spawned, false)
  assert.equal(logs.at(-1)?.bridgeOutcome, 'context-rejected')
  assert.equal(logs.at(-1)?.toolCallCount, 0)
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

test('log sanitizer keeps only safe internal-tool structure metadata', () => {
  const safe = sanitizeAgyLogRecord({
    event: 'agy.request.failed',
    requestId: 'request-1',
    provider: 'agy',
    model: 'gemini-test',
    agent: 'deepseek-proxy',
    toolPolicy: 'dsh-owned',
    toolSchemaCount: 1,
    toolCallCount: 0,
    bridgeOutcome: 'agy-internal-tool',
    carrierAbortExpected: true,
    carrierValidation: 'valid-tool-call',
    attempt: 1,
    eventCount: 3,
    toolEventCount: 1,
    toolEventKind: 'step-type-tool',
    toolEventStreamIndex: -1,
    toolEventDiagnostic: {
      eventName: 'step_update',
      kind: 'step-type-tool',
      stepType: 'tool',
      toolName: 'token=super-secret',
      carrierShape: 'not-send-message',
      recipientClass: 'not-applicable',
      topLevelKeys: ['event', 'secret-key'],
      stepKeys: ['step_type', 'tool_name', 'private-argument'],
      toolInputKeys: ['message', 'api_key'],
    },
    permissionEventCount: 0,
    eventCategoryCounts: {
      init: 0,
      step_update: 1,
      checkpoint: 0,
      agent_response: 0,
      result: 0,
      tool: 1,
      permission: 0,
      error: 0,
      unknown: 0,
    },
  })

  assert.equal(safe.toolEventStreamIndex, 0)
  assert.equal(safe.carrierAbortExpected, true)
  assert.equal(safe.carrierValidation, 'valid-tool-call')
  assert.equal(safe.toolEventDiagnostic.toolName, 'token=[REDACTED]')
  assert.deepEqual(safe.toolEventDiagnostic.topLevelKeys, ['event'])
  assert.deepEqual(safe.toolEventDiagnostic.stepKeys, ['step_type', 'tool_name'])
  assert.deepEqual(safe.toolEventDiagnostic.toolInputKeys, ['message'])
  assert.equal(JSON.stringify(safe).includes('private-argument'), false)
  assert.equal(JSON.stringify(safe).includes('api_key'), false)
})

test('log sanitizer keeps only bounded structured-response diagnostics', () => {
  const safe = sanitizeAgyLogRecord({
    event: 'agy.request.failed',
    requestId: 'request-1',
    provider: 'agy',
    model: 'gemini-test',
    agent: 'dsh-agy-tool-free',
    toolPolicy: 'dsh-owned',
    toolSchemaCount: 1,
    toolCallCount: 0,
    bridgeOutcome: 'protocol-rejected',
    attempt: 2,
    protocolRepairAttempts: 1,
    protocolRepairReason: 'arguments-invalid',
    protocolFailureDetail: 'not-json',
    protocolResponseShape: 'object-like',
    protocolResponseBytes: 128,
    protocolToolName: 'pwsh',
    protocolArgumentIssue: 'missing-required',
    protocolMissingRequiredKeys: ['description'],
    protocolReceivedArgumentKeys: ['command'],
    protocolCompatibilityApplied: 'pwsh-description-default',
    eventCount: 4,
    toolEventCount: 0,
    permissionEventCount: 0,
    eventCategoryCounts: {
      init: 2,
      step_update: 0,
      checkpoint: 0,
      agent_response: 0,
      result: 2,
      tool: 0,
      permission: 0,
      error: 0,
      unknown: 0,
    },
    protocol: 'private-response-body',
  })

  assert.equal(safe.protocolFailureDetail, 'not-json')
  assert.equal(safe.protocolResponseShape, 'object-like')
  assert.equal(safe.protocolResponseBytes, 128)
  assert.equal(safe.protocolRepairReason, 'arguments-invalid')
  assert.equal(safe.protocolToolName, 'pwsh')
  assert.equal(safe.protocolArgumentIssue, 'missing-required')
  assert.deepEqual(safe.protocolMissingRequiredKeys, ['description'])
  assert.deepEqual(safe.protocolReceivedArgumentKeys, ['command'])
  assert.equal(safe.protocolCompatibilityApplied, 'pwsh-description-default')
  assert.equal(Object.hasOwn(safe, 'protocol'), false)
  assert.equal(JSON.stringify(safe).includes('private-response-body'), false)
})

test('log sanitizer allowlists DSH telemetry labels and clamps counters', () => {
  const safe = sanitizeAgyLogRecord({
    event: 'agy.request.completed',
    requestId: 'request-1',
    provider: 'agy',
    model: 'gemini-test',
    agent: 'dsh-agy-tool-free',
    toolPolicy: 'dsh-owned',
    toolSchemaCount: 1,
    toolCallCount: -4,
    bridgeOutcome: 'not-a-real-outcome',
    permissionPreset: 'private-mode',
    sandboxMode: 'private-mode',
    approvalPolicy: 'always-approve',
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
  })

  assert.equal(safe.toolCallCount, 0)
  assert.equal(safe.bridgeOutcome, 'failed')
  assert.equal(Object.hasOwn(safe, 'permissionPreset'), false)
  assert.equal(Object.hasOwn(safe, 'sandboxMode'), false)
  assert.equal(Object.hasOwn(safe, 'approvalPolicy'), false)
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
