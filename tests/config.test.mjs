import assert from 'node:assert/strict'
import test from 'node:test'
import { Config, configuredModels } from '../lib/provider/config.js'

test('Config applies safe M7 defaults and rejects invalid concurrency values', () => {
  const config = Config({})
  assert.equal(config.minimumAgyVersion, '1.1.13')
  assert.equal(config.maxConcurrent, 4)
  assert.equal(config.maxQueue, 32)
  assert.equal(config.queueTimeoutMs, 30_000)
  assert.equal(config.maxOutputBytes, 8 * 1024 * 1024)
  assert.equal(config.maxEventLineLength, 1_048_576)
  assert.equal(config.modelDiscovery, 'auto')
  assert.equal(config.modelDiscoveryTtlMs, 300_000)
  assert.equal(config.modelDiscoveryTimeoutMs, 10_000)
  assert.equal(config.toolPolicy, 'reject')
  assert.throws(() => Config({ maxConcurrent: 0 }), error => error.name === 'ValidationError')
  assert.throws(() => Config({ minimumAgyVersion: 'latest' }), error => error.name === 'ValidationError')
  assert.throws(() => Config({ modelDiscovery: 'invalid' }), error => error.name === 'ValidationError')
  assert.throws(() => Config({ modelDiscoveryTtlMs: 999 }), error => error.name === 'ValidationError')
  assert.throws(() => Config({ modelDiscoveryTimeoutMs: 99 }), error => error.name === 'ValidationError')
  assert.throws(() => Config({ toolPolicy: 'bridge' }), error => error.name === 'ValidationError')
})

test('Config accepts the explicit AGY-owned tool policy', () => {
  assert.equal(Config({ toolPolicy: 'agy-owned' }).toolPolicy, 'agy-owned')
})

test('Config accepts a multi-model catalog and preserves the legacy model fallback', () => {
  const config = Config({
    model: 'gemini-default',
    models: [
      { id: 'gemini-flash', name: 'Flash', contextWindow: 1_000_000 },
      { id: 'gemini-flash', name: 'Duplicate' },
    ],
  })

  assert.deepEqual(configuredModels(config), [
    { id: 'gemini-flash', name: 'Flash', contextWindow: 1_000_000 },
    { id: 'gemini-default' },
  ])
  assert.throws(() => Config({ models: [{ id: '  ' }] }), error => error.name === 'ValidationError')
})
