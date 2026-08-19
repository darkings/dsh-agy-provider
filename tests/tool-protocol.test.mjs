import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createStructuredToolProtocol,
  parseStructuredEnvelope,
  StructuredResponseAccumulator,
  ToolProtocolError,
  TOOL_PROTOCOL_LIMITS,
} from '../lib/provider/tool-protocol.js'
import { access, readFile } from 'node:fs/promises'
import { stageToolSchema } from '../lib/provider/tool-schema-file.js'

const tools = [
  {
    name: 'read_file',
    description: 'Read one file.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: { type: 'string', minLength: 1 },
      },
    },
  },
  {
    name: 'write_file',
    description: 'Write one file.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'content'],
      properties: {
        path: { type: 'string', minLength: 1 },
        content: { type: 'string' },
      },
    },
  },
]

test('structured tool protocol creates a strict message-or-allowlisted-tool schema', () => {
  const protocol = createStructuredToolProtocol(tools)

  assert.equal(protocol.schema.oneOf.length, 3)
  assert.deepEqual(protocol.schema.oneOf[0].required, ['kind', 'content'])
  assert.deepEqual(protocol.schema.oneOf[1].properties.name.enum, ['read_file'])
  assert.deepEqual(protocol.schema.oneOf[2].properties.name.enum, ['write_file'])
  assert.equal(Object.isFrozen(protocol), true)
  assert.equal(Object.isFrozen(protocol.schema), true)
  assert.equal(JSON.parse(protocol.schemaJson).oneOf.length, 3)
})

test('structured tool protocol accepts a valid message and fragmented tool call', () => {
  assert.deepEqual(
    parseStructuredEnvelope(JSON.stringify({ kind: 'message', content: 'done' }), tools),
    { kind: 'message', content: 'done' },
  )

  const accumulator = new StructuredResponseAccumulator()
  for (const fragment of ['{"kind":"tool_', 'call","name":"read_file",', '"arguments":{"path":"a.txt"}}']) {
    accumulator.append(fragment)
  }
  assert.deepEqual(accumulator.parse(tools), {
    kind: 'tool_call',
    name: 'read_file',
    arguments: { path: 'a.txt' },
  })
})

test('structured tool protocol rejects unknown tools, extra fields, and schema mismatches', () => {
  assert.throws(
    () => parseStructuredEnvelope({ kind: 'tool_call', name: 'delete_file', arguments: {} }, tools),
    error => error instanceof ToolProtocolError && error.code === 'TOOL_PROTOCOL_UNKNOWN_TOOL',
  )
  assert.throws(
    () => parseStructuredEnvelope({ kind: 'message', content: 'ok', extra: true }, tools),
    error => error instanceof ToolProtocolError && error.code === 'TOOL_PROTOCOL_RESPONSE_INVALID',
  )
  assert.throws(
    () => parseStructuredEnvelope({ kind: 'tool_call', name: 'read_file', arguments: { path: 'a', extra: true } }, tools),
    error => error instanceof ToolProtocolError && error.code === 'TOOL_PROTOCOL_ARGUMENTS_INVALID',
  )
  assert.throws(
    () => parseStructuredEnvelope({ kind: 'tool_call', name: 'write_file', arguments: { path: 'a' } }, tools),
    error => error instanceof ToolProtocolError && error.code === 'TOOL_PROTOCOL_ARGUMENTS_INVALID',
  )
})

test('structured tool protocol rejects malformed JSON and fragmented responses over the limit', () => {
  assert.throws(
    () => parseStructuredEnvelope('{"kind":"tool_call"', tools),
    error => error instanceof ToolProtocolError && error.code === 'TOOL_PROTOCOL_RESPONSE_INVALID',
  )

  const accumulator = new StructuredResponseAccumulator()
  accumulator.append('{"kind":"message","content":"')
  assert.throws(
    () => accumulator.append('x'.repeat(
      TOOL_PROTOCOL_LIMITS.maxArgumentsBytes + TOOL_PROTOCOL_LIMITS.maxMessageLength,
    )),
    error => error instanceof ToolProtocolError && error.code === 'TOOL_PROTOCOL_RESPONSE_LIMIT',
  )
})

test('structured tool protocol rejects unsupported schema features and duplicate names', () => {
  assert.throws(
    () => createStructuredToolProtocol([{
      name: 'read_file',
      description: 'read',
      parameters: { type: 'object', $ref: '#/$defs/unsafe' },
    }]),
    error => error instanceof ToolProtocolError && error.code === 'TOOL_PROTOCOL_SCHEMA_INVALID',
  )
  assert.throws(
    () => createStructuredToolProtocol([tools[0], { ...tools[0] }]),
    error => error instanceof ToolProtocolError && error.code === 'TOOL_PROTOCOL_SCHEMA_INVALID',
  )
})

test('structured tool protocol is message-capable with no DSH tools', () => {
  const protocol = createStructuredToolProtocol([])
  assert.deepEqual(parseStructuredEnvelope({ kind: 'message', content: 'plain text' }, protocol), {
    kind: 'message',
    content: 'plain text',
  })
  assert.throws(
    () => parseStructuredEnvelope({ kind: 'tool_call', name: 'read_file', arguments: {} }, protocol),
    error => error instanceof ToolProtocolError && error.code === 'TOOL_PROTOCOL_UNKNOWN_TOOL',
  )
})

test('structured tool schema staging is private, outside the workspace, and cleaned up', async () => {
  const protocol = createStructuredToolProtocol(tools)
  const staged = await stageToolSchema(protocol)
  try {
    assert.notEqual(staged.path, process.cwd())
    assert.deepEqual(JSON.parse(await readFile(staged.path, 'utf8')), protocol.schema)
  } finally {
    await staged.cleanup()
    await assert.rejects(() => access(staged.path))
    await staged.cleanup()
  }
})
