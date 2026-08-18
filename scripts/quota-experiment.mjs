import { AgyAdapter } from '../lib/provider/agy.js'
import { runAgyProcess } from '../lib/agy/process.js'
import { DEFAULT_MODEL } from '../lib/provider/config.js'

const BUDGET = Object.freeze({
  maxPhysicalRequests: 12,
  maxInputTokens: 60_000,
  maxOutputTokens: 6_000,
  maxPairs: 3,
  roundsPerPair: 2,
  savingsGate: 0.20,
})

const SYSTEM_PROMPT = 'You are a quota measurement assistant. Reply with exactly OK and nothing else.'
const AGY_AGENT = 'deepseek-proxy'

class ExperimentLimitError extends Error {
  constructor(code) {
    super(code)
    this.name = 'ExperimentLimitError'
    this.code = code
  }
}

class BudgetLedger {
  physicalRequests = 0
  inputTokens = 0
  outputTokens = 0
  cacheReadTokens = 0
  cacheWriteTokens = 0
  reasoningTokens = 0
  stopReason
  attempts = []

  claimRequest(metadata) {
    if (this.physicalRequests >= BUDGET.maxPhysicalRequests) {
      this.stopReason ??= 'MAX_PHYSICAL_REQUESTS'
      throw new ExperimentLimitError(this.stopReason)
    }
    this.physicalRequests += 1
    this.attempts.push({ index: this.physicalRequests, ...metadata })
  }

  addUsage(usage) {
    this.inputTokens += usage.inputTokens ?? 0
    this.outputTokens += usage.outputTokens ?? 0
    this.cacheReadTokens += usage.cacheReadTokens ?? 0
    this.cacheWriteTokens += usage.cacheWriteTokens ?? 0
    this.reasoningTokens += usage.reasoningTokens ?? 0
    if (this.inputTokens > BUDGET.maxInputTokens) {
      this.stopReason ??= 'MAX_INPUT_TOKENS'
      throw new ExperimentLimitError(this.stopReason)
    }
    if (this.outputTokens > BUDGET.maxOutputTokens) {
      this.stopReason ??= 'MAX_OUTPUT_TOKENS'
      throw new ExperimentLimitError(this.stopReason)
    }
  }

  snapshot() {
    return {
      physicalRequests: this.physicalRequests,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheReadTokens: this.cacheReadTokens,
      cacheWriteTokens: this.cacheWriteTokens,
      reasoningTokens: this.reasoningTokens,
      ...(this.stopReason === undefined ? {} : { stopReason: this.stopReason }),
    }
  }
}

function errorSummary(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'AGY_REQUEST',
    name: typeof error?.name === 'string' ? error.name : 'Error',
  }
}

function textMessage(role, text) {
  return { role, content: [{ type: 'text', text }] }
}

async function collectTurn(adapter, options, ledger) {
  let response = ''
  let usage
  for await (const chunk of adapter.stream(options)) {
    if (chunk.type === 'text-delta') response += chunk.text
    if (chunk.type === 'block-end' && chunk.block.type === 'text' && response.length === 0) {
      response = chunk.block.text
    }
    if (chunk.type === 'usage') usage = chunk.usage
  }
  if (usage === undefined) throw new Error('NO_USAGE_REPORTED')
  ledger.addUsage(usage)
  return { response, usage }
}

async function runMode(mode, repetition, ledger) {
  let currentRound = 0
  const sessionId = `quota-v2-m5-${mode}-${repetition}`
  const adapter = new AgyAdapter({
    model: DEFAULT_MODEL,
    agent: AGY_AGENT,
    sessionMode: mode,
    timeoutMs: 120_000,
    maxConcurrent: 1,
    maxQueue: 0,
    queueTimeoutMs: 0,
  }, {
    runAgyProcess: request => {
      ledger.claimRequest({ mode, repetition, round: currentRound })
      return runAgyProcess(request)
    },
  })

  const messages = []
  const rounds = []
  for (currentRound = 1; currentRound <= BUDGET.roundsPerPair; currentRound += 1) {
    const userText = `Quota check ${repetition}/${mode} round ${currentRound}: reply with exactly OK.`
    const userMessage = textMessage('user', userText)
    const result = await collectTurn(adapter, {
      provider: 'agy',
      model: DEFAULT_MODEL,
      system: SYSTEM_PROMPT,
      messages: [...messages, userMessage],
      sessionId,
    }, ledger)
    messages.push(userMessage, textMessage('assistant', result.response))
    rounds.push({
      round: currentRound,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      ...(result.usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: result.usage.cacheReadTokens }),
      ...(result.usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: result.usage.cacheWriteTokens }),
      responseChars: result.response.length,
      conversationMapped: adapter.getSession(sessionId) !== undefined,
    })
  }

  return {
    mode,
    repetition,
    rounds,
    totals: rounds.reduce((total, round) => ({
      inputTokens: total.inputTokens + round.inputTokens,
      outputTokens: total.outputTokens + round.outputTokens,
    }), { inputTokens: 0, outputTokens: 0 }),
  }
}

async function safeRunMode(mode, repetition, ledger) {
  try {
    return await runMode(mode, repetition, ledger)
  } catch (error) {
    return { mode, repetition, error: errorSummary(error) }
  }
}

function comparePair(full, resume) {
  const fullRound = full.rounds?.at(-1)?.inputTokens
  const resumeRound = resume.rounds?.at(-1)?.inputTokens
  if (typeof fullRound !== 'number' || typeof resumeRound !== 'number' || fullRound <= 0) {
    return { comparable: false, savingsRatio: null, gatePassed: false }
  }
  const savingsRatio = (fullRound - resumeRound) / fullRound
  return {
    comparable: true,
    fullInputTokens: fullRound,
    resumeInputTokens: resumeRound,
    savingsRatio: Number(savingsRatio.toFixed(4)),
    gatePassed: savingsRatio >= BUDGET.savingsGate,
  }
}

async function main() {
  const live = process.argv.includes('--live') && process.env.AGY_QUOTA_EXPERIMENT === 'ALLOW'
  if (!live) {
    console.error('真实额度实验需要同时提供 --live 和 AGY_QUOTA_EXPERIMENT=ALLOW。')
    process.exitCode = 2
    return
  }

  const ledger = new BudgetLedger()
  const report = {
    schemaVersion: 1,
    experiment: 'v2-m5-full-resume',
    quotaUsed: true,
    protocol: {
      model: DEFAULT_MODEL,
      agent: AGY_AGENT,
      roundsPerPair: BUDGET.roundsPerPair,
      maxPairs: BUDGET.maxPairs,
      savingsGate: BUDGET.savingsGate,
      noRetry: true,
    },
    budget: BUDGET,
    pairs: [],
  }

  for (let repetition = 1; repetition <= BUDGET.maxPairs; repetition += 1) {
    const full = await safeRunMode('full', repetition, ledger)
    if (full.error !== undefined) {
      report.pairs.push({ repetition, full })
      report.stopReason = ledger.stopReason ?? 'FULL_REQUEST_FAILED'
      break
    }

    const resume = await safeRunMode('resume', repetition, ledger)
    if (resume.error !== undefined) {
      report.pairs.push({ repetition, full, resume })
      report.stopReason = ledger.stopReason ?? 'RESUME_REQUEST_FAILED'
      break
    }

    const comparison = comparePair(full, resume)
    report.pairs.push({ repetition, full, resume, comparison })
    if (!comparison.gatePassed) {
      report.stopReason = 'EARLY_STOP_RESUME_BELOW_20_PERCENT'
      break
    }
    if (ledger.stopReason !== undefined) break
  }

  report.usage = ledger.snapshot()
  report.decision = report.pairs.every(pair => pair.comparison?.gatePassed === true)
    ? 'NEEDS_LONG_SESSION_EVIDENCE'
    : 'KEEP_FULL_NO_PERSISTENT_STORE'
  console.log(JSON.stringify(report, null, 2))
}

await main()
