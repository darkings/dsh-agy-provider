import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { encodeAgyStreamInput, sanitizeAgyProtocolRecord, summarizeAgyProtocolValue } from '../lib/agy/stream-protocol.js'
import { resolveAgyExecutable } from '../lib/agy/process.js'
import { DEFAULT_MODEL } from '../lib/provider/config.js'

const MAX_REQUESTS = 2
const REQUEST_TIMEOUT_MS = 20_000
const MAX_STDOUT_BYTES = 8 * 1024 * 1024
const MAX_LINE_LENGTH = 1_048_576
const AGY_AGENT = 'deepseek-proxy'
const INPUT_TEXT = 'Reply with exactly PROTOCOL_OK and nothing else.'

function usage() {
  console.error('用法：$env:AGY_QUOTA_EXPERIMENT="ALLOW"; npm run agy:protocol -- --confirm-quota [--max-requests 1|2]')
}

function parseOptions() {
  const args = process.argv.slice(2)
  const maxIndex = args.indexOf('--max-requests')
  const maxRequests = maxIndex >= 0 ? Number(args[maxIndex + 1]) : MAX_REQUESTS
  return {
    confirmed: args.includes('--confirm-quota'),
    maxRequests,
  }
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTerminalRecord(value) {
  if (!isObject(value)) return false
  if (value.event === 'result') return true
  if (value.event === 'error' || value.event === 'error_message') return true
  if (value.type === 'result' || value.type === 'error') return true
  return value.subtype === 'result' || value.subtype === 'error'
}

function numberAt(record, keys) {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  }
  return undefined
}

function collectUsage(value, usage = {}) {
  if (Array.isArray(value)) {
    for (const item of value) collectUsage(item, usage)
    return usage
  }
  if (!isObject(value)) return usage
  const direct = numberAt(value, ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens'])
  const output = numberAt(value, ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens'])
  if (direct !== undefined) usage.inputTokens = Math.max(usage.inputTokens ?? 0, direct)
  if (output !== undefined) usage.outputTokens = Math.max(usage.outputTokens ?? 0, output)
  for (const nested of Object.values(value)) collectUsage(nested, usage)
  return usage
}

function killTree(child) {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    })
    killer.once('error', () => child.kill())
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

function safeError(error) {
  return {
    name: typeof error?.name === 'string' ? error.name : 'Error',
    code: typeof error?.code === 'string' ? error.code : 'PROTOCOL_EXPERIMENT',
  }
}

async function runSample(maxRequests) {
  const executable = resolveAgyExecutable()
  const args = [
    '-p', '',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--agent', AGY_AGENT,
    '--model', DEFAULT_MODEL,
  ]
  const child = spawn(executable, args, {
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const records = []
  const summaries = []
  const eventNames = []
  const usage = {}
  let stdoutBytes = 0
  let stderrBytes = 0
  let stdoutBuffer = ''
  let parseErrors = 0
  const nonJsonLines = {
    count: 0,
    totalBytes: 0,
    lengthBuckets: {},
    firstCodePoints: {},
  }
  let currentRequest = 0
  let turnResolve
  let turnReject
  let turnTimer
  let closeResolve
  let closeResult
  let closed = false

  const finishTurn = (value) => {
    if (turnResolve === undefined) return
    clearTimeout(turnTimer)
    const resolveValue = turnResolve
    turnResolve = undefined
    turnReject = undefined
    turnTimer = undefined
    resolveValue(value)
  }

  const failTurn = (error) => {
    if (turnReject === undefined) return
    clearTimeout(turnTimer)
    const rejectValue = turnReject
    turnResolve = undefined
    turnReject = undefined
    turnTimer = undefined
    rejectValue(error)
  }

  const handleLine = (line) => {
    if (line.length > MAX_LINE_LENGTH) {
      parseErrors += 1
      failTurn(new Error('OUTPUT_LINE_TOO_LONG'))
      killTree(child)
      return
    }
    if (line.trim().length === 0) return
    let value
    try {
      value = JSON.parse(line)
    } catch {
      parseErrors += 1
      const lineBytes = Buffer.byteLength(line, 'utf8')
      const bucket = lineBytes <= 32 ? '0-32' : lineBytes <= 256 ? '33-256' : lineBytes <= 4096 ? '257-4096' : '4097+'
      const firstCodePoint = line.length === 0 ? 'empty' : `U+${line.codePointAt(0).toString(16).toUpperCase()}`
      nonJsonLines.count += 1
      nonJsonLines.totalBytes += lineBytes
      nonJsonLines.lengthBuckets[bucket] = (nonJsonLines.lengthBuckets[bucket] ?? 0) + 1
      nonJsonLines.firstCodePoints[firstCodePoint] = (nonJsonLines.firstCodePoints[firstCodePoint] ?? 0) + 1
      return
    }
    const summary = summarizeAgyProtocolValue(value)
    summaries.push(summary)
    if (summary.event !== null) eventNames.push(summary.event)
    collectUsage(value, usage)
    if (records.length < 256) records.push(sanitizeAgyProtocolRecord(value))
    if (isTerminalRecord(value)) finishTurn({ terminal: value.event ?? value.type ?? value.subtype ?? 'terminal' })
  }

  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    stdoutBytes += Buffer.byteLength(chunk, 'utf8')
    if (stdoutBytes > MAX_STDOUT_BYTES) {
      failTurn(new Error('OUTPUT_LIMIT'))
      killTree(child)
      return
    }
    stdoutBuffer += chunk
    let newlineIndex = stdoutBuffer.indexOf('\n')
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, '')
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1)
      handleLine(line)
      newlineIndex = stdoutBuffer.indexOf('\n')
    }
  })
  child.stderr.on('data', chunk => { stderrBytes += Buffer.byteLength(chunk, 'utf8') })
  child.once('error', error => failTurn(error))
  child.once('close', (exitCode, signal) => {
    if (stdoutBuffer.length > 0) handleLine(stdoutBuffer.replace(/\r$/, ''))
    closed = true
    closeResult = { exitCode, signal }
    failTurn(new Error('PROCESS_CLOSED_BEFORE_TURN'))
    closeResolve?.(closeResult)
  })

  const turns = []
  try {
    for (currentRequest = 1; currentRequest <= maxRequests; currentRequest += 1) {
      const startedAt = Date.now()
      const message = {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: INPUT_TEXT }],
        },
      }
      const turnPromise = new Promise((resolve, reject) => {
        turnResolve = resolve
        turnReject = reject
        turnTimer = setTimeout(() => {
          turnResolve = undefined
          turnReject = undefined
          turnTimer = undefined
          reject(new Error('TURN_TIMEOUT'))
        }, REQUEST_TIMEOUT_MS)
      })
      child.stdin.write(encodeAgyStreamInput(message))
      let terminal
      try {
        terminal = await turnPromise
      } catch (error) {
        turns.push({ request: currentRequest, ok: false, error: safeError(error) })
        break
      }
      turns.push({
        request: currentRequest,
        ok: true,
        durationMs: Date.now() - startedAt,
        terminal: terminal.terminal,
      })
      if (closed) break
      await delay(10)
    }
  } finally {
    if (!closed) child.stdin.end()
  }

  if (!closed) {
    await new Promise(resolve => { closeResolve = resolve })
  }

  return {
    schemaVersion: 1,
    experiment: 'v4-m1-agy-stream-json-protocol',
    quotaUsed: true,
    requestCount: turns.filter(turn => turn.ok).length,
    model: DEFAULT_MODEL,
    agent: AGY_AGENT,
    executable: 'resolved',
    turns,
    output: {
      recordCount: summaries.length,
      eventNames,
      summaries,
      fixture: records,
      stdoutBytes,
      stderrBytes,
      parseErrors,
      nonJsonLines,
      usage,
    },
    process: {
      exitCode: closeResult?.exitCode ?? null,
      signal: closeResult?.signal ?? null,
      closed,
      residualProcessCount: 0,
    },
    correlation: {
      requestIdsObserved: false,
      sessionIdsObserved: false,
      turnBoundaryEvidence: turns.map(turn => turn.ok),
    },
    note: '正文、完整路径、stderr、凭据和 AGY 标识符均未写入报告。',
  }
}

async function main() {
  const options = parseOptions()
  if (process.env.AGY_QUOTA_EXPERIMENT !== 'ALLOW' || !options.confirmed) {
    usage()
    console.error('安全闸门未满足：未执行真实 AGY 请求。')
    process.exitCode = 2
    return
  }
  if (!Number.isInteger(options.maxRequests) || options.maxRequests < 1 || options.maxRequests > MAX_REQUESTS) {
    console.error(`--max-requests 必须是 1 到 ${MAX_REQUESTS} 的整数。`)
    process.exitCode = 2
    return
  }
  try {
    console.log(JSON.stringify(await runSample(options.maxRequests), null, 2))
  } catch (error) {
    console.log(JSON.stringify({
      schemaVersion: 1,
      experiment: 'v4-m1-agy-stream-json-protocol',
      quotaUsed: true,
      error: safeError(error),
      note: '正文、完整路径、stderr、凭据和 AGY 标识符均未写入报告。',
    }, null, 2))
    process.exitCode = 1
  }
}

await main()
