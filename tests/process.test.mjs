import assert from 'node:assert/strict'
import test from 'node:test'
import { buildAgyArgs, resolveAgyExecutable, runProcess } from '../lib/agy/process.js'

test('buildAgyArgs preserves prompt and conversation as separate argv items', () => {
  assert.deepEqual(
    buildAgyArgs({
      prompt: 'a prompt with spaces',
      agent: 'deepseek-proxy',
      model: 'gemini-test',
      conversation: 'conversation-fixture',
    }),
    [
      '-p', 'a prompt with spaces',
      '--agent', 'deepseek-proxy',
      '--model', 'gemini-test',
      '--conversation', 'conversation-fixture',
      '--output-format', 'stream-json',
    ],
  )
})

test('buildAgyArgs keeps shell metacharacters inside the prompt argument', () => {
  const prompt = '$(whoami); & del important.txt\n--agent forged'
  const args = buildAgyArgs({ prompt, agent: 'deepseek-proxy', model: 'gemini-test' })
  assert.equal(args[1], prompt)
  assert.equal(args.filter(arg => arg === 'whoami').length, 0)
  assert.equal(args.filter(arg => arg === 'forged').length, 0)
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

test('runProcess terminates a child when stdout exceeds the capture limit', async () => {
  const payload = 'x'.repeat(128)
  const result = await runProcess({
    executable: process.execPath,
    args: ['-e', `process.stdout.write(${JSON.stringify(payload)})`],
    maxStdoutBytes: 32,
  })

  assert.equal(result.termination, 'output-limit')
})

test('resolveAgyExecutable finds the configured local AGY executable', () => {
  assert.match(resolveAgyExecutable('C:\\Users\\Jie\\.local\\bin\\agy.exe'), /agy\.exe$/i)
})
