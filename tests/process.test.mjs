import assert from 'node:assert/strict'
import test from 'node:test'
import { buildAgyArgs, resolveAgyExecutable, runProcess } from '../lib/agy/process.js'

test('buildAgyArgs preserves prompt as one argv item and requests stream-json', () => {
  assert.deepEqual(
    buildAgyArgs({ prompt: 'a prompt with spaces', agent: 'deepseek-proxy', model: 'gemini-test' }),
    [
      '-p', 'a prompt with spaces',
      '--agent', 'deepseek-proxy',
      '--model', 'gemini-test',
      '--output-format', 'stream-json',
    ],
  )
})

test('runProcess captures stdout incrementally, stderr, and a successful exit', async () => {
  const lines = []
  const result = await runProcess({
    executable: process.execPath,
    args: ['-e', 'console.log("one"); console.error("warning"); console.log("two")'],
    onStdoutLine: line => lines.push(line),
  })

  assert.equal(result.termination, 'completed')
  assert.equal(result.exitCode, 0)
  assert.deepEqual(lines, ['one', 'two'])
  assert.deepEqual(result.stdoutLines, ['one', 'two'])
  assert.match(result.stderr, /warning/)
})

test('runProcess terminates a child on timeout', async () => {
  const result = await runProcess({
    executable: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 5000)'],
    timeoutMs: 50,
  })

  assert.equal(result.termination, 'timeout')
  assert.ok(result.durationMs < 2_000)
})

test('runProcess terminates a child when its AbortSignal is cancelled', async () => {
  const controller = new AbortController()
  const run = runProcess({
    executable: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 5000)'],
    signal: controller.signal,
  })
  setTimeout(() => controller.abort(), 50)

  const result = await run
  assert.equal(result.termination, 'aborted')
  assert.ok(result.durationMs < 2_000)
})

test('resolveAgyExecutable finds the configured local AGY executable', () => {
  assert.match(resolveAgyExecutable('C:\\Users\\Jie\\.local\\bin\\agy.exe'), /agy\.exe$/i)
})
