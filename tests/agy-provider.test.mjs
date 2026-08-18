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

test('AgyAdapter rejects DSH tools in the text-only MVP', async () => {
  const adapter = new AgyAdapter({}, { runAgyProcess: fakeRunner([], []) })
  await assert.rejects(
    async () => {
      for await (const _chunk of adapter.stream({
        ...request,
        tools: [{ name: 'fixture', description: 'fixture', parameters: {} }],
      })) {}
    },
    error => error.code === 'UNSUPPORTED_TOOLS',
  )
})

test('AgyAdapter fails fast on an AGY permission request', async () => {
  const adapter = new AgyAdapter({}, {
    runAgyProcess: async request => {
      request.onStdoutLine?.(JSON.stringify({ event: 'init', conversation_id: 'permission-test' }))
      request.onStdoutLine?.(JSON.stringify({ event: 'permission_request', permission: { kind: 'fixture' } }))
      return result()
    },
  })
  await assert.rejects(
    async () => {
      for await (const _chunk of adapter.stream({ ...request, messages: [], system: 'reply' })) {}
    },
    error => error.code === 'PERMISSION_REQUIRED',
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
