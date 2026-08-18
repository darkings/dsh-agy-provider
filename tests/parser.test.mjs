import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AgyParserError,
  AgyStreamParser,
  parseAgyChunks,
  responseOf,
  statusOf,
  textDeltaOf,
  usageOf,
} from '../lib/agy/parser.js'

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
