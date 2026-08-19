import { readFile } from 'node:fs/promises'
import { createStructuredToolProtocol, parseStructuredEnvelope } from '../lib/provider/tool-protocol.js'
import { stageToolSchema } from '../lib/provider/tool-schema-file.js'
import { runAgyProcess } from '../lib/agy/process.js'
import { mapAgyUsage } from '../lib/provider/agy.js'
import { DEFAULT_MODEL } from '../lib/provider/config.js'

const BUDGET = Object.freeze({
  maxPhysicalRequests: 3,
  maxInputTokens: 12_000,
  maxOutputTokens: 1_500,
})
const AGY_AGENT = 'deepseek-proxy'
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
  physicalRequests = 0
  inputTokens = 0
  outputTokens = 0

  claim() {
    if (this.physicalRequests >= BUDGET.maxPhysicalRequests) throw new BudgetError('MAX_PHYSICAL_REQUESTS')
    this.physicalRequests += 1
  }

  add(usage) {
    this.inputTokens += usage.inputTokens ?? 0
    this.outputTokens += usage.outputTokens ?? 0
    if (this.inputTokens > BUDGET.maxInputTokens) throw new BudgetError('MAX_INPUT_TOKENS')
    if (this.outputTokens > BUDGET.maxOutputTokens) throw new BudgetError('MAX_OUTPUT_TOKENS')
  }

  snapshot() {
    return {
      physicalRequests: this.physicalRequests,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
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

async function runSample(sample, ledger) {
  ledger.claim()
  const protocol = createStructuredToolProtocol(sample.tools)
  const staged = await stageToolSchema(protocol)
  try {
    const process = await runAgyProcess({
      prompt: sample.prompt,
      agent: AGY_AGENT,
      model: MODEL || DEFAULT_MODEL,
      reasoningEffort: 'low',
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
  } finally {
    await staged.cleanup()
  }
}

async function main() {
  const args = process.argv.slice(2)
  const maxRequestsIndex = args.indexOf('--max-requests')
  const maxRequests = maxRequestsIndex < 0 ? 3 : Number(args[maxRequestsIndex + 1])
  if (process.env.AGY_QUOTA_EXPERIMENT !== 'ALLOW' || !args.includes('--confirm-quota')) {
    console.error('真实协议实验需要同时提供 --confirm-quota 和 AGY_QUOTA_EXPERIMENT=ALLOW。')
    process.exitCode = 2
    return
  }
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 3) {
    console.error('最多允许 3 次真实 AGY 请求。')
    process.exitCode = 2
    return
  }

  const ledger = new BudgetLedger()
  const report = {
    schemaVersion: 1,
    experiment: 'v7-m2-structured-tool-protocol',
    quotaUsed: true,
    budget: BUDGET,
    model: MODEL || DEFAULT_MODEL,
    agent: AGY_AGENT,
    samples: [],
  }
  try {
    for (const sample of sampleDefinitions().slice(0, maxRequests)) {
      try {
        report.samples.push(await runSample(sample, ledger))
      } catch (error) {
        report.samples.push({ id: sample.id, ok: false, error: safeError(error) })
        report.stopReason = ledger.physicalRequests >= maxRequests ? 'SAMPLE_FAILED' : 'EARLY_STOP_SAMPLE_FAILED'
        break
      }
    }
  } catch (error) {
    report.stopReason = safeError(error).code
  }
  report.usage = ledger.snapshot()
  report.decision = report.samples.length === 0
    ? 'NO_GO'
    : report.samples.every(sample => sample.ok === true)
      && report.samples.some(sample => sample.envelopeKind === 'tool_call')
      ? 'GO_STRUCTURED_ENVELOPE'
      : 'NO_GO_RECORD_NEGATIVE_RESULT'
  console.log(JSON.stringify(report, null, 2))
}

await main()
