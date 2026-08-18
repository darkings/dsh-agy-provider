import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { apply } from '../lib/index.js'

test('Mock Provider registers and streams through the official DSH LLM runtime', async () => {
  const root = new Context()
  await root.plugin(LlmRuntime)
  await root.plugin({
    name: 'dsh-agy-provider-smoke',
    inject: ['llm'],
    apply(ctx) {
      apply(ctx, {
        enabled: true,
        provider: 'agy-mock',
        model: 'agy-mock-model',
        response: '123',
      })
    },
  })

  const models = await root.llm.listModels('agy-mock')
  const chunks = []
  for await (const chunk of root.llm.stream({
    provider: 'agy-mock',
    model: 'agy-mock-model',
    messages: [],
  })) {
    chunks.push(chunk)
  }

  assert.equal(models[0]?.id, 'agy-mock-model')
  assert.equal(chunks.at(-1)?.type, 'finish')
  assert.equal(chunks.find(chunk => chunk.type === 'text-delta')?.text, '123')
  await root.fiber.dispose()
})

