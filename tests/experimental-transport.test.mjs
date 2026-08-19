import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  encodePersistentFrame,
  ExperimentalAgyTransport,
  parsePersistentFrame,
  PersistentTransportError,
} from '../lib/agy/experimental-transport.js'

const fixture = fileURLToPath(new URL('./fixtures/persistent-worker.mjs', import.meta.url))

function transport(overrides = {}) {
  return new ExperimentalAgyTransport({
    executable: process.execPath,
    args: [fixture],
    maxWorkers: 8,
    maxFrameBytes: 32 * 1024,
    maxOutputBytes: 256 * 1024,
    maxStderrBytes: 8 * 1024,
    idleTtlMs: 5_000,
    readyTimeoutMs: 2_000,
    shutdownTimeoutMs: 500,
    defaultRequestTimeoutMs: 2_000,
    ...overrides,
  })
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function waitForWorkers(transportValue, expected, attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (transportValue.getStats().totalWorkers === expected) return
    await wait(25)
  }
  assert.equal(transportValue.getStats().totalWorkers, expected)
}

async function assertTreeGone(pid) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await wait(25)
  }
  assert.fail(`persistent worker child ${pid} survived tree termination`)
}

test('persistent framing validates NDJSON envelopes and input bounds', () => {
  const encoded = JSON.stringify({
    kind: 'event',
    requestId: 'request-1',
    sessionId: 'session-1',
    payload: { text: 'hello' },
  })
  assert.equal(parsePersistentFrame(encoded.trim()).kind, 'event')
  assert.match(encodePersistentFrame({
    kind: 'request',
    requestId: 'request-1',
    sessionId: 'session-1',
    payload: { text: 'hello' },
  }, 1_024), /"kind":"request"/)
  assert.throws(
    () => parsePersistentFrame('{not-json'),
    error => error instanceof PersistentTransportError && error.code === 'PROTOCOL_ERROR',
  )
  assert.throws(
    () => encodePersistentFrame({ kind: 'shutdown' }, 4),
    error => error instanceof PersistentTransportError && error.code === 'FRAME_TOO_LARGE',
  )
})

test('persistent transport reuses one worker for 100 sequential session requests', async () => {
  const value = transport()
  try {
    for (let index = 0; index < 100; index += 1) {
      const result = await value.request({
        sessionId: 'serial-session',
        payload: { text: `message-${index}` },
      })
      assert.equal(result.events.length, 2)
      assert.equal(result.events[0]?.sessionId, 'serial-session')
      assert.equal(result.events[0]?.requestId, result.requestId)
      assert.equal(typeof result.firstEventMs, 'number')
    }
    assert.deepEqual(value.getStats(), {
      totalWorkers: 1,
      startingWorkers: 0,
      idleWorkers: 1,
      busyWorkers: 0,
      stoppingWorkers: 0,
      maxWorkers: 8,
      disposed: false,
    })
  } finally {
    await value.dispose()
  }
  assert.equal(value.getStats().totalWorkers, 0)
})

test('persistent transport isolates eight concurrent sessions and enforces max workers', async () => {
  const value = transport({ maxWorkers: 8 })
  try {
    const sessions = Array.from({ length: 8 }, (_, index) => `session-${index}`)
    const results = await Promise.all(sessions.map(sessionId => value.request({
      sessionId,
      payload: { text: sessionId, mode: 'delay', delayMs: 20 },
    })))
    assert.deepEqual(results.map(result => result.sessionId).sort(), sessions.sort())
    for (const result of results) {
      for (const event of result.events) assert.equal(event.sessionId, result.sessionId)
    }
    assert.equal(value.getStats().totalWorkers, 8)
  } finally {
    await value.dispose()
  }

  const limited = transport({ maxWorkers: 2 })
  try {
    const first = limited.request({ sessionId: 'limited-a', payload: { mode: 'delay', delayMs: 100 } })
    const second = limited.request({ sessionId: 'limited-b', payload: { mode: 'delay', delayMs: 100 } })
    await wait(25)
    await assert.rejects(
      limited.request({ sessionId: 'limited-c', payload: { mode: 'normal' } }),
      error => error.code === 'WORKER_LIMIT',
    )
    await Promise.all([first, second])
  } finally {
    await limited.dispose()
  }
})

test('persistent transport expires idle workers and recovers after a crash', async () => {
  const value = transport({ idleTtlMs: 40 })
  try {
    await value.request({ sessionId: 'idle-session', payload: { mode: 'normal' } })
    await waitForWorkers(value, 1)
    await waitForWorkers(value, 0, 40)

    await assert.rejects(
      value.request({ sessionId: 'crash-session', payload: { mode: 'crash' } }),
      error => error.code === 'WORKER_CRASHED',
    )
    await waitForWorkers(value, 0)
    const recovered = await value.request({ sessionId: 'crash-session', payload: { text: 'recovered' } })
    assert.equal(recovered.events[0]?.text, 'crash-session:recovered:1')
  } finally {
    await value.dispose()
  }
})

test('abort, timeout, output-limit, and correlation faults reset the worker before reuse', async () => {
  const value = transport({ idleTtlMs: 5_000 })
  const sessionId = 'fault-session'
  try {
    const abortController = new AbortController()
    const aborted = value.request({
      sessionId,
      payload: { mode: 'delay', delayMs: 500 },
      signal: abortController.signal,
    })
    setTimeout(() => abortController.abort(), 25)
    await assert.rejects(aborted, error => error.code === 'ABORTED')
    await waitForWorkers(value, 0)
    assert.equal((await value.request({ sessionId, payload: { text: 'after-abort' } })).events[0]?.text, 'fault-session:after-abort:1')

    await assert.rejects(
      value.request({ sessionId, payload: { mode: 'delay', delayMs: 500 }, timeoutMs: 25 }),
      error => error.code === 'TIMEOUT',
    )
    await waitForWorkers(value, 0)
    assert.equal((await value.request({ sessionId, payload: { text: 'after-timeout' } })).events[0]?.text, 'fault-session:after-timeout:1')

    await assert.rejects(
      value.request({ sessionId, payload: { mode: 'burst', count: 20 }, maxOutputBytes: 256 }),
      error => error.code === 'OUTPUT_LIMIT',
    )
    await waitForWorkers(value, 0)
    assert.equal((await value.request({ sessionId, payload: { text: 'after-limit' } })).events[0]?.text, 'fault-session:after-limit:1')

    await assert.rejects(
      value.request({ sessionId, payload: { mode: 'wrong-request' } }),
      error => error.code === 'PROTOCOL_ERROR',
    )
    await waitForWorkers(value, 0)
    assert.equal((await value.request({ sessionId, payload: { text: 'after-protocol' } })).events[0]?.text, 'fault-session:after-protocol:1')

    await assert.rejects(
      value.request({ sessionId, payload: { mode: 'wrong-session' } }),
      error => error.code === 'PROTOCOL_ERROR',
    )
    await waitForWorkers(value, 0)
    assert.equal((await value.request({ sessionId, payload: { text: 'after-session-check' } })).events[0]?.text, 'fault-session:after-session-check:1')
  } finally {
    await value.dispose()
  }
})

test('persistent worker tree is terminated on abort/timeout and transport dispose rejects active work', async () => {
  const value = transport({
    idleTtlMs: 5_000,
  })
  let childPid
  const abortController = new AbortController()
  try {
    const treeRequest = value.request({
      sessionId: 'tree-session',
      payload: { mode: 'tree', delayMs: 10_000 },
      signal: abortController.signal,
      onEvent: payload => {
        if (typeof payload.childPid === 'number') {
          childPid = payload.childPid
          abortController.abort()
        }
      },
    })
    await assert.rejects(treeRequest, error => error.code === 'ABORTED' || error.code === 'TIMEOUT')
    assert.ok(Number.isInteger(childPid))
    await assertTreeGone(childPid)
    await waitForWorkers(value, 0)

    const active = value.request({ sessionId: 'dispose-session', payload: { mode: 'delay', delayMs: 5_000 } })
    const activeRejection = assert.rejects(active, error => error.code === 'DISPOSED')
    await wait(50)
    await value.dispose()
    await activeRejection
    assert.deepEqual(value.getStats(), {
      totalWorkers: 0,
      startingWorkers: 0,
      idleWorkers: 0,
      busyWorkers: 0,
      stoppingWorkers: 0,
      maxWorkers: 8,
      disposed: true,
    })
  } finally {
    await value.dispose()
  }
})
