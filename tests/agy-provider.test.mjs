import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { AgyAdapter } from '../lib/provider/agy.js'
import { getAgyUserMessageByteLength } from '../lib/agy/stream-protocol.js'

function result(exitCode = 0) {
  return {
    exitCode,
    signal: null,
    termination: exitCode === 0 ? 'completed' : 'non-zero',
    stdoutLines: [],
    stderr: exitCode === 0 ? '' : 'simulated failure',
    durationMs: 1,
  }
}

function modelDiscoveryResult(stdoutLines, exitCode = 0) {
  return {
    exitCode,
    signal: null,
    termination: exitCode === 0 ? 'completed' : 'non-zero',
    stdoutLines,
    stderr: exitCode === 0 ? '' : 'simulated discovery failure',
    durationMs: 1,
  }
}

function fakeRunner(events, captured) {
  return async request => {
    captured.push(request)
    for (const event of events) {
      await new Promise(resolve => setTimeout(resolve, 1))
      request.onStdoutLine?.(JSON.stringify(event))
    }
    return result()
  }
}

function trustedDshContext() {
  const cwd = process.cwd()
  const session = {
    id: 'session-1',
    header: { id: 'session-1', cwd },
    events: [],
  }
  const services = {
    sessions: { get: id => id === session.id ? session : undefined },
    workspaceRegistry: {
      resolveByPath: async path => ({
        path,
        sessionIds: [session.id],
        status: async () => 'ok',
      }),
    },
    sandboxPolicy: {
      resolve: ({ session: observed }) => {
        assert.equal(observed, session)
        return { mode: 'workspace-write', workspaceRoot: cwd }
      },
    },
    permissionPresets: {
      current: events => {
        assert.equal(events, session.events)
        return 'workspace-write'
      },
    },
    approval: {
      config: { policy: 'ask' },
      overrideOf: observed => {
        assert.equal(observed, session)
        return undefined
      },
    },
  }
  return {
    get(name) {
      return services[name]
    },
  }
}

const readFileTool = {
  name: 'read_file',
  description: 'Read one text file.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['path'],
    properties: {
      path: { type: 'string', minLength: 1 },
    },
  },
}

const pwshTool = {
  name: 'pwsh',
  description: 'Execute a PowerShell command.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['command', 'description'],
    properties: {
      command: { type: 'string', minLength: 1 },
      description: { type: 'string', minLength: 1, maxLength: 128 },
    },
  },
}

const request = {
  provider: 'agy-test',
  model: 'gemini-test',
  system: 'system prompt',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'reply 123' }] }],
}

test('AgyAdapter exposes the DSH default bounded retry policy', () => {
  const defaultAdapter = new AgyAdapter({})
  assert.deepEqual(defaultAdapter.providerRetryPolicy('agy-test'), {
    mode: 'normal',
    maxRetries: 5,
    retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
    initialDelayMs: 500,
    maxDelayMs: 10_000,
    jitterRatio: 0.1,
  })

  const optInAdapter = new AgyAdapter({
    retryPolicy: { maxRetries: 5, retryableCodes: ['TIMEOUT'] },
  })
  assert.equal(optInAdapter.providerRetryPolicy('agy-test').maxRetries, 5)
  assert.deepEqual(optInAdapter.providerRetryPolicy('agy-test').retryableCodes, ['TIMEOUT'])
  assert.equal(defaultAdapter.providerInfo('agy-test').name, 'Antigravity CLI')
  assert.throws(() => new AgyAdapter({ inputFrameLimitBytes: 127 }), /inputFrameLimitBytes must be an integer/)
  assert.throws(() => new AgyAdapter({ toolProtocolRepairRetries: 2 }), /toolProtocolRepairRetries must be an integer/)
})

test('AgyAdapter maps AGY text deltas, final response, usage, and finish', async () => {
  const captured = []
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    agent: 'deepseek-proxy',
  }, {
    runAgyProcess: fakeRunner([
      { event: 'init', init: { agent: 'deepseek-proxy' } },
      { event: 'step_update', step_update: { text_delta: '12', usage: { totalTokens: 3 } } },
      { event: 'result', result: { status: 'SUCCESS', response: '123\n', usage: { totalTokens: 4 } } },
    ], captured),
  })

  const chunks = []
  for await (const chunk of adapter.stream(request)) chunks.push(chunk)

  assert.deepEqual(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text), ['12', '3\n'])
  assert.deepEqual(chunks.find(chunk => chunk.type === 'block-end')?.block, { type: 'text', text: '123\n' })
  // `step_update.usage` is the current physical turn; `result.usage` is
  // conversation-cumulative and must not be charged again.
  assert.deepEqual(chunks.find(chunk => chunk.type === 'usage')?.usage, { inputTokens: 3, outputTokens: 0 })
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
  assert.match(captured[0].prompt, /=== SYSTEM ===[\s\S]+reply 123/)
  assert.equal(captured[0].agent, 'deepseek-proxy')
  assert.equal(captured[0].model, 'gemini-test')
})

test('AgyAdapter exposes and forwards the supported reasoning efforts', async () => {
  const captured = []
  const adapter = new AgyAdapter({ model: 'gemini-test' }, {
    runAgyProcess: fakeRunner([
      { event: 'result', result: { status: 'SUCCESS', response: 'reasoned' } },
    ], captured),
  })

  const resolved = await adapter.resolveModel('agy-test', 'gemini-test')
  assert.deepEqual(resolved.reasoning?.efforts.map(effort => effort.id), ['low', 'medium', 'high'])
  assert.deepEqual(resolved.reasoning?.efforts.map(effort => effort.description), [undefined, undefined, undefined])
  assert.equal(resolved.reasoning?.defaultEffort, undefined)

  for await (const _chunk of adapter.stream({ ...request, reasoningEffort: 'high' })) {}
  assert.equal(captured[0]?.reasoningEffort, 'high')

  await assert.rejects(
    async () => {
      for await (const _chunk of adapter.stream({ ...request, reasoningEffort: 'turbo' })) {}
    },
    error => error.code === 'UNSUPPORTED_REASONING_EFFORT',
  )
  assert.equal(captured.length, 1)
})

test('AgyAdapter applies purpose routes only to matching auxiliary calls', async () => {
  const captured = []
  const adapter = new AgyAdapter({
    model: 'gemini-default',
    agent: 'deepseek-proxy',
    purposeRoutes: {
      compaction: {
        model: 'gemini-3.7-flash-low',
        agent: 'deepseek-proxy',
        reasoningEffort: 'low',
      },
    },
  }, {
    runAgyProcess: fakeRunner([
      { event: 'result', result: { status: 'SUCCESS', response: 'ok' } },
    ], captured),
  })

  for await (const _chunk of adapter.stream({
    ...request,
    purpose: 'compaction',
  })) {}
  for await (const _chunk of adapter.stream(request)) {}

  assert.equal(captured[0]?.model, 'gemini-3.7-flash')
  assert.equal(captured[0]?.agent, 'deepseek-proxy')
  assert.equal(captured[0]?.reasoningEffort, 'low')
  assert.equal(captured[1]?.model, 'gemini-test')
  assert.equal(captured[1]?.agent, 'deepseek-proxy')
  assert.equal(captured[1]?.reasoningEffort, 'high')
})

test('AgyAdapter maps read-only and workspace-write presets to bounded AGY process options', async () => {
  const captured = []
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    agentPreset: 'read-only',
    workspaceRoot: process.cwd(),
  }, {
    runAgyProcess: fakeRunner([
      { event: 'result', result: { status: 'SUCCESS', response: 'read-only' } },
    ], captured),
  })

  for await (const _chunk of adapter.stream({ ...request, messages: [] , system: 'read' })) {}
  assert.equal(captured[0]?.agent, 'dsh-agy-read-only')
  assert.equal(captured[0]?.cwd, process.cwd())
  assert.deepEqual(captured[0]?.addDirs, [process.cwd()])
  assert.equal(captured[0]?.mode, 'plan')
  assert.equal(captured[0]?.disableSlashCommands, true)

  const writeCaptured = []
  const writeAdapter = new AgyAdapter({
    model: 'gemini-test',
    agentPreset: 'workspace-write',
    workspaceRoot: process.cwd(),
  }, {
    runAgyProcess: fakeRunner([
      { event: 'result', result: { status: 'SUCCESS', response: 'written' } },
    ], writeCaptured),
  })
  for await (const _chunk of writeAdapter.stream({ ...request, messages: [] , system: 'write' })) {}
  assert.equal(writeCaptured[0]?.agent, 'dsh-agy-workspace-write')
  assert.equal(writeCaptured[0]?.mode, 'accept-edits')
  assert.equal(writeCaptured[0]?.disableSlashCommands, true)
})

test('AgyAdapter requires an explicit non-root workspace for workspace-write', () => {
  assert.throws(
    () => new AgyAdapter({ agentPreset: 'workspace-write' }),
    /workspaceRoot is required/,
  )
})

test('experimental image bridge stages AttachmentStore bytes, exposes a directory, and cleans up', async () => {
  const captured = []
  let observedImagePath
  let imageExistedDuringRequest = false
  const attachment = {
    attachmentId: 'attachment-fixture',
    mediaType: 'image/png',
    bytes: 4,
    width: 1,
    height: 1,
  }
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    toolPolicy: 'dsh-owned',
    imageInput: 'experimental',
  }, {
    attachmentStore: {
      readImage: async ref => ({ ref, data: new Uint8Array([137, 80, 78, 71]) }),
    },
    runAgyProcess: async requestValue => {
      captured.push(requestValue)
      observedImagePath = requestValue.prompt.match(/\[IMAGE_ATTACHMENT file=(\S+) /)?.[1]
      imageExistedDuringRequest = observedImagePath !== undefined && existsSync(observedImagePath)
      requestValue.onStdoutLine?.(JSON.stringify({
        event: 'result',
        result: { status: 'SUCCESS', response: 'pixel answer' },
      }))
      return result()
    },
  })

  for await (const _chunk of adapter.stream({
    ...request,
    system: 'Describe the image using view_file.',
    messages: [{ role: 'user', content: [{ type: 'image', attachment }] }],
  })) {}

  assert.equal(imageExistedDuringRequest, true)
  assert.ok(observedImagePath)
  assert.equal(existsSync(observedImagePath), false)
  assert.equal(existsSync(dirname(observedImagePath)), false)
  assert.equal(captured[0]?.agent, 'dsh-agy-image-view')
  assert.equal(captured[0]?.mode, 'plan')
  assert.equal(captured[0]?.addDirs.some(directory => directory === dirname(observedImagePath)), true)

  const models = await adapter.listModels('agy-test')
  assert.deepEqual(models[0]?.inputModalities, ['text', 'image'])
})

test('experimental image bridge narrowly permits staged view_file events with DSH-owned tools', async () => {
  let stagedPath
  const chunks = []
  const attachment = {
    attachmentId: 'attachment-tool-fixture',
    mediaType: 'image/png',
    bytes: 4,
    width: 1,
    height: 1,
  }
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    toolPolicy: 'dsh-owned',
    imageInput: 'experimental',
  }, {
    dshContext: trustedDshContext(),
    attachmentStore: {
      readImage: async ref => ({ ref, data: new Uint8Array([137, 80, 78, 71]) }),
    },
    runAgyProcess: async requestValue => {
      stagedPath = requestValue.prompt.match(/\[IMAGE_ATTACHMENT file=(\S+) /)?.[1]
      requestValue.onStdoutLine?.(JSON.stringify({
        event: 'step_update',
        step_update: {
          step_type: 'tool',
          tool_name: 'view_file',
          state: 'ACTIVE',
          tool_input: { AbsolutePath: stagedPath },
        },
      }))
      requestValue.onStdoutLine?.(JSON.stringify({
        event: 'step_update',
        step_update: { step_type: 'tool', tool_name: 'view_file', state: 'DONE' },
      }))
      requestValue.onStdoutLine?.(JSON.stringify({
        event: 'result',
        result: {
          status: 'SUCCESS',
          response: '{"kind":"message","content":"pixel answer"}',
        },
      }))
      return result()
    },
  })

  for await (const chunk of adapter.stream({
    ...request,
    sessionId: 'session-1',
    tools: [readFileTool],
    messages: [{ role: 'user', content: [{ type: 'image', attachment }] }],
  })) chunks.push(chunk)

  assert.equal(chunks.find(chunk => chunk.type === 'text-delta')?.text, 'pixel answer')
  assert.ok(stagedPath)
  assert.equal(existsSync(stagedPath), false)
})

test('experimental image bridge rejects view_file events outside the staged image set', async () => {
  const attachment = {
    attachmentId: 'attachment-tool-outside',
    mediaType: 'image/png',
    bytes: 4,
    width: 1,
    height: 1,
  }
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    toolPolicy: 'dsh-owned',
    imageInput: 'experimental',
  }, {
    dshContext: trustedDshContext(),
    attachmentStore: {
      readImage: async ref => ({ ref, data: new Uint8Array([137, 80, 78, 71]) }),
    },
    runAgyProcess: async requestValue => {
      const stagedPath = requestValue.prompt.match(/\[IMAGE_ATTACHMENT file=(\S+) /)?.[1]
      const outsidePath = resolve(dirname(stagedPath), '..', 'outside.png')
      requestValue.onStdoutLine?.(JSON.stringify({
        event: 'step_update',
        step_update: {
          step_type: 'tool',
          tool_name: 'view_file',
          state: 'ACTIVE',
          tool_input: { AbsolutePath: outsidePath },
        },
      }))
      return result()
    },
  })

  await assert.rejects(
    async () => {
      for await (const _chunk of adapter.stream({
        ...request,
        sessionId: 'session-1',
        tools: [readFileTool],
        messages: [{ role: 'user', content: [{ type: 'image', attachment }] }],
      })) {}
    },
    error => error.code === 'AGY_INTERNAL_TOOL_EVENT',
  )
})

test('experimental image bridge fails without AttachmentStore and always cleans on runner failure', async () => {
  const attachment = {
    attachmentId: 'attachment-fixture',
    mediaType: 'image/png',
    bytes: 4,
    width: 1,
    height: 1,
  }
  const imageRequest = {
    ...request,
    messages: [{ role: 'user', content: [{ type: 'image', attachment }] }],
  }

  const unavailable = new AgyAdapter({ imageInput: 'experimental', agentPreset: 'read-only' }, {
    runAgyProcess: fakeRunner([], []),
  })
  await assert.rejects(
    async () => { for await (const _chunk of unavailable.stream(imageRequest)) {} },
    error => error.code === 'IMAGE_ATTACHMENT_UNAVAILABLE',
  )

  let stagedPath
  const failing = new AgyAdapter({ imageInput: 'experimental', agentPreset: 'read-only' }, {
    attachmentStore: {
      readImage: async ref => ({ ref, data: new Uint8Array([137, 80, 78, 71]) }),
    },
    runAgyProcess: async requestValue => {
      stagedPath = requestValue.prompt.match(/\[IMAGE_ATTACHMENT file=(\S+) /)?.[1]
      assert.equal(existsSync(stagedPath), true)
      throw new Error('fake image transport failure')
    },
  })
  await assert.rejects(
    async () => { for await (const _chunk of failing.stream(imageRequest)) {} },
    error => error.code === 'AGY_REQUEST',
  )
  assert.ok(stagedPath)
  assert.equal(existsSync(dirname(stagedPath)), false)
})

test('experimental image bridge isolates an unverified custom Agent behind the bundled image viewer', async () => {
  const captured = []
  const adapter = new AgyAdapter({ imageInput: 'experimental', agent: 'deepseek-proxy' }, {
    attachmentStore: {
      readImage: async ref => ({ ref, data: new Uint8Array([137, 80, 78, 71]) }),
    },
    runAgyProcess: fakeRunner([
      { event: 'result', result: { status: 'SUCCESS', response: 'pixel answer' } },
    ], captured),
  })
  for await (const _chunk of adapter.stream({
    ...request,
    messages: [{
      role: 'user',
      content: [{
        type: 'image',
        attachment: { attachmentId: 'custom-agent', mediaType: 'image/png', bytes: 4, width: 1, height: 1 },
      }],
    }],
  })) {}
  assert.equal(captured[0]?.agent, 'dsh-agy-image-view')
  assert.equal(captured[0]?.mode, 'plan')
  assert.equal(captured[0]?.disableSlashCommands, true)
})

test('official DSH runtime validates reasoning effort before AGY spawn', async () => {
  const root = new Context()
  const captured = []
  await root.plugin(LlmRuntime)
  root.llm.registerAdapter(['agy-reasoning-runtime'], new AgyAdapter({ model: 'gemini-test' }, {
    runAgyProcess: fakeRunner([
      { event: 'result', result: { status: 'SUCCESS', response: 'reasoned' } },
    ], captured),
  }))

  for await (const _chunk of root.llm.stream({
    ...request,
    provider: 'agy-reasoning-runtime',
    reasoningEffort: 'medium',
    messages: [],
    system: 'reply',
  })) {}
  assert.equal(captured[0]?.reasoningEffort, 'medium')

  const invalidChunks = []
  for await (const chunk of root.llm.stream({
    ...request,
    provider: 'agy-reasoning-runtime',
    reasoningEffort: 'turbo',
    messages: [],
    system: 'reply',
  })) invalidChunks.push(chunk)
  const invalidFinish = invalidChunks.at(-1)
  assert.equal(invalidFinish?.type, 'finish')
  assert.equal(invalidFinish?.reason.kind, 'error')
  assert.equal(invalidFinish?.reason.failure.code, 'UNSUPPORTED_REASONING_EFFORT')
  assert.equal(captured.length, 1)
  await root.fiber.dispose()
})

test('AgyAdapter uses result.response when AGY emits no text delta', async () => {
  const adapter = new AgyAdapter({}, {
    runAgyProcess: fakeRunner([
      { event: 'result', result: { status: 'SUCCESS', response: '123' } },
    ], []),
  })
  const chunks = []
  for await (const chunk of adapter.stream({ ...request, messages: [] , system: 'reply' })) chunks.push(chunk)
  assert.equal(chunks.find(chunk => chunk.type === 'text-delta')?.text, '123')
})

test('AgyAdapter advertises a deduplicated model catalog and resolves metadata', async () => {
  const adapter = new AgyAdapter({
    model: 'gemini-default',
    modelDiscovery: 'off',
    models: [
      { id: 'gemini-flash', name: 'Flash', contextWindow: 1_000_000 },
      { id: 'gemini-flash', name: 'Duplicate' },
      { id: 'gemini-pro', description: 'Pro text model' },
    ],
  })

  const models = await adapter.listModels('agy-test')
  assert.deepEqual(models.map(model => model.id), ['gemini-flash', 'gemini-pro', 'gemini-default'])
  assert.equal(models[0]?.name, 'Flash')
  assert.equal(models[1]?.description, undefined)
  assert.deepEqual(models[0]?.inputModalities, ['text'])

  const resolved = await adapter.resolveModel('agy-test', 'gemini-flash')
  assert.equal(resolved.name, 'Flash')
  assert.deepEqual(resolved.context, { contextWindow: 1_000_000 })

  const resolvedWithDescription = await adapter.resolveModel('agy-test', 'gemini-pro')
  assert.equal(resolvedWithDescription.description, undefined)

  const unknown = await adapter.resolveModel('agy-test', 'gemini-not-in-catalog')
  assert.equal(unknown.id, 'gemini-not-in-catalog')
  assert.equal(unknown.name, 'gemini-not-in-catalog')
})

test('AgyAdapter merges quota-free AGY model discovery with static metadata', async () => {
  const captured = []
  const adapter = new AgyAdapter({
    model: 'gemini-default',
    models: [{ id: 'gemini-static', name: 'Configured Static' }],
    modelDiscovery: 'auto',
  }, {
    runModelDiscovery: async requestValue => {
      captured.push(requestValue)
      return modelDiscoveryResult([
        'gemini-static\tAGY Static Label',
        'gemini-live\tGemini Live',
      ])
    },
  })

  const models = await adapter.listModels('agy-test')
  assert.deepEqual(models.map(model => model.id), ['gemini-static', 'gemini-default', 'gemini-live'])
  assert.equal(models[0]?.name, 'Configured Static')
  assert.equal(models[2]?.name, 'Gemini Live')
  assert.deepEqual(captured[0]?.args, ['models'])

  const resolved = await adapter.resolveModel('agy-test', 'gemini-live')
  assert.equal(resolved.name, 'Gemini Live')
  assert.equal(adapter.getModelDiscoveryStatus().source, 'merged')
})

test('AgyAdapter rejects DSH tools in the text-only MVP with actionable guidance', async () => {
  const adapter = new AgyAdapter({}, { runAgyProcess: fakeRunner([], []) })
  await assert.rejects(
    async () => {
      for await (const _chunk of adapter.stream({
        ...request,
        tools: [{ name: 'fixture', description: 'fixture', parameters: {} }],
      })) {}
    },
    error => error.code === 'UNSUPPORTED_TOOLS' && error.message.includes('toolPolicy: dsh-owned'),
  )
})

test('AgyAdapter bridges a validated DSH-owned tool call without exposing AGY tools', async () => {
  const captured = []
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    toolPolicy: 'dsh-owned',
    agent: 'must-be-overridden',
  }, {
    dshContext: trustedDshContext(),
    runAgyProcess: fakeRunner([
      { event: 'step_update', step_update: { text_delta: 'intermediate text must not leak' } },
      {
        event: 'result',
        result: {
          status: 'SUCCESS',
          response: '{"kind":"tool_call","name":"read_file","arguments":{"path":"fixture.txt"}}',
          usage: { totalTokens: 17 },
        },
      },
    ], captured),
  })

  const chunks = []
  for await (const chunk of adapter.stream({
    ...request,
    model: 'claude-sonnet-4-6',
    sessionId: 'session-1',
    tools: [readFileTool],
  })) chunks.push(chunk)

  assert.equal(captured[0]?.agent, 'dsh-agy-tool-free')
  assert.equal(Object.hasOwn(captured[0] ?? {}, 'jsonSchemaPath'), false)
  assert.equal(Object.hasOwn(captured[0] ?? {}, 'cwd'), false)
  assert.equal(Object.hasOwn(captured[0] ?? {}, 'addDirs'), false)
  assert.equal(Object.hasOwn(captured[0] ?? {}, 'mode'), false)
  assert.equal(JSON.stringify(captured[0] ?? {}).includes('dangerously-skip-permissions'), false)
  assert.match(captured[0]?.prompt ?? '', /=== DSH TOOL PROTOCOL V1 ===/)
  assert.match(captured[0]?.prompt ?? '', /read_file/)
  assert.match(captured[0]?.prompt ?? '', /DSH owns every tool execution/)
  assert.equal(chunks.some(chunk => chunk.type === 'text-delta'), false)
  const toolDelta = chunks.find(chunk => chunk.type === 'tool-call-delta')
  assert.equal(toolDelta?.name, 'read_file')
  assert.deepEqual(JSON.parse(toolDelta?.argumentsDelta ?? '{}'), { path: 'fixture.txt' })
  assert.deepEqual(chunks.find(chunk => chunk.type === 'block-end')?.block, {
    type: 'tool-call',
    id: toolDelta?.id,
    name: 'read_file',
    arguments: '{"path":"fixture.txt"}',
  })
  assert.deepEqual(chunks.find(chunk => chunk.type === 'usage')?.usage, {
    inputTokens: 17,
    outputTokens: 0,
  })
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
})

test('AgyAdapter safely normalizes the observed pwsh description omission', async () => {
  const captured = []
  const logs = []
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    toolPolicy: 'dsh-owned',
    modelDiscovery: 'off',
  }, {
    dshContext: trustedDshContext(),
    logger: record => logs.push(record),
    runAgyProcess: fakeRunner([
      {
        event: 'result',
        result: {
          status: 'SUCCESS',
          response: '{"kind":"tool_call","name":"pwsh","arguments":{"command":"adb devices"}}',
        },
      },
    ], captured),
  })

  const chunks = []
  for await (const chunk of adapter.stream({
    ...request,
    sessionId: 'session-1',
    tools: [pwshTool],
  })) chunks.push(chunk)

  assert.equal(captured.length, 1)
  assert.deepEqual(
    JSON.parse(chunks.find(chunk => chunk.type === 'tool-call-delta')?.argumentsDelta ?? '{}'),
    {
      command: 'adb devices',
      description: 'Execute the requested PowerShell command',
    },
  )
  const completed = logs.find(record => record.event === 'agy.request.completed')
  assert.equal(completed?.protocolCompatibilityApplied, 'pwsh-description-default')
  assert.equal(completed?.protocolRepairAttempts, 0)
})

test('AgyAdapter accepts a pwsh command with raw multiline JSON controls without a model retry', async () => {
  const logs = []
  const raw = `{"kind":"tool_call","name":"pwsh","arguments":{"command":"python
print(1)","description":"run multiline script"}}`
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    toolPolicy: 'dsh-owned',
    modelDiscovery: 'off',
  }, {
    dshContext: trustedDshContext(),
    logger: record => logs.push(record),
    runAgyProcess: fakeRunner([
      { event: 'result', result: { status: 'SUCCESS', response: raw } },
    ], []),
  })

  const chunks = []
  for await (const chunk of adapter.stream({
    ...request,
    sessionId: 'session-1',
    tools: [pwshTool],
  })) chunks.push(chunk)

  assert.deepEqual(
    JSON.parse(chunks.find(chunk => chunk.type === 'tool-call-delta')?.argumentsDelta ?? '{}'),
    { command: 'python\nprint(1)', description: 'run multiline script' },
  )
  assert.equal(logs.at(-1)?.protocolRepairAttempts, 0)
  assert.equal(logs.at(-1)?.protocolCompatibilityApplied, 'json-control-character-escape')
})

test('AgyAdapter canonicalizes the observed AGY call envelope without handing execution to AGY', async () => {
  const logs = []
  const raw = JSON.stringify({
    kind: 'call',
    call: {
      id: 'check-release-scripts',
      name: 'pwsh',
      arguments: JSON.stringify({ command: 'adb devices', description: 'probe devices' }),
    },
  })
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    toolPolicy: 'dsh-owned',
    modelDiscovery: 'off',
  }, {
    dshContext: trustedDshContext(),
    logger: record => logs.push(record),
    runAgyProcess: fakeRunner([
      { event: 'result', result: { status: 'SUCCESS', response: raw } },
    ], []),
  })

  const chunks = []
  for await (const chunk of adapter.stream({
    ...request,
    sessionId: 'session-1',
    tools: [pwshTool],
  })) chunks.push(chunk)

  assert.deepEqual(
    JSON.parse(chunks.find(chunk => chunk.type === 'tool-call-delta')?.argumentsDelta ?? '{}'),
    { command: 'adb devices', description: 'probe devices' },
  )
  assert.equal(logs.at(-1)?.bridgeOutcome, 'dsh-tool-call')
  assert.equal(logs.at(-1)?.protocolCompatibilityApplied, 'agy-call-envelope')
})

test('AgyAdapter canonicalizes the observed rationale command envelope', async () => {
  const logs = []
  const raw = JSON.stringify({
    rationale: 'Build all release APKs with Gradle.',
    command: {
      id: 'build-release-apks',
      name: 'pwsh',
      arguments: JSON.stringify({ command: 'gradlew assembleRelease', description: 'Build release APKs' }),
    },
  })
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    toolPolicy: 'dsh-owned',
    modelDiscovery: 'off',
  }, {
    dshContext: trustedDshContext(),
    logger: record => logs.push(record),
    runAgyProcess: fakeRunner([
      { event: 'result', result: { status: 'SUCCESS', response: raw } },
    ], []),
  })

  const chunks = []
  for await (const chunk of adapter.stream({
    ...request,
    sessionId: 'session-1',
    tools: [pwshTool],
  })) chunks.push(chunk)

  assert.deepEqual(
    JSON.parse(chunks.find(chunk => chunk.type === 'tool-call-delta')?.argumentsDelta ?? '{}'),
    { command: 'gradlew assembleRelease', description: 'Build release APKs' },
  )
  assert.equal(logs.at(-1)?.bridgeOutcome, 'dsh-tool-call')
  assert.equal(logs.at(-1)?.protocolCompatibilityApplied, 'agy-command-envelope')
})

test('AgyAdapter canonicalizes the observed thought call envelope', async () => {
  const logs = []
  const raw = JSON.stringify({
    thought: 'Build all release variants.',
    call: {
      name: 'pwsh',
      arguments: { command: 'gradlew assembleRelease', description: 'Build release APKs' },
    },
  })
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    toolPolicy: 'dsh-owned',
    modelDiscovery: 'off',
  }, {
    dshContext: trustedDshContext(),
    logger: record => logs.push(record),
    runAgyProcess: fakeRunner([
      { event: 'result', result: { status: 'SUCCESS', response: raw } },
    ], []),
  })

  const chunks = []
  for await (const chunk of adapter.stream({
    ...request,
    sessionId: 'session-1',
    tools: [pwshTool],
  })) chunks.push(chunk)

  assert.deepEqual(
    JSON.parse(chunks.find(chunk => chunk.type === 'tool-call-delta')?.argumentsDelta ?? '{}'),
    { command: 'gradlew assembleRelease', description: 'Build release APKs' },
  )
  assert.equal(logs.at(-1)?.bridgeOutcome, 'dsh-tool-call')
  assert.equal(logs.at(-1)?.protocolCompatibilityApplied, 'agy-thought-call-envelope')
})

test('AgyAdapter canonicalizes the observed bare call envelope', async () => {
  const logs = []
  const raw = JSON.stringify({
    call: {
      id: 'check-release-apks',
      name: 'pwsh',
      arguments: { command: 'Get-ChildItem -Path android/app/build/outputs/apk -Recurse -Filter "*.apk"', description: 'Check generated release APK outputs' },
    },
  })
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    toolPolicy: 'dsh-owned',
    modelDiscovery: 'off',
  }, {
    dshContext: trustedDshContext(),
    logger: record => logs.push(record),
    runAgyProcess: fakeRunner([
      { event: 'result', result: { status: 'SUCCESS', response: raw } },
    ], []),
  })

  const chunks = []
  for await (const chunk of adapter.stream({
    ...request,
    sessionId: 'session-1',
    tools: [pwshTool],
  })) chunks.push(chunk)

  assert.deepEqual(
    JSON.parse(chunks.find(chunk => chunk.type === 'tool-call-delta')?.argumentsDelta ?? '{}'),
    { command: 'Get-ChildItem -Path android/app/build/outputs/apk -Recurse -Filter "*.apk"', description: 'Check generated release APK outputs' },
  )
  assert.equal(logs.at(-1)?.bridgeOutcome, 'dsh-tool-call')
  assert.equal(logs.at(-1)?.protocolCompatibilityApplied, 'agy-bare-call-envelope')
})

test('AgyAdapter repairs one DSH argument schema mismatch with bounded diagnostics', async () => {
  const captured = []
  const logs = []
  let invocation = 0
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    toolPolicy: 'dsh-owned',
    modelDiscovery: 'off',
  }, {
    dshContext: trustedDshContext(),
    logger: record => logs.push(record),
    runAgyProcess: async requestValue => {
      captured.push(requestValue)
      requestValue.onStdoutLine?.(JSON.stringify({
        event: 'result',
        result: {
          status: 'SUCCESS',
          response: invocation++ === 0
            ? '{"kind":"tool_call","name":"read_file","arguments":{}}'
            : '{"kind":"message","content":"repaired"}',
        },
      }))
      return result()
    },
  })

  const chunks = []
  for await (const chunk of adapter.stream({
    ...request,
    sessionId: 'session-1',
    tools: [readFileTool],
  })) chunks.push(chunk)

  assert.equal(captured.length, 2)
  assert.match(captured[1]?.prompt ?? '', /DSH TOOL PROTOCOL REPAIR/)
  assert.match(captured[1]?.prompt ?? '', /Missing required keys: \["path"\]/)
  assert.equal(chunks.find(chunk => chunk.type === 'text-delta')?.text, 'repaired')
  const completed = logs.find(record => record.event === 'agy.request.completed')
  assert.equal(completed?.protocolRepairAttempts, 1)
  assert.equal(completed?.protocolRepairReason, 'arguments-invalid')
  assert.equal(completed?.protocolToolName, 'read_file')
  assert.equal(completed?.protocolArgumentIssue, 'missing-required')
  assert.deepEqual(completed?.protocolMissingRequiredKeys, ['path'])
  assert.equal(JSON.stringify(logs).includes('fixture.txt'), false)
})

test('AgyAdapter serializes a DSH tool result into the next DSH-owned request', async () => {
  const captured = []
  let invocation = 0
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    toolPolicy: 'dsh-owned',
    modelDiscovery: 'off',
  }, {
    dshContext: trustedDshContext(),
    runAgyProcess: async requestValue => {
      captured.push(requestValue)
      requestValue.onStdoutLine?.(JSON.stringify({
        event: 'result',
        result: {
          status: 'SUCCESS',
          response: invocation++ === 0
            ? '{"kind":"tool_call","name":"read_file","arguments":{"path":"fixture.txt"}}'
            : '{"kind":"message","content":"tool result received"}',
        },
      }))
      return result()
    },
  })

  const firstChunks = []
  for await (const chunk of adapter.stream({
    ...request,
    sessionId: 'session-1',
    tools: [readFileTool],
  })) firstChunks.push(chunk)
  const firstCall = firstChunks.find(chunk => chunk.type === 'block-end')?.block
  assert.equal(firstCall?.type, 'tool-call')

  const secondChunks = []
  for await (const chunk of adapter.stream({
    ...request,
    sessionId: 'session-1',
    messages: [
      request.messages[0],
      {
        role: 'assistant',
        content: [{
          type: 'tool-call',
          id: firstCall.id,
          name: firstCall.name,
          arguments: firstCall.arguments,
        }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: firstCall.id,
          content: [{ type: 'text', text: 'FIXTURE_PROBE_EXECUTED' }],
        }],
      },
    ],
    tools: [readFileTool],
  })) secondChunks.push(chunk)

  assert.equal(captured.length, 2)
  assert.match(captured[1]?.prompt ?? '', /\[DSH TOOL RESULT\]/)
  assert.match(captured[1]?.prompt ?? '', /FIXTURE_PROBE_EXECUTED/)
  assert.equal(secondChunks.find(chunk => chunk.type === 'text-delta')?.text, 'tool result received')
})

test('AgyAdapter bounds oversized DSH tool results before sending AGY input', async () => {
  const captured = []
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    toolPolicy: 'dsh-owned',
    modelDiscovery: 'off',
    inputFrameLimitBytes: 16 * 1024,
    maxSingleToolResultBytes: 4 * 1024,
    maxHistoricalToolResultBytes: 8 * 1024,
  }, {
    dshContext: trustedDshContext(),
    runAgyProcess: fakeRunner([
      { event: 'result', result: { status: 'SUCCESS', response: '{"kind":"message","content":"bounded"}' } },
    ], captured),
  })

  const chunks = []
  for await (const chunk of adapter.stream({
    ...request,
    sessionId: 'session-1',
    messages: [
      request.messages[0],
      {
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'call-1', name: 'read_file', arguments: '{"path":"fixture.txt"}' }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: 'call-1',
          content: [{ type: 'text', text: '😀'.repeat(20_000) }],
        }],
      },
    ],
    tools: [readFileTool],
  })) chunks.push(chunk)

  assert.ok(captured.length >= 1)
  assert.ok(getAgyUserMessageByteLength(captured[0].prompt) <= 16 * 1024)
  assert.match(captured[0].prompt, /\[DSH TOOL RESULT TRUNCATED\]/)
  assert.equal(chunks.find(chunk => chunk.type === 'text-delta')?.text, 'bounded')
})

test('AgyAdapter records safe history compaction telemetry and preserves the current request', async () => {
  const captured = []
  const logs = []
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    toolPolicy: 'dsh-owned',
    modelDiscovery: 'off',
  }, {
    dshContext: trustedDshContext(),
    logger: record => logs.push(record),
    runAgyProcess: fakeRunner([
      { event: 'result', result: { status: 'SUCCESS', response: '{"kind":"message","content":"compacted"}' } },
    ], captured),
  })

  const messages = [
    request.messages[0],
    ...Array.from({ length: 45 }, (_, index) => ({
      role: 'assistant',
      content: [{ type: 'text', text: `old-turn-${index}\n${'context '.repeat(900)}` }],
    })),
    {
      role: 'user',
      content: [{ type: 'text', text: 'CURRENT_PROVIDER_REQUEST_MUST_SURVIVE' }],
    },
  ]
  const chunks = []
  for await (const chunk of adapter.stream({
    ...request,
    sessionId: 'session-1',
    messages,
    tools: [readFileTool],
  })) chunks.push(chunk)

  assert.equal(chunks.find(chunk => chunk.type === 'text-delta')?.text, 'compacted')
  assert.equal(captured.length, 1)
  assert.ok(captured[0].prompt.length > 0)
  assert.match(captured[0].prompt, /CURRENT_PROVIDER_REQUEST_MUST_SURVIVE/)
  const completed = logs.find(record => record.event === 'agy.request.completed')
  assert.equal(completed?.historyCompacted, true)
  assert.ok((completed?.omittedMessageCount ?? 0) > 0)
  assert.equal(completed?.promptLimitBytes, 56 * 1024)
})

test('AgyAdapter rejects an oversized current DSH prompt before AGY can return an invalid envelope', async () => {
  const captured = []
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    toolPolicy: 'dsh-owned',
    modelDiscovery: 'off',
  }, {
    dshContext: trustedDshContext(),
    runAgyProcess: fakeRunner([
      { event: 'result', result: { status: 'SUCCESS', response: '{"kind":"message","content":"should-not-run"}' } },
    ], captured),
  })

  await assert.rejects(
    (async () => {
      for await (const _chunk of adapter.stream({
        ...request,
        sessionId: 'session-1',
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: 'x'.repeat(70_000) }],
        }],
        tools: [readFileTool],
      })) {}
    })(),
    error => error?.code === 'AGY_INPUT_TOO_LARGE',
  )
  assert.equal(captured.length, 0)
})

test('AgyAdapter repairs one non-JSON DSH-owned response and records the retry', async () => {
  const captured = []
  const logs = []
  let invocation = 0
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    toolPolicy: 'dsh-owned',
    modelDiscovery: 'off',
  }, {
    dshContext: trustedDshContext(),
    logger: record => logs.push(record),
    runAgyProcess: async requestValue => {
      captured.push(requestValue)
      requestValue.onStdoutLine?.(JSON.stringify({
        event: 'result',
        result: {
          status: 'SUCCESS',
          response: invocation++ === 0 ? 'I will continue with the result.' : '{"kind":"message","content":"repaired"}',
        },
      }))
      return result()
    },
  })

  const chunks = []
  for await (const chunk of adapter.stream({
    ...request,
    sessionId: 'session-1',
    tools: [readFileTool],
  })) chunks.push(chunk)

  assert.equal(captured.length, 2)
  assert.match(captured[1].prompt, /=== DSH TOOL PROTOCOL REPAIR ===/)
  assert.equal(chunks.find(chunk => chunk.type === 'text-delta')?.text, 'repaired')
  assert.equal(chunks.find(chunk => chunk.type === 'finish')?.reason.kind, 'stop')
  const completed = logs.find(record => record.event === 'agy.request.completed')
  assert.equal(completed?.protocolRepairAttempts, 1)
})

test('AgyAdapter can disable plain-text fallback after a failed protocol repair', async () => {
  const captured = []
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    toolPolicy: 'dsh-owned',
    modelDiscovery: 'off',
    toolProtocolPlainTextFallback: 'off',
  }, {
    dshContext: trustedDshContext(),
    runAgyProcess: async requestValue => {
      captured.push(requestValue)
      requestValue.onStdoutLine?.(JSON.stringify({
        event: 'result',
        result: { status: 'SUCCESS', response: 'still not JSON' },
      }))
      return result()
    },
  })

  await assert.rejects(
    async () => {
      for await (const _chunk of adapter.stream({
        ...request,
        sessionId: 'session-1',
        tools: [readFileTool],
      })) {}
    },
    error => error.code === 'TOOL_PROTOCOL_RESPONSE_INVALID',
  )
  assert.equal(captured.length, 2)
  assert.match(captured[1].prompt, /DSH TOOL PROTOCOL REPAIR/)
})

test('AgyAdapter rejects plain Gemini text after a failed protocol repair by default', async () => {
  const captured = []
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    toolPolicy: 'dsh-owned',
    modelDiscovery: 'off',
  }, {
    dshContext: trustedDshContext(),
    runAgyProcess: async requestValue => {
      captured.push(requestValue)
      requestValue.onStdoutLine?.(JSON.stringify({
        event: 'result',
        result: { status: 'SUCCESS', response: 'stale prose is not a DSH envelope' },
      }))
      return result()
    },
  })

  await assert.rejects(
    async () => {
      for await (const _chunk of adapter.stream({
        ...request,
        sessionId: 'session-1',
        tools: [readFileTool],
      })) {}
    },
    error => error.code === 'TOOL_PROTOCOL_RESPONSE_INVALID',
  )
  assert.equal(captured.length, 2)
  assert.match(captured[1].prompt, /DSH TOOL PROTOCOL REPAIR/)
})

test('AgyAdapter records safe shape metadata for a malformed structured response', async () => {
  const logs = []
  const raw = '{"kind":"message","content":"unterminated'
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    toolPolicy: 'dsh-owned',
    modelDiscovery: 'off',
    toolProtocolPlainTextFallback: 'off',
  }, {
    dshContext: trustedDshContext(),
    logger: record => logs.push(record),
    runAgyProcess: async requestValue => {
      requestValue.onStdoutLine?.(JSON.stringify({
        event: 'result',
        result: { status: 'SUCCESS', response: raw },
      }))
      return result()
    },
  })

  await assert.rejects(
    async () => {
      for await (const _chunk of adapter.stream({
        ...request,
        sessionId: 'session-1',
        tools: [readFileTool],
      })) {}
    },
    error => error.code === 'TOOL_PROTOCOL_RESPONSE_INVALID',
  )

  const failed = logs.at(-1)
  assert.equal(failed?.protocolRepairAttempts, 1)
  assert.equal(failed?.protocolFailureDetail, 'not-json')
  assert.equal(failed?.protocolResponseShape, 'object-like')
  assert.equal(failed?.protocolResponseBytes, Buffer.byteLength(raw, 'utf8'))
  assert.equal(JSON.stringify(logs).includes(raw), false)
})

test('AgyAdapter treats a plain Claude final response as a message without weakening tool calls', async () => {
  const adapter = new AgyAdapter({ model: 'claude-sonnet-4-6', toolPolicy: 'dsh-owned' }, {
    dshContext: trustedDshContext(),
    runAgyProcess: fakeRunner([
      { event: 'result', result: { status: 'SUCCESS', response: 'claudeok' } },
    ], []),
  })

  const chunks = []
  for await (const chunk of adapter.stream({
    ...request,
    model: 'claude-sonnet-4-6',
    sessionId: 'session-1',
    tools: [readFileTool],
  })) chunks.push(chunk)

  assert.equal(chunks.find(chunk => chunk.type === 'text-delta')?.text, 'claudeok')
  assert.equal(chunks.find(chunk => chunk.type === 'finish')?.reason.kind, 'stop')
})

test('AgyAdapter still rejects malformed JSON-looking Claude output', async () => {
  const adapter = new AgyAdapter({ model: 'claude-sonnet-4-6', toolPolicy: 'dsh-owned' }, {
    dshContext: trustedDshContext(),
    runAgyProcess: fakeRunner([
      { event: 'result', result: { status: 'SUCCESS', response: '{"kind":"message"' } },
    ], []),
  })

  await assert.rejects(
    async () => {
      for await (const _chunk of adapter.stream({
        ...request,
        model: 'claude-sonnet-4-6',
        sessionId: 'session-1',
        tools: [readFileTool],
      })) {}
    },
    error => error.code === 'TOOL_PROTOCOL_RESPONSE_INVALID',
  )
})

test('AgyAdapter fails closed when DSH-owned AGY output is not exactly one valid envelope', async () => {
  const adapter = new AgyAdapter({ model: 'gemini-test', toolPolicy: 'dsh-owned' }, {
    dshContext: trustedDshContext(),
    runAgyProcess: fakeRunner([
      {
        event: 'result',
        result: {
          status: 'SUCCESS',
          response: '{"kind":"tool_call","name":"read_file","arguments":{"path":"fixture.txt"}}\nextra',
        },
      },
    ], []),
  })

  await assert.rejects(
    async () => {
      for await (const _chunk of adapter.stream({
        ...request,
        sessionId: 'session-1',
        tools: [readFileTool],
      })) {}
    },
    error => error.code === 'TOOL_PROTOCOL_RESPONSE_INVALID',
  )
})

test('AgyAdapter rejects duplicate AGY final responses in DSH-owned mode', async () => {
  const adapter = new AgyAdapter({ model: 'gemini-test', toolPolicy: 'dsh-owned' }, {
    dshContext: trustedDshContext(),
    runAgyProcess: fakeRunner([
      { event: 'result', result: { status: 'SUCCESS', response: '{"kind":"message","content":"one"}' } },
      { event: 'result', result: { status: 'SUCCESS', response: '{"kind":"message","content":"two"}' } },
    ], []),
  })

  await assert.rejects(
    async () => {
      for await (const _chunk of adapter.stream({
        ...request,
        sessionId: 'session-1',
        tools: [readFileTool],
      })) {}
    },
    error => error.code === 'TOOL_PROTOCOL_RESPONSE_INVALID',
  )
})

test('AgyAdapter rejects an internal AGY tool event while DSH owns tools', async () => {
  const logs = []
  const adapter = new AgyAdapter({ model: 'gemini-test', toolPolicy: 'dsh-owned' }, {
    dshContext: trustedDshContext(),
    logger: record => logs.push(record),
    runAgyProcess: fakeRunner([
      { event: 'step_update', step_update: { step_type: 'tool', tool_name: 'shell' } },
      { event: 'result', result: { status: 'SUCCESS', response: '{"kind":"message","content":"done"}' } },
    ], []),
  })

  await assert.rejects(
    async () => {
      for await (const _chunk of adapter.stream({
        ...request,
        sessionId: 'session-1',
        tools: [readFileTool],
      })) {}
    },
    error => error.code === 'AGY_INTERNAL_TOOL_EVENT',
  )
  assert.equal(logs.at(-1)?.bridgeOutcome, 'agy-internal-tool')
  assert.equal(logs.at(-1)?.toolEventKind, 'step-type-tool')
  assert.equal(logs.at(-1)?.toolEventStreamIndex, 2)
  assert.deepEqual(logs.at(-1)?.toolEventDiagnostic, {
    eventName: 'step_update',
    kind: 'step-type-tool',
    stepType: 'tool',
    toolName: 'shell',
    carrierShape: 'not-send-message',
    recipientClass: 'not-applicable',
    topLevelKeys: ['event', 'step_update'],
    stepKeys: ['step_type', 'tool_name'],
    toolInputKeys: [],
  })
})

test('AgyAdapter retries once after an AGY internal send_message event without executing it', async () => {
  const captured = []
  const logs = []
  let invocation = 0
  const adapter = new AgyAdapter({ model: 'gemini-test', toolPolicy: 'dsh-owned' }, {
    dshContext: trustedDshContext(),
    logger: record => logs.push(record),
    runAgyProcess: async requestValue => {
      captured.push(requestValue)
      const events = invocation++ === 0
        ? [
            { event: 'init', conversation_id: 'internal-wrapper-session' },
            {
              event: 'step_update',
              step_update: {
                step_type: 'tool',
                tool_name: 'send_message',
                tool_input: {
                  Recipient: JSON.stringify('dsh-outer'),
                  Message: JSON.stringify(JSON.stringify({ kind: 'message', content: 'not executable' })),
                },
              },
            },
          ]
        : [{ event: 'result', result: { status: 'SUCCESS', response: '{"kind":"message","content":"recovered"}' } }]
      for (const event of events) {
        await new Promise(resolve => setTimeout(resolve, 1))
        requestValue.onStdoutLine?.(JSON.stringify(event))
      }
      return result()
    },
  })

  const chunks = []
  for await (const chunk of adapter.stream({
    ...request,
    sessionId: 'session-1',
    tools: [readFileTool],
  })) chunks.push(chunk)

  assert.equal(captured.length, 2)
  assert.match(captured[1]?.prompt ?? '', /AGY-internal tool event/)
  assert.match(captured[1]?.prompt ?? '', /do not call send_message/i)
  assert.equal(chunks.find(chunk => chunk.type === 'text-delta')?.text, 'recovered')
  const completed = logs.find(record => record.event === 'agy.request.completed')
  assert.equal(completed?.protocolRepairAttempts, 1)
  assert.equal(completed?.protocolRepairReason, 'internal-tool-event')
  assert.equal(completed?.bridgeOutcome, 'dsh-message')
})

test('AgyAdapter ignores AGY manage_task orchestration lifecycle events while DSH owns tools', async () => {
  const logs = []
  const adapter = new AgyAdapter({ model: 'gemini-test', toolPolicy: 'dsh-owned' }, {
    dshContext: trustedDshContext(),
    logger: record => logs.push(record),
    runAgyProcess: fakeRunner([
      { event: 'init', conversation_id: 'orchestration-session' },
      {
        event: 'step_update',
        step_update: { step_type: 'tool', tool_name: 'manage_task', state: 'ACTIVE' },
      },
      {
        event: 'step_update',
        step_update: { step_type: 'tool', tool_name: 'manage_task', state: 'DONE' },
      },
      { event: 'result', result: { status: 'SUCCESS', response: '{"kind":"message","content":"done"}' } },
    ], []),
  })

  const chunks = []
  for await (const chunk of adapter.stream({
    ...request,
    sessionId: 'session-1',
    tools: [readFileTool],
  })) chunks.push(chunk)

  assert.equal(chunks.find(chunk => chunk.type === 'text-delta')?.text, 'done')
  assert.equal(logs.at(-1)?.bridgeOutcome, 'dsh-message')
  assert.equal(logs.at(-1)?.toolEventCount, 2)
  assert.equal(logs.at(-1)?.toolEventDiagnostic?.toolName, 'manage_task')
  assert.equal(logs.at(-1)?.toolEventDiagnostic?.carrierShape, 'not-send-message')
})

test('AgyAdapter bridges one validated default_api send_message carrier', async () => {
  const logs = []
  const envelope = { kind: 'tool_call', name: 'read_file', arguments: { path: 'fixture.txt' } }
  const adapter = new AgyAdapter({ model: 'gemini-test', toolPolicy: 'dsh-owned' }, {
    dshContext: trustedDshContext(),
    logger: record => logs.push(record),
    runAgyProcess: fakeRunner([
      { event: 'init', conversation_id: 'tainted-wrapper-session' },
      {
        event: 'step_update',
        step_update: {
          step_type: 'tool',
          tool_name: 'send_message',
          tool_input: {
            Recipient: JSON.stringify('default_api'),
            Message: JSON.stringify(JSON.stringify(envelope)),
          },
        },
      },
      {
        event: 'result',
        result: { status: 'SUCCESS', response: JSON.stringify({ kind: 'message', content: 'late wrapper output' }) },
      },
    ], []),
  })

  const chunks = []
  for await (const chunk of adapter.stream({
    ...request,
    sessionId: 'session-1',
    tools: [readFileTool],
  })) chunks.push(chunk)

  const call = chunks.find(chunk => chunk.type === 'block-end')?.block
  assert.equal(call?.type, 'tool-call')
  assert.equal(call?.name, 'read_file')
  assert.equal(logs.at(-1)?.bridgeOutcome, 'dsh-tool-call')
  assert.equal(logs.at(-1)?.toolEventStreamIndex, 2)
  assert.equal(logs.at(-1)?.toolEventDiagnostic?.carrierShape, 'complete')
  assert.equal(logs.at(-1)?.toolEventDiagnostic?.recipientClass, 'default-api')
  assert.deepEqual(logs.at(-1)?.toolEventDiagnostic?.toolInputKeys, ['message', 'recipient'])
  assert.equal(logs.at(-1)?.carrierAbortExpected, true)
  assert.equal(logs.at(-1)?.carrierValidation, 'valid-tool-call')
  assert.equal(adapter.getSession('session-1'), undefined)
})

test('AgyAdapter bridges a validated send_message carrier addressed to the active AGY conversation', async () => {
  const logs = []
  const envelope = { kind: 'tool_call', name: 'read_file', arguments: { path: 'fixture.txt' } }
  const adapter = new AgyAdapter({ model: 'gemini-test', toolPolicy: 'dsh-owned' }, {
    dshContext: trustedDshContext(),
    logger: record => logs.push(record),
    runAgyProcess: fakeRunner([
      { event: 'init', conversation_id: 'root-wrapper-session' },
      {
        event: 'step_update',
        step_update: {
          step_type: 'tool',
          tool_name: 'send_message',
          state: {
            tool_input: {
              Recipient: JSON.stringify('root-wrapper-session'),
              Message: JSON.stringify(JSON.stringify(envelope)),
            },
          },
        },
      },
      {
        event: 'result',
        result: { status: 'SUCCESS', response: JSON.stringify({ kind: 'message', content: 'late wrapper output' }) },
      },
    ], []),
  })

  const chunks = []
  for await (const chunk of adapter.stream({
    ...request,
    sessionId: 'session-1',
    tools: [readFileTool],
  })) chunks.push(chunk)

  const call = chunks.find(chunk => chunk.type === 'block-end')?.block
  assert.equal(call?.type, 'tool-call')
  assert.equal(call?.name, 'read_file')
  assert.equal(logs.at(-1)?.bridgeOutcome, 'dsh-tool-call')
  assert.equal(logs.at(-1)?.toolEventDiagnostic?.recipientClass, 'self-conversation')
  assert.equal(logs.at(-1)?.carrierAbortExpected, true)
  assert.equal(logs.at(-1)?.carrierValidation, 'valid-tool-call')
  assert.equal(adapter.getSession('session-1'), undefined)
})

test('AgyAdapter bridges validated send_message carriers addressed to stable DSH runtime recipients', async () => {
  for (const recipient of ['dsh', 'dsh-session', 'dsh-runner']) {
    const logs = []
    const envelope = { kind: 'tool_call', name: 'read_file', arguments: { path: 'fixture.txt' } }
    const adapter = new AgyAdapter({ model: 'gemini-test', toolPolicy: 'dsh-owned' }, {
      dshContext: trustedDshContext(),
      logger: record => logs.push(record),
      runAgyProcess: fakeRunner([
        { event: 'init', conversation_id: 'root-wrapper-session' },
        {
          event: 'step_update',
          step_update: {
            step_type: 'tool',
            tool_name: 'send_message',
            tool_input: {
              Recipient: JSON.stringify(recipient),
              Message: JSON.stringify(JSON.stringify(envelope)),
            },
          },
        },
      ], []),
    })

    const chunks = []
    for await (const chunk of adapter.stream({
      ...request,
      sessionId: 'session-1',
      tools: [readFileTool],
    })) chunks.push(chunk)

    const call = chunks.find(chunk => chunk.type === 'block-end')?.block
    assert.equal(call?.type, 'tool-call')
    assert.equal(call?.name, 'read_file')
    assert.equal(logs.at(-1)?.bridgeOutcome, 'dsh-tool-call')
    assert.equal(logs.at(-1)?.toolEventDiagnostic?.recipientClass, 'dsh-recipient')
    assert.equal(logs.at(-1)?.carrierAbortExpected, true)
    assert.equal(logs.at(-1)?.carrierValidation, 'valid-tool-call')
  }
})

test('AgyAdapter applies pwsh compatibility to a validated send_message carrier', async () => {
  const logs = []
  const envelope = {
    kind: 'tool_call',
    name: 'pwsh',
    arguments: { command: 'adb devices' },
  }
  const adapter = new AgyAdapter({ model: 'gemini-test', toolPolicy: 'dsh-owned' }, {
    dshContext: trustedDshContext(),
    logger: record => logs.push(record),
    runAgyProcess: fakeRunner([
      { event: 'init', conversation_id: 'carrier-wrapper-session' },
      {
        event: 'step_update',
        step_update: {
          step_type: 'tool',
          tool_name: 'send_message',
          tool_input: {
            Recipient: JSON.stringify('default_api'),
            Message: JSON.stringify(JSON.stringify(envelope)),
          },
        },
      },
    ], []),
  })

  const chunks = []
  for await (const chunk of adapter.stream({
    ...request,
    sessionId: 'session-1',
    tools: [pwshTool],
  })) chunks.push(chunk)

  assert.deepEqual(
    JSON.parse(chunks.find(chunk => chunk.type === 'tool-call-delta')?.argumentsDelta ?? '{}'),
    {
      command: 'adb devices',
      description: 'Execute the requested PowerShell command',
    },
  )
  assert.equal(logs.at(-1)?.carrierValidation, 'valid-tool-call')
  assert.equal(logs.at(-1)?.protocolCompatibilityApplied, 'pwsh-description-default')
})

test('AgyAdapter rejects a valid carrier addressed to a different AGY conversation', async () => {
  const logs = []
  const envelope = { kind: 'tool_call', name: 'read_file', arguments: { path: 'fixture.txt' } }
  const adapter = new AgyAdapter({ model: 'gemini-test', toolPolicy: 'dsh-owned' }, {
    dshContext: trustedDshContext(),
    logger: record => logs.push(record),
    runAgyProcess: fakeRunner([
      { event: 'init', conversation_id: 'root-wrapper-session' },
      {
        event: 'step_update',
        step_update: {
          step_type: 'tool',
          tool_name: 'send_message',
          tool_input: {
            Recipient: JSON.stringify('different-wrapper-session'),
            Message: JSON.stringify(JSON.stringify(envelope)),
          },
        },
      },
    ], []),
  })

  await assert.rejects(
    async () => {
      for await (const _chunk of adapter.stream({
        ...request,
        sessionId: 'session-1',
        tools: [readFileTool],
      })) {}
    },
    error => error.code === 'AGY_INTERNAL_TOOL_EVENT',
  )
  assert.equal(logs.at(-1)?.bridgeOutcome, 'agy-internal-tool')
  assert.equal(logs.at(-1)?.toolEventDiagnostic?.recipientClass, 'other-conversation')
  assert.equal(logs.at(-1)?.carrierValidation, 'recipient-rejected')
})

test('AgyAdapter validates a self-conversation carrier before accepting it', async () => {
  const logs = []
  const adapter = new AgyAdapter({ model: 'gemini-test', toolPolicy: 'dsh-owned' }, {
    dshContext: trustedDshContext(),
    logger: record => logs.push(record),
    runAgyProcess: fakeRunner([
      { event: 'init', conversation_id: 'root-wrapper-session' },
      {
        event: 'step_update',
        step_update: {
          step_type: 'tool',
          tool_name: 'send_message',
          tool_input: {
            Recipient: JSON.stringify('root-wrapper-session'),
            Message: JSON.stringify('{"kind":"tool_call","name":"not-allowlisted","arguments":{}}'),
          },
        },
      },
    ], []),
  })

  await assert.rejects(
    async () => {
      for await (const _chunk of adapter.stream({
        ...request,
        sessionId: 'session-1',
        tools: [readFileTool],
      })) {}
    },
    error => error.code === 'TOOL_PROTOCOL_UNKNOWN_TOOL',
  )
  assert.equal(logs.at(-1)?.toolEventDiagnostic?.recipientClass, 'self-conversation')
  assert.equal(logs.at(-1)?.carrierValidation, 'unknown-tool')
})

test('AgyAdapter rejects an invalid self-conversation carrier envelope with a protocol error', async () => {
  const logs = []
  const adapter = new AgyAdapter({ model: 'gemini-test', toolPolicy: 'dsh-owned' }, {
    dshContext: trustedDshContext(),
    logger: record => logs.push(record),
    runAgyProcess: fakeRunner([
      { event: 'init', conversation_id: 'root-wrapper-session' },
      {
        event: 'step_update',
        step_update: {
          step_type: 'tool',
          tool_name: 'send_message',
          tool_input: {
            Recipient: JSON.stringify('root-wrapper-session'),
            Message: JSON.stringify('not-json'),
          },
        },
      },
    ], []),
  })

  await assert.rejects(
    async () => {
      for await (const _chunk of adapter.stream({
        ...request,
        sessionId: 'session-1',
        tools: [readFileTool],
      })) {}
    },
    error => error.code === 'TOOL_PROTOCOL_RESPONSE_INVALID',
  )
  assert.equal(logs.at(-1)?.toolEventDiagnostic?.recipientClass, 'self-conversation')
  assert.equal(logs.at(-1)?.carrierValidation, 'invalid-envelope')
})

test('AgyAdapter reports an incomplete send_message carrier before rejecting it', async () => {
  const logs = []
  const adapter = new AgyAdapter({ model: 'gemini-test', toolPolicy: 'dsh-owned' }, {
    dshContext: trustedDshContext(),
    logger: record => logs.push(record),
    runAgyProcess: fakeRunner([
      {
        event: 'step_update',
        step_update: {
          step_type: 'tool',
          tool_name: 'send_message',
          tool_input: { Recipient: JSON.stringify('default_api') },
        },
      },
    ], []),
  })

  await assert.rejects(
    async () => {
      for await (const _chunk of adapter.stream({
        ...request,
        sessionId: 'session-1',
        tools: [readFileTool],
      })) {}
    },
    error => error.code === 'AGY_INTERNAL_TOOL_EVENT',
  )
  assert.equal(logs.at(-1)?.toolEventDiagnostic?.carrierShape, 'missing-message')
  assert.equal(logs.at(-1)?.toolEventDiagnostic?.recipientClass, 'default-api')
  assert.deepEqual(logs.at(-1)?.toolEventDiagnostic?.toolInputKeys, ['recipient'])
})

test('AgyAdapter ignores a generic Inspect step name under DSH-owned tools', async () => {
  const adapter = new AgyAdapter({ model: 'gemini-test', toolPolicy: 'dsh-owned' }, {
    dshContext: trustedDshContext(),
    runAgyProcess: fakeRunner([
      { event: 'step_update', step_update: { step_type: 'agent_response', name: 'Inspect' } },
      { event: 'result', result: { status: 'SUCCESS', response: '{"kind":"message","content":"done"}' } },
    ], []),
  })

  const chunks = []
  for await (const chunk of adapter.stream({
    ...request,
    sessionId: 'session-1',
    tools: [readFileTool],
  })) chunks.push(chunk)

  assert.equal(chunks.find(chunk => chunk.type === 'text-delta')?.text, 'done')
})

test('official DSH runtime accepts tool schemas only with explicit AGY ownership', async () => {
  const root = new Context()
  const captured = []
  const logs = []
  await root.plugin(LlmRuntime)
  root.llm.registerAdapter(['agy-owned-runtime'], new AgyAdapter({ toolPolicy: 'agy-owned' }, {
    logger: record => logs.push(record),
    runAgyProcess: fakeRunner([
      { event: 'step_update', step_update: { step_type: 'tool', tool_name: 'list_dir', state: 'ACTIVE' } },
      { event: 'result', result: { status: 'SUCCESS', response: 'text-only response' } },
    ], captured),
  }))

  const chunks = []
  for await (const chunk of root.llm.stream({
    ...request,
    provider: 'agy-owned-runtime',
    messages: [],
    system: 'Reply with text.',
    tools: [{
      name: 'fixture',
      description: 'fixture tool',
      parameters: { secret: 'schema-secret-must-not-be-forwarded' },
    }],
  })) chunks.push(chunk)

  assert.equal(chunks.find(chunk => chunk.type === 'text-delta')?.text, 'text-only response')
  assert.equal(chunks.some(chunk => chunk.type === 'tool-call-delta'), false)
  assert.equal(chunks.some(chunk => chunk.type === 'block-end' && chunk.block?.type === 'tool-call'), false)
  assert.equal(Object.hasOwn(captured[0] ?? {}, 'tools'), false)
  assert.doesNotMatch(captured[0]?.prompt ?? '', /schema-secret-must-not-be-forwarded/)
  assert.equal(logs[0]?.toolPolicy, 'agy-owned')
  assert.equal(logs.at(-1)?.toolSchemaCount, 1)
  await root.fiber.dispose()
})

test('AgyAdapter fails fast on an AGY permission request under both tool policies with actionable guidance', async () => {
  for (const toolPolicy of ['reject', 'agy-owned', 'dsh-owned']) {
    const adapter = new AgyAdapter({ toolPolicy }, {
      runAgyProcess: async requestValue => {
        requestValue.onStdoutLine?.(JSON.stringify({ event: 'init', conversation_id: 'permission-test' }))
        requestValue.onStdoutLine?.(JSON.stringify({ event: 'permission_request', permission: { kind: 'fixture' } }))
        return result()
      },
    })
    await assert.rejects(
      async () => {
        for await (const _chunk of adapter.stream({ ...request, messages: [], system: 'reply' })) {}
      },
      error => error.code === 'PERMISSION_REQUIRED' && error.message.includes('Adjust AGY Agent permissions'),
    )
  }
})

test('AgyAdapter maps a process output limit to a stable provider error', async () => {
  const adapter = new AgyAdapter({}, {
    runAgyProcess: async () => ({
      exitCode: null,
      signal: null,
      termination: 'output-limit',
      stdoutLines: [],
      stderr: '',
      durationMs: 1,
    }),
  })
  await assert.rejects(
    async () => {
      for await (const _chunk of adapter.stream({ ...request, messages: [], system: 'reply' })) {}
    },
    error => error.code === 'AGY_OUTPUT_LIMIT',
  )
})

test('AgyAdapter registers and streams through the official DSH LLM runtime', async () => {
  const root = new Context()
  await root.plugin(LlmRuntime)
  root.llm.registerAdapter(['agy-runtime-test'], new AgyAdapter({}, {
    runAgyProcess: fakeRunner([
      { event: 'result', result: { status: 'SUCCESS', response: '123' } },
    ], []),
  }))

  const chunks = []
  for await (const chunk of root.llm.stream({
    provider: 'agy-runtime-test',
    model: 'gemini-test',
    messages: [],
    system: 'reply',
  })) chunks.push(chunk)

  assert.equal(chunks.find(chunk => chunk.type === 'text-delta')?.text, '123')
  assert.equal(chunks.at(-1)?.type, 'finish')
  await root.fiber.dispose()
})

test('AgyAdapter maps a DSH Session to --conversation and sends only the new turn', async () => {
  const captured = []
  let call = 0
  const adapter = new AgyAdapter({ model: 'gemini-test', sessionMode: 'resume' }, {
    runAgyProcess: async request => {
      captured.push({
        conversation: request.conversation,
        prompt: request.prompt,
      })
      request.onStdoutLine?.(JSON.stringify({ event: 'init', conversation_id: 'conversation-a' }))
      request.onStdoutLine?.(JSON.stringify({
        event: 'result',
        result: { status: 'SUCCESS', response: call++ === 0 ? 'first' : 'second' },
      }))
      return result()
    },
  })

  const sessionId = 'session-a'
  for await (const _chunk of adapter.stream({
    ...request,
    sessionId,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'first' }] }],
  })) {}
  const secondMessages = [
    { role: 'user', content: [{ type: 'text', text: 'first' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'first' }] },
    { role: 'user', content: [{ type: 'text', text: 'second' }] },
  ]
  for await (const _chunk of adapter.stream({ ...request, sessionId, messages: secondMessages })) {}

  assert.equal(captured[0].conversation, undefined)
  assert.equal(captured[1].conversation, 'conversation-a')
  assert.match(captured[0].prompt, /first/)
  assert.doesNotMatch(captured[1].prompt, /first/)
  assert.match(captured[1].prompt, /second/)
  assert.equal(adapter.getSession(sessionId)?.conversationId, 'conversation-a')
  assert.equal(adapter.clearSession(sessionId), true)
  assert.equal(adapter.getSession(sessionId), undefined)
})

test('AgyAdapter clears a resumed AGY conversation after a one-shot timeout', async () => {
  const sessionId = 'session-timeout'
  const timeoutResult = { ...result(), termination: 'timeout' }
  const adapter = new AgyAdapter({ model: 'gemini-test', sessionMode: 'resume' }, {
    runAgyProcess: async requestValue => {
      requestValue.onStdoutLine?.(JSON.stringify({ event: 'init', conversation_id: 'conversation-partial' }))
      return timeoutResult
    },
  })

  await assert.rejects((async () => {
    for await (const _chunk of adapter.stream({ ...request, sessionId })) {}
  })(), error => error.code === 'TIMEOUT')
  assert.equal(adapter.getSession(sessionId), undefined)
})

test('AgyAdapter retries with full DSH history when AGY resumes a different conversation', async () => {
  const captured = []
  let call = 0
  const adapter = new AgyAdapter({ model: 'gemini-test', sessionMode: 'resume' }, {
    runAgyProcess: async request => {
      const index = call++
      captured.push({ conversation: request.conversation, prompt: request.prompt })
      request.onStdoutLine?.(JSON.stringify({
        event: 'init',
        conversation_id: index === 0 ? 'conversation-old' : index === 1 ? 'conversation-new' : 'conversation-new',
      }))
      request.onStdoutLine?.(JSON.stringify({
        event: 'result',
        result: { status: 'SUCCESS', response: index === 2 ? 'recovered' : 'discarded' },
      }))
      return result()
    },
  })

  const sessionId = 'session-recovery'
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'full history' }] }]
  for await (const _chunk of adapter.stream({ ...request, sessionId, messages })) {}
  const chunks = []
  for await (const chunk of adapter.stream({ ...request, sessionId, messages })) chunks.push(chunk)

  assert.equal(chunks.find(chunk => chunk.type === 'text-delta')?.text, 'recovered')
  assert.deepEqual(captured.map(item => item.conversation), [undefined, 'conversation-old', undefined])
  assert.match(captured[2].prompt, /full history/)
  assert.equal(adapter.getSession(sessionId)?.conversationId, 'conversation-new')
})

test('AgyAdapter serializes same-session calls while allowing separate sessions to overlap', async () => {
  let active = 0
  let maximum = 0
  const adapter = new AgyAdapter({ model: 'gemini-test', sessionMode: 'resume' }, {
    runAgyProcess: async request => {
      active += 1
      maximum = Math.max(maximum, active)
      request.onStdoutLine?.(JSON.stringify({ event: 'init', conversation_id: `conversation-${request.prompt.slice(-1)}` }))
      await new Promise(resolve => setTimeout(resolve, 10))
      request.onStdoutLine?.(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'ok' } }))
      active -= 1
      return result()
    },
  })
  const consume = async sessionId => {
    for await (const _chunk of adapter.stream({
      ...request,
      sessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text: sessionId }] }],
    })) {}
  }

  await Promise.all([consume('same'), consume('same')])
  assert.equal(maximum, 1)
  maximum = 0
  await Promise.all([consume('one'), consume('two')])
  assert.equal(maximum, 2)
})
