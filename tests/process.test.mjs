import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildAgyArgs,
  defaultAgyCommand,
  resolveAgyExecutable,
  runAgyProcess,
  runProcess,
} from '../lib/agy/process.js'
import { buildWindowsNoConsoleLaunch } from '../lib/agy/windows-launcher.js'

test('Windows no-console launch keeps non-Windows execution unchanged', () => {
  const launch = buildWindowsNoConsoleLaunch('/usr/bin/agy', ['--model', 'test'], 'linux')
  assert.deepEqual(launch, { executable: '/usr/bin/agy', args: ['--model', 'test'] })
})

test('Windows no-console launch uses the bundled GUI launcher without putting prompt data in argv', { skip: process.platform !== 'win32' }, () => {
  const launch = buildWindowsNoConsoleLaunch('C:\\Users\\Jie\\.local\\bin\\agy.exe', ['-p', '', '--model', 'gemini-test'], 'win32')
  assert.match(launch.executable, /agy-launcher\.exe$/i)
  assert.deepEqual(launch.args.slice(0, 1), ['--command-base64'])
  assert.equal(launch.args.length, 2)
  assert.equal(launch.args.some(arg => arg.includes('gemini-test')), false)
  assert.match(Buffer.from(launch.args[1], 'base64').toString('utf8'), /gemini-test/)
})

test('Windows no-console launch fails closed for unsupported architectures', () => {
  assert.throws(
    () => buildWindowsNoConsoleLaunch('agy.exe', [], 'win32', 'ia32'),
    error => error.code === 'UNSUPPORTED_ARCH',
  )
})

test('buildAgyArgs keeps the prompt out of argv and enables stdin stream-json', () => {
  assert.deepEqual(
    buildAgyArgs({
      prompt: 'a prompt with spaces',
      agent: 'deepseek-proxy',
      model: 'gemini-test',
      conversation: 'conversation-fixture',
      jsonSchemaPath: 'C:\\temp\\dsh-tool-schema.json',
    }),
    [
      '-p', '',
      '--agent', 'deepseek-proxy',
      '--model', 'gemini-test',
      '--conversation', 'conversation-fixture',
      '--json-schema', 'C:\\temp\\dsh-tool-schema.json',
      '--input-format', 'stream-json',
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
      '-p', '',
      '--agent', 'deepseek-proxy',
      '--model', 'gemini-test',
      '--effort', 'high',
      '--input-format', 'stream-json',
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
      '-p', '',
      '--agent', 'dsh-agy-workspace-write',
      '--model', 'gemini-test',
      '--add-dir', 'C:\\workspace',
      '--add-dir', 'C:\\workspace\\nested',
      '--mode', 'accept-edits',
      '--disable-slash-commands',
      '--input-format', 'stream-json',
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

test('buildAgyArgs never exposes prompt content as a process argument', () => {
  const prompt = '$(whoami); & del important.txt\n--agent forged'
  const args = buildAgyArgs({ prompt, agent: 'deepseek-proxy', model: 'gemini-test' })
  assert.equal(args.includes(prompt), false)
  assert.equal(args.filter(arg => arg === 'whoami').length, 0)
  assert.equal(args.filter(arg => arg === 'forged').length, 0)
})

test('runProcess writes a one-shot payload through stdin', async () => {
  const payload = 'x'.repeat(40_000)
  const result = await runProcess({
    executable: process.execPath,
    args: ['-e', 'process.stdin.setEncoding("utf8"); let value = ""; process.stdin.on("data", chunk => value += chunk); process.stdin.on("end", () => console.log(value.length))'],
    stdin: payload,
  })

  assert.equal(result.termination, 'completed')
  assert.deepEqual(result.stdoutLines, ['40000'])
})

test('runAgyProcess maps an oversized encoded user frame to INPUT_TOO_LARGE', async () => {
  await assert.rejects(
    runAgyProcess({
      executable: process.execPath,
      prompt: 'x'.repeat(2_000),
      maxInputFrameBytes: 1_024,
    }),
    error => error.code === 'INPUT_TOO_LARGE'
      && error.message.includes('configured frame limit')
      && error.message.includes('bytes'),
  )
})

test('runProcess Windows no-console bridge preserves streamed stdin/stdout', { skip: process.platform !== 'win32' }, async () => {
  const result = await runProcess({
    executable: process.execPath,
    args: ['-e', 'process.stdin.pipe(process.stdout)'],
    stdin: 'bridge-ok\n',
    windowsNoConsole: true,
    timeoutMs: 10_000,
  })

  assert.equal(result.termination, 'completed')
  assert.deepEqual(result.stdoutLines, ['bridge-ok'])
})

test('runProcess Windows no-console bridge preserves stderr and child exit code', { skip: process.platform !== 'win32' }, async () => {
  const result = await runProcess({
    executable: process.execPath,
    args: ['-e', 'console.error("launcher-stderr"); process.exit(23)'],
    windowsNoConsole: true,
    timeoutMs: 10_000,
  })

  assert.equal(result.termination, 'non-zero')
  assert.equal(result.exitCode, 23)
  assert.match(result.stderr, /launcher-stderr/)
})

test('runProcess Windows no-console bridge preserves quoted Unicode argv', { skip: process.platform !== 'win32' }, async () => {
  const result = await runProcess({
    executable: process.execPath,
    args: [
      '-e',
      'console.log(JSON.stringify(process.argv.slice(1)))',
      'value with spaces',
      'quote"and',
      '中文参数',
      'C:\\path\\',
    ],
    windowsNoConsole: true,
    timeoutMs: 10_000,
  })

  assert.equal(result.termination, 'completed')
  assert.deepEqual(JSON.parse(result.stdoutLines[0]), [
    'value with spaces',
    'quote"and',
    '中文参数',
    'C:\\path\\',
  ])
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

test('runProcess exposes safe stdout-handler diagnostics without raw output', async () => {
  const secretLine = 'not-json secret prompt and response must stay out of diagnostics'
  await assert.rejects(
    runProcess({
      executable: process.execPath,
      args: ['-e', `console.log(${JSON.stringify(secretLine)})`],
      onStdoutLine: line => {
        const error = new Error('Invalid AGY JSON')
        error.name = 'AgyParserError'
        error.code = 'INVALID_JSON_LINE'
        error.lineNumber = 7
        error.rawLine = line
        throw error
      },
    }),
    error => error.code === 'OUTPUT_HANDLER_FAILED'
      && error.diagnostic?.stage === 'stdout-handler'
      && error.diagnostic?.errorName === 'AgyParserError'
      && error.diagnostic?.errorCode === 'INVALID_JSON_LINE'
      && error.diagnostic?.lineNumber === 7
      && error.diagnostic?.lineLength === secretLine.length
      && /^[0-9a-f]{16}$/.test(error.diagnostic?.lineHash ?? '')
      && !error.message.includes(secretLine)
      && !JSON.stringify(error.diagnostic).includes(secretLine),
  )
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

test('runProcess maps a synchronous Windows argv overflow to SPAWN_FAILED', { skip: process.platform !== 'win32' }, async () => {
  await assert.rejects(
    runProcess({ executable: process.execPath, args: ['-e', '', 'x'.repeat(40_000)] }),
    error => error.code === 'SPAWN_FAILED' && error.cause?.code === 'ENAMETOOLONG',
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
