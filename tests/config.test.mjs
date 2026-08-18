import assert from 'node:assert/strict'
import test from 'node:test'
import { Config } from '../lib/provider/config.js'

test('Config applies safe M7 defaults and rejects invalid concurrency values', () => {
  const config = Config({})
  assert.equal(config.minimumAgyVersion, '1.1.13')
  assert.equal(config.maxConcurrent, 4)
  assert.equal(config.maxQueue, 32)
  assert.equal(config.queueTimeoutMs, 30_000)
  assert.equal(config.maxOutputBytes, 8 * 1024 * 1024)
  assert.equal(config.maxEventLineLength, 1_048_576)
  assert.throws(() => Config({ maxConcurrent: 0 }), error => error.name === 'ValidationError')
  assert.throws(() => Config({ minimumAgyVersion: 'latest' }), error => error.name === 'ValidationError')
})
