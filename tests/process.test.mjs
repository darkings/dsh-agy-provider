import assert from 'node:assert/strict'
import test from 'node:test'
import { buildAgyArgs, defaultAgyCommand, resolveAgyExecutable, runProcess } from '../lib/agy/process.js'

test('buildAgyArgs preserves prompt and conversation as separate argv items', () => {
  assert.deepEqual(
    buildAgyArgs({
      prompt: 'a prompt with spaces',
      agent: 'deepseek-proxy',
      model: 'gemini-test',
      conversation: 'conversation-fixture',
      jsonSchemaPath: 'C:\\temp\\dsh-tool-schema.json',
    }),
    [
      '-p', 'a prompt with spaces',
      '--agent', 'deepseek-proxy',
      '--model', 'gemini-test',
      '--conversation', 'conversation-fixture',
      '--json-schema', 'C:\\temp\\dsh-tool-schema.json',
      '--output-format', 'stream-json',
    ],
  )
})

test('buildAgyArgs maps reasoning effort as a separate argv pair', () => {
  assert.deepEqual(
    buildAgyArgs({
      prompt: 'a prompt',
      agent: 'deepseek-proxy',
      model: 'gemini-test',
      reasoningEffort: 'high',
    }),
    [
      '-p', 'a prompt',
      '--agent', 'deepseek-proxy',
      '--model', 'gemini-test',
      '--effort', 'high',
      '--output-format', 'stream-json',
    ],
  )
})

test('buildAgyArgs maps bounded Agent workspace flags without shell composition', () => {
  assert.deepEqual(
    buildAgyArgs({
      prompt: 'edit a file',
      agent: 'dsh-agy-workspace-write',
      model: 'gemini-test',
      addDirs: ['C:\\workspace', 'C:\\workspace\\nested'],
      mode: 'accept-edits',
      disableSlashCommands: true,
    }),
    [
      '-p', 'edit a file',
      '--agent', 'dsh-agy-workspace-write',
      '--model', 'gemini-test',
      '--add-dir', 'C:\\workspace',
      '--add-dir', 'C:\\workspace\\nested',
      '--mode', 'accept-edits',
      '--disable-slash-commands',
      '--output-format', 'stream-json',
    ],
  )
})

test('buildAgyArgs rejects unapproved execution modes and empty directories', () => {
  assert.throws(
    () => buildAgyArgs({ prompt: 'test', mode: 'dangerous' }),
    /execution mode must be one of/,
  )
  assert.throws(
    () => buildAgyArgs({ prompt: 'test', addDirs: [''] }),
    /add-dir entries must be non-empty/,
  )
  assert.throws(
    () => buildAgyArgs({ prompt: 'test', jsonSchemaPath: '   ' }),
    /json-schema path must be non-empty/,
  )
})

test('buildAgyArgs rejects a non-whitelisted reasoning effort', () => {
  assert.throws(
    () => buildAgyArgs({ prompt: 'a prompt', reasoningEffort: 'high; whoami' }),
    /reasoning effort must be one of/,
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

test('runProcess does not expose the executable path on spawn failure', async () => {
  const executable = process.platform === 'win32'
    ? 'C:\\Users\\Jie\\private\\agy.exe'
    : '/home/jie/private/agy'
  await assert.rejects(
    runProcess({ executable, args: [] }),
    error => error.code === 'SPAWN_FAILED'
      && !error.message.includes(executable)
      && !error.message.includes('private'),
  )
})

test('resolveAgyExecutable finds the configured local AGY executable', () => {
  assert.match(resolveAgyExecutable('C:\\Users\\Jie\\.local\\bin\\agy.exe'), /agy\.exe$/i)
})

test('defaultAgyCommand follows the host platform', () => {
  assert.equal(defaultAgyCommand(), process.platform === 'win32' ? 'agy.exe' : 'agy')
})

async function assertTreeGone(pid) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.fail(`child process ${pid} survived tree termination`)
}

function parentWithChildScript() {
  return [
    '-e',
    'const { spawn } = require("node:child_process"); const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { stdio: ["ignore", "ignore", "ignore"] }); console.log(child.pid); setTimeout(() => {}, 5000)',
  ]
}

test('runProcess timeout terminates the complete child process tree', async () => {
  let childPid
  const result = await runProcess({
    executable: process.execPath,
    args: parentWithChildScript(),
    timeoutMs: 500,
    onStdoutLine: line => { childPid = Number(line) },
  })

  assert.equal(result.termination, 'timeout')
  assert.ok(Number.isInteger(childPid))
  await assertTreeGone(childPid)
})

test('runProcess abort terminates the complete child process tree', async () => {
  const controller = new AbortController()
  let childPid
  const run = runProcess({
    executable: process.execPath,
    args: parentWithChildScript(),
    signal: controller.signal,
    onStdoutLine: line => { childPid = Number(line) },
  })
  await new Promise(resolve => setTimeout(resolve, 250))
  controller.abort()
  const result = await run

  assert.equal(result.termination, 'aborted')
  assert.ok(Number.isInteger(childPid))
  await assertTreeGone(childPid)
})
