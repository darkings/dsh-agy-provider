import { randomUUID } from 'node:crypto'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import {
  AgyProcessError,
  runAgyProcess,
  type AgyRequest,
  type ProcessResult,
} from '../agy/process.js'
import { diagnoseAgy, type AgyDiagnosticResult } from '../agy/diagnostics.js'
import { AgyConcurrencyLimiter, AgyQueueError } from '../agy/limiter.js'
import {
  buildAgyLogRecord,
  emitAgyLog,
  type AgyLogger,
  type AgyTelemetry,
} from '../agy/log.js'
import { redactText } from '../agy/redact.js'
import {
  AgyParserError,
  AgyStreamParser,
  conversationIdOf,
  isToolEvent,
  isPermissionEvent,
  responseOf,
  statusOf,
  textDeltaOf,
  usageOf,
  type AgyJsonEvent,
} from '../agy/parser.js'
import type { Config } from './config.js'
import { SessionRegistry, type SessionRecord } from '../session/store.js'
import { AgyPromptError, serializeAgyPrompt, serializeAgyTurnPrompt } from './serialize.js'

export type AgyProcessRunner = (request: AgyRequest) => Promise<ProcessResult>

export interface AgyAdapterDependencies {
  /** Injectable seam for deterministic tests; production uses `runAgyProcess`. */
  runAgyProcess?: AgyProcessRunner
  /** Injectable session mapping for tests or a future persistent store. */
  sessionRegistry?: SessionRegistry
  /** Optional structured logger; logging failures never affect the request. */
  logger?: AgyLogger
  /** Injectable process limiter for deterministic concurrency tests. */
  concurrencyLimiter?: AgyConcurrencyLimiter
}

interface AttemptOutcome {
  retryWithFullPrompt: boolean
}

class AsyncQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
  private readonly values: T[] = []
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<T>) => void
    reject: (error: unknown) => void
  }> = []
  private closed = false
  private failure: unknown

  push(value: T): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter === undefined) this.values.push(value)
    else waiter.resolve({ done: false, value })
  }

  end(): void {
    if (this.closed) return
    this.closed = true
    while (this.waiters.length > 0) {
      this.waiters.shift()?.resolve({ done: true, value: undefined })
    }
  }

  fail(error: unknown): void {
    if (this.closed) return
    this.closed = true
    this.failure = error
    while (this.waiters.length > 0) {
      this.waiters.shift()?.reject(error)
    }
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift()
    if (value !== undefined) return Promise.resolve({ done: false, value })
    if (this.failure !== undefined) return Promise.reject(this.failure)
    if (this.closed) return Promise.resolve({ done: true, value: undefined })
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }))
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this
  }
}

const DEFAULT_MODEL = 'gemini-3.1-pro-high'
const DEFAULT_AGENT = 'deepseek-proxy'
const DEFAULT_MINIMUM_AGY_VERSION = '1.1.13'
const DEFAULT_MAX_CONCURRENT = 4
const DEFAULT_MAX_QUEUE = 32
const DEFAULT_QUEUE_TIMEOUT_MS = 30_000

function abortError(): LlmError {
  return new LlmError('AGY request aborted by caller', 'ABORTED')
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function firstNumber(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = numberValue(record[key])
    if (value !== undefined) return value
  }
  return undefined
}

/** Convert AGY's observed snake/camel-case usage variants to DSH accounting. */
export function mapAgyUsage(raw: Record<string, unknown>): TokenUsage {
  const input = firstNumber(raw, ['inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens'])
  const output = firstNumber(raw, ['outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens'])
  const cacheRead = firstNumber(raw, ['cacheReadTokens', 'cache_read_tokens', 'cacheReadInputTokens'])
  const cacheWrite = firstNumber(raw, ['cacheWriteTokens', 'cache_write_tokens', 'cacheCreationInputTokens'])
  const reasoning = firstNumber(raw, ['reasoningTokens', 'reasoning_tokens'])
  const total = firstNumber(raw, ['totalTokens', 'total_tokens'])

  // AGY 1.1.13 exposes totalTokens in the observed result. Preserve that
  // total conservatively as input pressure until AGY exposes a split.
  const inputTokens = input ?? (output === undefined ? total ?? 0 : 0)
  const outputTokens = output ?? 0
  return {
    inputTokens,
    outputTokens,
    ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  }
}

function asLlmError(error: unknown): LlmError {
  if (error instanceof LlmError) return error
  if (error instanceof AgyPromptError) {
    return new LlmError(error.message, error.code, { cause: error })
  }
  if (error instanceof AgyParserError) {
    return new LlmError(`AGY stream-json parse failed at line ${error.lineNumber}`, 'AGY_PARSE', { cause: error })
  }
  if (error instanceof AgyQueueError) {
    return new LlmError(error.message, error.code, { cause: error })
  }
  if (error instanceof AgyProcessError) {
    return new LlmError(error.message, `AGY_${error.code}`, { cause: error })
  }
  return new LlmError('AGY provider request failed', 'AGY_REQUEST', {
    cause: error instanceof Error ? error : new Error(String(error)),
  })
}

function processFailure(result: ProcessResult): LlmError | undefined {
  if (result.termination === 'aborted') return abortError()
  if (result.termination === 'timeout') {
    return new LlmError('AGY request exceeded the configured timeout', 'TIMEOUT')
  }
  if (result.termination !== 'completed' || result.exitCode !== 0) {
    const stderr = redactText(result.stderr.trim())
    return new LlmError(
      stderr.length === 0
        ? `AGY exited unsuccessfully (exit code ${result.exitCode ?? 'unknown'})`
        : `AGY exited unsuccessfully: ${stderr}`,
      'AGY_EXIT',
    )
  }
  return undefined
}

function isSuccessStatus(status: string | undefined): boolean {
  return status === undefined || status.toUpperCase() === 'SUCCESS'
}

/** DSH text-only adapter backed by the locally authenticated AGY CLI. */
export class AgyAdapter extends LlmAdapter {
  private readonly model: string
  private readonly agent: string
  private readonly agyPath: string | undefined
  private readonly timeoutMs: number
  private readonly run: AgyProcessRunner
  private readonly sessionMode: 'resume' | 'full'
  private readonly sessions: SessionRegistry
  private readonly minimumAgyVersion: string
  private readonly limiter: AgyConcurrencyLimiter
  private readonly logger: AgyLogger | undefined

  constructor(config: Config = {}, dependencies: AgyAdapterDependencies = {}) {
    super()
    this.model = config.model ?? DEFAULT_MODEL
    this.agent = config.agent ?? DEFAULT_AGENT
    this.agyPath = config.agyPath?.trim() === '' ? undefined : config.agyPath?.trim()
    this.timeoutMs = config.timeoutMs ?? 120_000
    this.run = dependencies.runAgyProcess ?? runAgyProcess
    this.sessionMode = config.sessionMode === 'resume' ? 'resume' : 'full'
    this.sessions = dependencies.sessionRegistry ?? new SessionRegistry()
    this.minimumAgyVersion = config.minimumAgyVersion?.trim() || DEFAULT_MINIMUM_AGY_VERSION
    this.limiter = dependencies.concurrencyLimiter ?? new AgyConcurrencyLimiter({
      maxConcurrent: config.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
      maxQueue: config.maxQueue ?? DEFAULT_MAX_QUEUE,
      queueTimeoutMs: config.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS,
    })
    this.logger = dependencies.logger
  }

  /** Remove the in-memory AGY mapping; the next call sends complete DSH history. */
  clearSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId)
  }

  /** Inspect the detached mapping for diagnostics and tests. */
  getSession(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId)
  }

  /** Return process-slot state without exposing prompts, paths, or credentials. */
  getConcurrencyStats() {
    return this.limiter.getStats()
  }

  /** Check AGY path, version, and configured Agent without spending model quota. */
  diagnose(): Promise<AgyDiagnosticResult> {
    return diagnoseAgy({
      ...(this.agyPath === undefined ? {} : { executable: this.agyPath }),
      expectedAgent: this.agent,
      minimumVersion: this.minimumAgyVersion,
      timeoutMs: Math.min(this.timeoutMs, 10_000),
    })
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'AGY' }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{
      provider,
      id: this.model,
      name: this.model,
      description: `AGY agent ${this.agent}; uses the local AGY account quota.`,
      inputModalities: ['text'],
    }])
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      inputModalities: ['text'] as const,
    })
  }

  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk, void, void> {
    if (options.signal?.aborted) throw abortError()
    if (options.tools !== undefined && options.tools.length > 0) {
      throw new LlmError(
        'AGY text MVP does not accept DSH tool schemas; AGY owns tool execution in this phase',
        'UNSUPPORTED_TOOLS',
      )
    }
    if (options.reasoningEffort !== undefined || options.temperature !== undefined
      || options.maxTokens !== undefined || options.stop !== undefined) {
      throw new LlmError(
        'AGY text MVP does not yet map reasoning, sampling, maxTokens, or stop controls',
        'UNSUPPORTED_OPTIONS',
      )
    }

    const sessionKey = options.sessionId === undefined ? undefined : String(options.sessionId)
    const telemetry: AgyTelemetry = {
      requestId: randomUUID(),
      provider: options.provider,
      model: options.model || this.model,
      agent: this.agent,
      sessionId: sessionKey,
      startedAt: Date.now(),
      attempt: 1,
      eventCount: 0,
      toolEventCount: 0,
      permissionEventCount: 0,
      conversationId: undefined,
      queueWaitMs: undefined,
      process: undefined,
      durationMs: undefined,
    }
    emitAgyLog(this.logger, buildAgyLogRecord(telemetry, 'agy.request.started'))

    let releaseSession: (() => void) | undefined
    let releaseProcess: (() => void) | undefined
    try {
      releaseSession = sessionKey === undefined ? undefined : await this.sessions.acquire(sessionKey)
      const queueStartedAt = Date.now()
      releaseProcess = await this.limiter.acquire(options.signal)
      telemetry.queueWaitMs = Date.now() - queueStartedAt

      let requestedConversationId = sessionKey === undefined || this.sessionMode === 'full'
        ? undefined
        : this.sessions.get(sessionKey)?.conversationId

      for (let attempt = 0; attempt < 2; attempt += 1) {
        telemetry.attempt = attempt + 1
        const outcome = yield* this.streamAttempt(options, sessionKey, requestedConversationId, telemetry)
        if (!outcome.retryWithFullPrompt) {
          telemetry.durationMs = Date.now() - telemetry.startedAt
          emitAgyLog(this.logger, buildAgyLogRecord(telemetry, 'agy.request.completed'))
          return
        }
        requestedConversationId = undefined
      }
      throw new LlmError(
        'AGY conversation could not be resumed; full DSH history retry failed',
        'SESSION_RESUME_FAILED',
      )
    } catch (error) {
      const mapped = asLlmError(error)
      telemetry.durationMs = Date.now() - telemetry.startedAt
      emitAgyLog(this.logger, buildAgyLogRecord(telemetry, 'agy.request.failed', mapped.code))
      throw mapped
    } finally {
      telemetry.durationMs ??= Date.now() - telemetry.startedAt
      releaseProcess?.()
      releaseSession?.()
    }
  }

  private async *streamAttempt(
    options: GenerateOptions,
    sessionKey: string | undefined,
    requestedConversationId: string | undefined,
    telemetry: AgyTelemetry,
  ): AsyncGenerator<StreamChunk, AttemptOutcome, void> {
    const prompt = requestedConversationId === undefined
      ? serializeAgyPrompt(options)
      : serializeAgyTurnPrompt(options)
    const queue = new AsyncQueue<AgyJsonEvent>()
    const parser = new AgyStreamParser()
    const controller = new AbortController()
    const forwardAbort = (): void => controller.abort()
    options.signal?.addEventListener('abort', forwardAbort, { once: true })

    let result: ProcessResult | undefined
    let settled = false
    const request: AgyRequest = {
      prompt,
      agent: this.agent,
      model: options.model || this.model,
      timeoutMs: this.timeoutMs,
      signal: controller.signal,
      onStdoutLine: line => {
        for (const event of parser.push(`${line}\n`)) queue.push(event)
      },
      ...(requestedConversationId === undefined ? {} : { conversation: requestedConversationId }),
      ...(this.agyPath === undefined ? {} : { executable: this.agyPath }),
    }
    const processPromise = this.run(request).then(processResultValue => {
      result = processResultValue
      telemetry.process = processResultValue
      settled = true
      for (const event of parser.end()) queue.push(event)
      queue.end()
    }).catch(error => {
      settled = true
      queue.fail(error)
    })

    let blockStarted = false
    let visibleText = ''
    let resultSeen = false
    let finalResponse: string | undefined
    let finalStatus: string | undefined
    let finalUsage: Record<string, unknown> | undefined
    let conversationMismatch = false
    let permissionRequested = false

    try {
      for await (const event of queue) {
        telemetry.eventCount += 1
        if (isToolEvent(event)) telemetry.toolEventCount += 1
        if (isPermissionEvent(event)) telemetry.permissionEventCount += 1
        const observedConversationId = conversationIdOf(event)
        if (observedConversationId !== undefined) {
          telemetry.conversationId = observedConversationId
          if (requestedConversationId !== undefined && observedConversationId !== requestedConversationId) {
            conversationMismatch = true
            controller.abort()
            continue
          }
          if (sessionKey !== undefined) this.sessions.set(sessionKey, observedConversationId)
        }
        if (conversationMismatch) continue
        if (isPermissionEvent(event)) {
          permissionRequested = true
          controller.abort()
          continue
        }

        const delta = textDeltaOf(event)
        if (delta !== undefined && delta.length > 0) {
          if (!blockStarted) {
            blockStarted = true
            yield { type: 'block-start', index: 0, blockType: 'text' }
          }
          visibleText += delta
          yield { type: 'text-delta', index: 0, text: delta }
        }

        if (event.event === 'result') {
          resultSeen = true
          finalResponse = responseOf(event)
          finalStatus = statusOf(event)
          finalUsage = usageOf(event)
        } else {
          const usage = usageOf(event)
          if (usage !== undefined) finalUsage = usage
        }
      }
      await processPromise
    } catch (error) {
      throw asLlmError(error)
    } finally {
      if (!settled) controller.abort()
      await processPromise
      options.signal?.removeEventListener('abort', forwardAbort)
    }

    if (conversationMismatch) return { retryWithFullPrompt: true }
    if (permissionRequested) {
      throw new LlmError(
        'AGY requested interactive permission; headless Provider cannot approve it',
        'PERMISSION_REQUIRED',
      )
    }

    const failure = result === undefined ? new LlmError('AGY process did not return a result', 'AGY_PROCESS') : processFailure(result)
    if (failure !== undefined) throw failure
    if (resultSeen && !isSuccessStatus(finalStatus)) {
      throw new LlmError(`AGY returned status ${finalStatus}`, 'AGY_STATUS')
    }

    if (finalResponse !== undefined) {
      const suffix = visibleText.length === 0
        ? finalResponse
        : finalResponse.startsWith(visibleText) ? finalResponse.slice(visibleText.length) : ''
      if (suffix.length > 0) {
        if (!blockStarted) {
          blockStarted = true
          yield { type: 'block-start', index: 0, blockType: 'text' }
        }
        visibleText += suffix
        yield { type: 'text-delta', index: 0, text: suffix }
      }
    }

    if (!blockStarted) {
      throw new LlmError('AGY completed without a text response', 'EMPTY_RESPONSE')
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: visibleText } }
    if (finalUsage !== undefined) yield { type: 'usage', usage: mapAgyUsage(finalUsage) }
    yield { type: 'finish', reason: { kind: 'stop' } }
    return { retryWithFullPrompt: false }
  }
}
