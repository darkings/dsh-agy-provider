import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { AgyAdapter } from '../lib/provider/agy.js'

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

const request = {
  provider: 'agy-test',
  model: 'gemini-test',
  system: 'system prompt',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'reply 123' }] }],
}

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
  assert.deepEqual(chunks.find(chunk => chunk.type === 'usage')?.usage, { inputTokens: 4, outputTokens: 0 })
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
  assert.equal(models[1]?.description, 'Pro text model')
  assert.deepEqual(models[0]?.inputModalities, ['text'])

  const resolved = await adapter.resolveModel('agy-test', 'gemini-flash')
  assert.equal(resolved.name, 'Flash')
  assert.deepEqual(resolved.context, { contextWindow: 1_000_000 })

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
    error => error.code === 'UNSUPPORTED_TOOLS' && error.message.includes('toolPolicy: agy-owned'),
  )
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
  for (const toolPolicy of ['reject', 'agy-owned']) {
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
