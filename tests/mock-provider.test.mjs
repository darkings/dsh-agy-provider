import assert from 'node:assert/strict'
import test from 'node:test'
import { MockAdapter } from '../lib/provider/mock.js'

test('MockAdapter emits a complete text StreamChunk lifecycle', async () => {
  const adapter = new MockAdapter({
    provider: 'agy-mock',
    model: 'agy-mock-model',
    response: '123',
  })
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'agy-mock',
    model: 'agy-mock-model',
    messages: [],
  })) {
    chunks.push(chunk)
  }

  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '123' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '123' } },
    { type: 'usage', usage: { inputTokens: 0, outputTokens: 3 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
})

test('MockAdapter honors AbortSignal before emitting a response', async () => {
  const controller = new AbortController()
  controller.abort()
  const adapter = new MockAdapter({ response: 'never' })

  await assert.rejects(
    (async () => {
      for await (const _chunk of adapter.stream({
        provider: 'agy-mock',
        model: 'agy-mock-model',
        messages: [],
        signal: controller.signal,
      })) {}
    })(),
    { code: 'ABORTED' },
  )
})

