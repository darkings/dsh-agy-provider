import { readFile } from 'node:fs/promises'
import { createStructuredToolProtocol, parseStructuredEnvelope } from '../lib/provider/tool-protocol.js'
import { stageToolSchema } from '../lib/provider/tool-schema-file.js'
import { runAgyProcess } from '../lib/agy/process.js'
import { mapAgyUsage } from '../lib/provider/agy.js'
import { DEFAULT_MODEL } from '../lib/provider/config.js'

const DEFAULT_BUDGET = Object.freeze({
  maxPhysicalRequests: 3,
  maxInputTokens: 12_000,
  maxOutputTokens: 1_500,
})
const DEFAULT_AGENT = 'deepseek-proxy'
const MODEL = process.env.AGY_PROTOCOL_MODEL?.trim() || 'gemini-3.7-flash-low'
const REQUEST_TIMEOUT_MS = 120_000

const READ_TOOL = Object.freeze({
  name: 'read_file',
  description: 'Read a named fixture file. The host will execute it only after DSH approval.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['path'],
    properties: {
      path: { type: 'string', enum: ['fixture.txt'] },
    },
  },
})

class BudgetError extends Error {
  constructor(code) {
    super(code)
    this.name = 'BudgetError'
    this.code = code
  }
}

class BudgetLedger {
  constructor(budget, priorUsage) {
    this.budget = budget
    this.priorUsage = priorUsage
    this.physicalRequests = priorUsage.physicalRequests
    this.inputTokens = priorUsage.inputTokens
    this.outputTokens = priorUsage.outputTokens
  }

  claim() {
    if (this.physicalRequests >= this.budget.maxPhysicalRequests) throw new BudgetError('MAX_PHYSICAL_REQUESTS')
    this.physicalRequests += 1
  }

  add(usage) {
    this.inputTokens += usage.inputTokens ?? 0
    this.outputTokens += usage.outputTokens ?? 0
    if (this.inputTokens > this.budget.maxInputTokens) throw new BudgetError('MAX_INPUT_TOKENS')
    if (this.outputTokens > this.budget.maxOutputTokens) throw new BudgetError('MAX_OUTPUT_TOKENS')
  }

  snapshot() {
    return {
      physicalRequests: this.physicalRequests,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
    }
  }

  runSnapshot() {
    return {
      physicalRequests: this.physicalRequests - this.priorUsage.physicalRequests,
      inputTokens: this.inputTokens - this.priorUsage.inputTokens,
      outputTokens: this.outputTokens - this.priorUsage.outputTokens,
    }
  }
}

function safeError(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'TOOL_PROTOCOL_EXPERIMENT',
    name: typeof error?.name === 'string' ? error.name : 'Error',
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeResponseShape(raw) {
  if (typeof raw !== 'string') return { rawType: typeof raw }
  const text = raw.trim()
  let value
  try {
    value = JSON.parse(text)
  } catch {
    const prefix = text.startsWith('{')
      ? 'object-like'
      : text.startsWith('[')
        ? 'array-like'
        : text.startsWith('```')
          ? 'markdown-fence'
          : text.startsWith('"')
            ? 'json-string-like'
            : 'other'
    return { json: false, chars: raw.length, prefix }
  }
  if (Array.isArray(value)) return { json: true, topLevel: 'array', length: value.length }
  if (!isRecord(value)) return { json: true, topLevel: typeof value }
  const keys = Object.keys(value).sort()
  return {
    json: true,
    topLevel: 'object',
    keys: keys.slice(0, 8),
    extraKeyCount: Math.max(0, keys.length - 3),
    kind: value.kind === 'message' || value.kind === 'tool_call' ? value.kind : 'other',
    contentType: typeof value.content,
    nameType: typeof value.name,
    argumentsType: typeof value.arguments,
  }
}

function extractResult(lines) {
  let response
  let status
  let rawUsage
  let resultCount = 0
  const events = []
  for (const line of lines) {
    let value
    try {
      value = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(value)) continue
    if (typeof value.event === 'string') events.push(value.event)
    if (value.event !== 'result' || !isRecord(value.result)) continue
    resultCount += 1
    if (resultCount > 1) throw new Error('MULTIPLE_RESULT_EVENTS')
    if (typeof value.result.response === 'string') response = value.result.response
    if (typeof value.result.status === 'string') status = value.result.status
    if (isRecord(value.result.usage)) rawUsage = value.result.usage
  }
  return { response, status, rawUsage, events, resultCount }
}

function sampleDefinitions() {
  return [
    {
      id: 'message',
      tools: [],
      prompt: 'Return exactly this JSON object and no markdown: {"kind":"message","content":"PROTOCOL_MESSAGE_OK"}. Do not call any internal tool.',
    },
    {
      id: 'tool-call',
      tools: [READ_TOOL],
      prompt: 'Return exactly one JSON tool call for the allowlisted read_file tool with arguments {"path":"fixture.txt"}. Do not call any internal tool and do not return markdown.',
    },
    {
      id: 'allowlist-negative',
      tools: [READ_TOOL],
      prompt: 'Attempting to call delete_file is forbidden because it is not allowlisted. Return a safe JSON message explaining that only read_file is available. Do not call any internal tool and do not return markdown.',
    },
  ]
}

function optionValue(args, name) {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  return args[index + 1]
}

function optionNumber(args, name, fallback) {
  const value = optionValue(args, name)
  return value === undefined ? fallback : Number(value)
}

async function runSample(sample, ledger, options) {
  ledger.claim()
  const protocol = createStructuredToolProtocol(sample.tools)
  const staged = await stageToolSchema(protocol)
  try {
    const process = await runAgyProcess({
      prompt: sample.prompt,
      agent: options.agent,
      model: MODEL || DEFAULT_MODEL,
      reasoningEffort: 'low',
      ...(options.disableSlashCommands ? { disableSlashCommands: true } : {}),
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxStdoutBytes: 8 * 1024 * 1024,
      maxStderrBytes: 2 * 1024 * 1024,
      jsonSchemaPath: staged.path,
    })
    const result = extractResult(process.stdoutLines)
    const usage = result.rawUsage === undefined ? { inputTokens: 0, outputTokens: 0 } : mapAgyUsage(result.rawUsage)
    ledger.add(usage)
    if (result.response === undefined) {
      return {
        id: sample.id,
        ok: false,
        status: result.status ?? 'missing-result-response',
        termination: process.termination,
        usage,
        eventNames: result.events,
      }
    }
    try {
      const envelope = parseStructuredEnvelope(result.response, protocol)
      return {
        id: sample.id,
        ok: true,
        status: result.status ?? 'unknown',
        termination: process.termination,
        envelopeKind: envelope.kind,
        ...(envelope.kind === 'tool_call' ? { toolName: envelope.name } : {}),
        responseChars: result.response.length,
        usage,
        eventNames: result.events,
      }
    } catch (error) {
      return {
        id: sample.id,
        ok: false,
        status: result.status ?? 'unknown',
        termination: process.termination,
        error: safeError(error),
        responseShape: safeResponseShape(result.response),
        usage,
        eventNames: result.events,
      }
    }
  } finally {
    await staged.cleanup()
  }
}

async function main() {
  const args = process.argv.slice(2)
  const maxRequests = optionNumber(args, '--max-requests', 3)
  const agent = optionValue(args, '--agent') ?? (process.env.AGY_PROTOCOL_AGENT?.trim() || DEFAULT_AGENT)
  const priorUsage = {
    physicalRequests: optionNumber(args, '--prior-requests', 0),
    inputTokens: optionNumber(args, '--prior-input-tokens', 0),
    outputTokens: optionNumber(args, '--prior-output-tokens', 0),
  }
  const budget = Object.freeze({
    maxPhysicalRequests: optionNumber(args, '--max-physical-requests', DEFAULT_BUDGET.maxPhysicalRequests),
    maxInputTokens: optionNumber(args, '--max-input-tokens', DEFAULT_BUDGET.maxInputTokens),
    maxOutputTokens: optionNumber(args, '--max-output-tokens', DEFAULT_BUDGET.maxOutputTokens),
  })
  const disableSlashCommands = args.includes('--disable-slash-commands')
  if (process.env.AGY_QUOTA_EXPERIMENT !== 'ALLOW' || !args.includes('--confirm-quota')) {
    console.error('真实协议实验需要同时提供 --confirm-quota 和 AGY_QUOTA_EXPERIMENT=ALLOW。')
    process.exitCode = 2
    return
  }
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 3
    || !Number.isInteger(agent?.length) || agent.length === 0
    || !Object.values(priorUsage).every(value => Number.isSafeInteger(value) && value >= 0)
    || !Object.values(budget).every(value => Number.isSafeInteger(value) && value > 0)
    || priorUsage.physicalRequests + maxRequests > budget.maxPhysicalRequests) {
    console.error('真实 AGY 请求或额度参数无效；最多允许总计 3 次请求。')
    process.exitCode = 2
    return
  }

  const ledger = new BudgetLedger(budget, priorUsage)
  const report = {
    schemaVersion: 1,
    experiment: 'v7-m2-structured-tool-protocol',
    quotaUsed: true,
    budget,
    priorUsage,
    runRequestLimit: maxRequests,
    model: MODEL || DEFAULT_MODEL,
    agent,
    disableSlashCommands,
    samples: [],
  }
  try {
    for (const sample of sampleDefinitions().slice(0, maxRequests)) {
      try {
        report.samples.push(await runSample(sample, ledger, { agent, disableSlashCommands }))
      } catch (error) {
        report.samples.push({ id: sample.id, ok: false, error: safeError(error) })
        report.stopReason = ledger.physicalRequests >= budget.maxPhysicalRequests ? 'SAMPLE_FAILED' : 'EARLY_STOP_SAMPLE_FAILED'
        break
      }
    }
  } catch (error) {
    report.stopReason = safeError(error).code
  }
  report.usage = ledger.snapshot()
  report.runUsage = ledger.runSnapshot()
  report.decision = report.samples.length === 0
    ? 'NO_GO'
    : report.samples.every(sample => sample.ok === true)
      && report.samples.some(sample => sample.envelopeKind === 'tool_call')
      ? 'GO_STRUCTURED_ENVELOPE'
      : 'NO_GO_RECORD_NEGATIVE_RESULT'
  console.log(JSON.stringify(report, null, 2))
}

await main()
