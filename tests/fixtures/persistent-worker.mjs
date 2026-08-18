import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const sessionId = process.env.DSH_AGY_EXPERIMENTAL_SESSION ?? 'unknown-session'
const children = new Set()

function emit(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`)
}

function finishRequest(frame, mode = 'normal') {
  const text = String(frame.payload?.text ?? 'reply')
  emit({
    kind: 'event',
    requestId: frame.requestId,
    sessionId,
    payload: {
      requestId: frame.requestId,
      sessionId,
      mode,
      text: `${sessionId}:${text}:1`,
      sequence: 1,
    },
  })
  emit({
    kind: 'event',
    requestId: frame.requestId,
    sessionId,
    payload: {
      requestId: frame.requestId,
      sessionId,
      mode,
      text: `${sessionId}:${text}:2`,
      sequence: 2,
    },
  })
  emit({ kind: 'complete', requestId: frame.requestId, sessionId })
}

function spawnTreeChild() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  children.add(child)
  child.once('close', () => children.delete(child))
  return child.pid
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', line => {
  let frame
  try {
    frame = JSON.parse(line)
  } catch {
    process.exit(21)
  }
  if (frame?.kind === 'shutdown') {
    for (const child of children) child.kill()
    input.close()
    process.exit(0)
  }
  if (frame?.kind !== 'request') return

  const mode = String(frame.payload?.mode ?? 'normal')
  if (mode === 'crash') process.exit(23)
  if (mode === 'wrong-request') {
    emit({ kind: 'event', requestId: 'wrong-request', sessionId, payload: { text: 'wrong' } })
    return
  }
  if (mode === 'wrong-session') {
    emit({ kind: 'event', requestId: frame.requestId, sessionId: 'wrong-session', payload: { text: 'wrong' } })
    return
  }
  if (mode === 'burst') {
    const count = Number(frame.payload?.count ?? 100)
    for (let index = 0; index < count; index += 1) {
      emit({
        kind: 'event',
        requestId: frame.requestId,
        sessionId,
        payload: { requestId: frame.requestId, sessionId, text: 'x'.repeat(128), sequence: index },
      })
    }
    emit({ kind: 'complete', requestId: frame.requestId, sessionId })
    return
  }
  if (mode === 'tree') {
    const childPid = spawnTreeChild()
    emit({
      kind: 'event',
      requestId: frame.requestId,
      sessionId,
      payload: { requestId: frame.requestId, sessionId, childPid },
    })
    setTimeout(() => finishRequest(frame, mode), Number(frame.payload?.delayMs ?? 10_000))
    return
  }
  if (mode === 'delay') {
    setTimeout(() => finishRequest(frame, mode), Number(frame.payload?.delayMs ?? 100))
    return
  }
  finishRequest(frame, mode)
})

const readyDelayMs = Number(process.env.PERSISTENT_FIXTURE_READY_DELAY_MS ?? 0)
if (Number.isFinite(readyDelayMs) && readyDelayMs > 0) {
  setTimeout(() => emit({ kind: 'ready', sessionId, workerPid: process.pid }), readyDelayMs)
} else {
  emit({ kind: 'ready', sessionId, workerPid: process.pid })
}
