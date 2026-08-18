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
  statusOf,
  textDeltaOf,
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
