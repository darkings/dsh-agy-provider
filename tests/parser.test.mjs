import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AgyParserError,
  AgyStreamParser,
  conversationIdOf,
  emptyAgyEventCategoryCounts,
  errorDetailOf,
  eventCategoryOf,
  isPermissionEvent,
  isToolEvent,
  parseAgyChunks,
  responseOf,
  sendMessageOf,
  statusOf,
  textDeltaOf,
  toolEventDiagnosticOf,
  usageOf,
} from '../lib/agy/parser.js'
import { AGY_EVENT_FIXTURES } from './fixtures/agy-events.mjs'

test('AgyStreamParser handles arbitrary chunks, CRLF, and a trailing line', () => {
  const parser = new AgyStreamParser()
  const chunks = [
    `{"event":"init","conversation_id":"fixture"}\r\n{"event":"step_`,
    `update","step_update":{"text_delta":"12"}}\r\n\r\n{"event":"result",`,
    `"result":{"status":"SUCCESS","response":"123\\n","usage":{"total_tokens":3}}}`,
  ]
  const events = chunks.flatMap(chunk => parser.push(chunk)).concat(parser.end())

  assert.deepEqual(events.map(event => event.event), ['init', 'step_update', 'result'])
  assert.equal(textDeltaOf(events[1]), '12')
  assert.equal(responseOf(events[2]), '123\n')
  assert.equal(statusOf(events[2]), 'SUCCESS')
  assert.deepEqual(usageOf(events[2]), { total_tokens: 3 })
  assert.equal(conversationIdOf(events[0]), 'fixture')
})

test('conversationIdOf accepts the nested init envelope', () => {
  const parser = new AgyStreamParser()
  const [event] = parser.push('{"event":"init","init":{"conversation_id":"nested"}}\n')
  assert.equal(conversationIdOf(event), 'nested')
})

test('parser classifies internal tool and permission lifecycle events', () => {
  const parser = new AgyStreamParser()
  const events = parser.push([
    '{"event":"step_update","step_update":{"step_type":"tool","tool_name":"list_dir","state":"ACTIVE"}}',
    '{"event":"permission_request","permission":{"kind":"fixture"}}',
  ].join('\n') + '\n')
  assert.equal(isToolEvent(events[0]), true)
  assert.equal(isPermissionEvent(events[0]), false)
  assert.equal(isPermissionEvent(events[1]), true)
})

test('parser does not classify a generic step name as an internal tool event', () => {
  const parser = new AgyStreamParser()
  const [event] = parser.push(JSON.stringify({
    event: 'step_update',
    step_update: { step_type: 'agent_response', name: 'Inspect' },
  }) + '\n')
  assert.equal(isToolEvent(event), false)
  assert.equal(eventCategoryOf(event), 'step_update')
})

test('parser extracts the double-encoded default_api send_message carrier', () => {
  const envelope = { kind: 'tool_call', name: 'read_file', arguments: { path: 'fixture.txt' } }
  const parser = new AgyStreamParser()
  const [event] = parser.push(JSON.stringify({
    event: 'step_update',
    step_update: {
      step_type: 'tool',
      tool_name: 'send_message',
      tool_input: {
        Recipient: JSON.stringify('default_api'),
        Message: JSON.stringify(JSON.stringify(envelope)),
      },
    },
  }) + '\n')
  assert.deepEqual(sendMessageOf(event), {
    recipient: 'default_api',
    message: JSON.stringify(envelope),
  })
})

test('parser classifies send_message carrier shape without retaining payload values', () => {
  const parser = new AgyStreamParser()
  const [event] = parser.push(JSON.stringify({
    event: 'step_update',
    step_update: {
      step_type: 'tool',
      tool_name: 'send_message',
      tool_input: {
        Recipient: JSON.stringify('default_api'),
        Message: JSON.stringify(JSON.stringify({ kind: 'message', content: 'secret payload' })),
      },
    },
  }) + '\n')

  assert.deepEqual(toolEventDiagnosticOf(event), {
    eventName: 'step_update',
    kind: 'step-type-tool',
    stepType: 'tool',
    toolName: 'send_message',
    carrierShape: 'complete',
    recipientClass: 'default-api',
    topLevelKeys: ['event', 'step_update'],
    stepKeys: ['step_type', 'tool_input', 'tool_name'],
    toolInputKeys: ['message', 'recipient'],
  })
  assert.equal(JSON.stringify(toolEventDiagnosticOf(event)).includes('secret payload'), false)
})

test('parser classifies a carrier recipient against the active conversation without retaining its value', () => {
  const envelope = { kind: 'tool_call', name: 'read_file', arguments: { path: 'fixture.txt' } }
  const parser = new AgyStreamParser()
  const [event] = parser.push(JSON.stringify({
    event: 'step_update',
    step_update: {
      step_type: 'tool',
      tool_name: 'send_message',
      state: {
        tool_input: {
          Recipient: JSON.stringify('conversation-self'),
          Message: JSON.stringify(JSON.stringify(envelope)),
        },
      },
    },
  }) + '\n')

  assert.equal(toolEventDiagnosticOf(event, 'conversation-self')?.recipientClass, 'self-conversation')
  assert.equal(toolEventDiagnosticOf(event, 'conversation-other')?.recipientClass, 'other-conversation')
  assert.equal(JSON.stringify(toolEventDiagnosticOf(event, 'conversation-self')).includes('conversation-self'), false)
})

test('parser classifies stable DSH runtime carrier recipients without retaining their values', () => {
  for (const recipient of ['dsh', 'dsh-session', 'dsh-runner']) {
    const parser = new AgyStreamParser()
    const [event] = parser.push(JSON.stringify({
      event: 'step_update',
      step_update: {
        step_type: 'tool',
        tool_name: 'send_message',
        tool_input: {
          Recipient: JSON.stringify(recipient),
          Message: JSON.stringify(JSON.stringify({ kind: 'message', content: 'secret payload' })),
        },
      },
    }) + '\n')

    assert.equal(toolEventDiagnosticOf(event)?.recipientClass, 'dsh-recipient')
    assert.equal(JSON.stringify(toolEventDiagnosticOf(event)).includes(`"${recipient}"`), false)
  }
})

test('parser rejects conflicting nested send_message carrier fields instead of choosing the first branch', () => {
  const envelope = { kind: 'tool_call', name: 'read_file', arguments: { path: 'fixture.txt' } }
  const parser = new AgyStreamParser()
  const [event] = parser.push(JSON.stringify({
    event: 'step_update',
    step_update: {
      step_type: 'tool',
      tool_name: 'send_message',
      tool_input: {
        Recipient: JSON.stringify('default_api'),
        Message: JSON.stringify(JSON.stringify(envelope)),
      },
      state: {
        Recipient: JSON.stringify('different-conversation'),
      },
    },
  }) + '\n')

  assert.equal(sendMessageOf(event), undefined)
  assert.equal(toolEventDiagnosticOf(event)?.carrierShape, 'unreadable-recipient')
  assert.equal(toolEventDiagnosticOf(event)?.recipientClass, 'missing')
})

test('parser distinguishes a non-carrier internal tool event', () => {
  const parser = new AgyStreamParser()
  const [event] = parser.push(JSON.stringify({
    event: 'step_update',
    step_update: { step_type: 'tool', tool_name: 'shell', state: 'ACTIVE' },
  }) + '\n')
  assert.deepEqual(toolEventDiagnosticOf(event), {
    eventName: 'step_update',
    kind: 'step-type-tool',
    stepType: 'tool',
    toolName: 'shell',
    carrierShape: 'not-send-message',
    recipientClass: 'not-applicable',
    topLevelKeys: ['event', 'step_update'],
    stepKeys: ['state', 'step_type', 'tool_name'],
    toolInputKeys: [],
  })
})

test('parser preserves permission detection for the legacy ask_permission step name', () => {
  const parser = new AgyStreamParser()
  const [event] = parser.push(JSON.stringify({
    event: 'step_update',
    step_update: { name: 'ask_permission' },
  }) + '\n')
  assert.equal(isToolEvent(event), false)
  assert.equal(isPermissionEvent(event), true)
  assert.equal(eventCategoryOf(event), 'permission')
})

test('parser categorizes observed lifecycle fixtures and preserves unknown events', () => {
  const categories = Object.values(AGY_EVENT_FIXTURES).map(event => eventCategoryOf(event))
  assert.deepEqual(categories, [
    'init',
    'step_update',
    'tool',
    'tool',
    'checkpoint',
    'agent_response',
    'permission',
    'error',
    'result',
    'result',
    'unknown',
  ])
  assert.equal(errorDetailOf(AGY_EVENT_FIXTURES.errorMessage), 'AUTH_REQUIRED login required')
  assert.deepEqual(emptyAgyEventCategoryCounts(), {
    init: 0,
    step_update: 0,
    checkpoint: 0,
    agent_response: 0,
    result: 0,
    tool: 0,
    permission: 0,
    error: 0,
    unknown: 0,
  })
})

test('parser preserves unknown event types for forward compatibility', () => {
  const parser = new AgyStreamParser()
  const events = parser.push('{"event":"permission_request","payload":{"kind":"fixture"}}\n')
  assert.equal(events[0].event, 'permission_request')
  assert.deepEqual(events[0].payload, { kind: 'fixture' })
})

test('parser reports malformed JSON with a physical line number', () => {
  const parser = new AgyStreamParser()
  assert.throws(
    () => parser.push('{"event":"init"}\nnot-json\n'),
    error => error instanceof AgyParserError
      && error.code === 'INVALID_JSON_LINE'
      && error.lineNumber === 2,
  )
})

test('AgyStreamParser rejects an overlong NDJSON line with bounded diagnostics', () => {
  const parser = new AgyStreamParser({ maxLineLength: 32 })
  assert.throws(
    () => parser.push(`${'x'.repeat(40)}\n`),
    error => error instanceof AgyParserError
      && error.code === 'LINE_TOO_LONG'
      && error.rawLine.length <= 4_096,
  )
})

test('parser rejects JSON values without an event envelope', () => {
  const parser = new AgyStreamParser()
  assert.throws(
    () => parser.push('[]\n'),
    error => error instanceof AgyParserError && error.code === 'INVALID_EVENT',
  )
})

test('parseAgyChunks exposes events as an async stream', async () => {
  async function* chunks() {
    yield '{"event":"step_update","step_update":{"text_delta":"a"}}\n'
    yield '{"event":"result","result":{"status":"SUCCESS"}}\n'
  }
  const events = []
  for await (const event of parseAgyChunks(chunks())) events.push(event)
  assert.deepEqual(events.map(event => event.event), ['step_update', 'result'])
})
