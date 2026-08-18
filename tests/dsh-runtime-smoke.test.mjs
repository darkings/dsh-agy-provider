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

test('Mock Provider exposes a configured multi-model catalog through the official runtime', async () => {
  const root = new Context()
  await root.plugin(LlmRuntime)
  await root.plugin({
    name: 'dsh-agy-provider-model-catalog-smoke',
    inject: ['llm'],
    apply(ctx) {
      apply(ctx, {
        enabled: true,
        provider: 'agy-mock-catalog',
        model: 'agy-mock-default',
        models: [
          { id: 'agy-mock-fast', name: 'Fast Mock' },
          { id: 'agy-mock-fast', name: 'Duplicate' },
        ],
      })
    },
  })

  const models = await root.llm.listModels('agy-mock-catalog')
  assert.deepEqual(models.map(model => model.id), ['agy-mock-fast', 'agy-mock-default'])
  assert.equal(models[0]?.name, 'Fast Mock')
  await root.fiber.dispose()
})
