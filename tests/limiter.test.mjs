import assert from 'node:assert/strict'
import test from 'node:test'
import { AgyConcurrencyLimiter } from '../lib/agy/limiter.js'

test('AgyConcurrencyLimiter preserves FIFO order and bounds the queue', async () => {
  const limiter = new AgyConcurrencyLimiter({
    maxConcurrent: 1,
    maxQueue: 1,
    queueTimeoutMs: 1_000,
  })
  const first = await limiter.acquire()
  const secondPromise = limiter.acquire()

  assert.deepEqual(limiter.getStats(), {
    active: 1,
    queued: 1,
    maxConcurrent: 1,
    maxQueue: 1,
    queueTimeoutMs: 1_000,
  })
  await assert.rejects(
    limiter.acquire(),
    error => error.code === 'QUEUE_FULL',
  )

  first()
  const second = await secondPromise
  assert.equal(limiter.getStats().active, 1)
  second()
  assert.equal(limiter.getStats().active, 0)
})

test('AgyConcurrencyLimiter rejects a queued request after its timeout', async () => {
  const limiter = new AgyConcurrencyLimiter({
    maxConcurrent: 1,
    maxQueue: 1,
    queueTimeoutMs: 20,
  })
  const release = await limiter.acquire()
  await assert.rejects(
    limiter.acquire(),
    error => error.code === 'QUEUE_TIMEOUT',
  )
  assert.equal(limiter.getStats().queued, 0)
  release()
})
test('AgyConcurrencyLimiter removes an aborted request from the queue', async () => {
  const limiter = new AgyConcurrencyLimiter({
    maxConcurrent: 1,
    maxQueue: 1,
    queueTimeoutMs: 1_000,
  })
  const release = await limiter.acquire()
  const controller = new AbortController()
  const waiting = limiter.acquire(controller.signal)
  controller.abort()

  await assert.rejects(
    waiting,
    error => error.code === 'ABORTED',
  )
  assert.equal(limiter.getStats().queued, 0)
  release()
})
