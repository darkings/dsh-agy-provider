import assert from 'node:assert/strict'
import test from 'node:test'
import { AgyStreamParser, textDeltaOf, usageOf } from '../lib/agy/parser.js'
import {
  AgyStreamProtocolError,
  encodeAgyStreamInput,
  sanitizeAgyProtocolRecord,
  summarizeAgyProtocolValue,
} from '../lib/agy/stream-protocol.js'
import { AGY_STREAM_JSON_REAL_FIXTURE } from './fixtures/agy-stream-json-real.mjs'

test('stream protocol input is bounded NDJSON without shell interpolation', () => {
  assert.equal(encodeAgyStreamInput({ type: 'user', text: 'a\n;b' }), '{"type":"user","text":"a\\n;b"}\n')
  assert.throws(
    () => encodeAgyStreamInput({ text: '0123456789' }, 5),
    error => error instanceof AgyStreamProtocolError && error.code === 'FRAME_TOO_LARGE',
  )
})

test('stream protocol fixture sanitizer removes text, paths, and identifiers', () => {
  const value = sanitizeAgyProtocolRecord({
    event: 'result',
    result: {
      status: 'SUCCESS',
      response: 'private response',
      conversation_id: 'private-conversation',
      usage: { input_tokens: 17, output_tokens: 3 },
      path: 'C:\\Users\\Jie\\secret.txt',
    },
  })
  assert.deepEqual(value, {
    event: 'result',
    result: {
      status: 'SUCCESS',
      response: '<string:16>',
      conversation_id: '<string:20>',
      usage: { input_tokens: 0, output_tokens: 0 },
      path: '<string:23>',
    },
  })
  assert.doesNotMatch(JSON.stringify(value), /private|Users|Jie/)
})

test('stream protocol summary reports shape only', () => {
  const summary = summarizeAgyProtocolValue({
    event: 'step_update',
    step_update: { text_delta: 'hello', usage: { total_tokens: 4 } },
  })
  assert.deepEqual(summary.topLevelKeys, ['event', 'step_update'])
  assert.equal(summary.event, 'step_update')
  assert.ok(summary.shapePaths.includes('step_update.text_delta'))
  assert.equal(summary.stringLengths['step_update.text_delta'], 5)
  assert.doesNotMatch(JSON.stringify(summary), /hello/)
})

test('sanitized real AGY stream fixture replays through the existing parser', () => {
  const parser = new AgyStreamParser()
  const events = parser.push(`${AGY_STREAM_JSON_REAL_FIXTURE.map(value => JSON.stringify(value)).join('\n')}\n`)
  assert.deepEqual(events.map(event => event.event), [
    'init', 'step_update', 'step_update', 'step_update', 'result',
  ])
  assert.equal(textDeltaOf(events[2]), '<string:12>')
  assert.deepEqual(usageOf(events[4]), {
    input_tokens: 0,
    output_tokens: 0,
    thinking_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: 0,
  })
})
