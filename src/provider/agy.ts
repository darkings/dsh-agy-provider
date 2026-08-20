import { randomUUID } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { parse as parsePath } from 'node:path'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import {
  CallId,
  EMPTY_RESPONSE_CODE,
  LlmAdapter,
  LlmError,
  resolveRetryPolicy,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  ReasoningEffortId,
  LlmResolvedModelInfo,
  StreamChunk,
  TokenUsage,
  ResolvedRetryPolicy,
} from '@deepseek-ai/dsh-llm'
import { ExperimentalAgyTransport } from '../agy/persistent-transport.js'
import {
  AgyProcessError,
  isAgyReasoningEffort,
  runAgyProcess,
  type AgyExecutionMode,
  type AgyReasoningEffort,
  type AgyRequest,
  type ProcessResult,
} from '../agy/process.js'
import { getAgentPreset, type AgentPresetId } from '../agent-presets.js'
import {
  AgyModelDiscovery,
  type AgyModelDiscoveryCommand,
  type AgyModelDiscoveryResult,
} from '../agy/models.js'
import { diagnoseAgy, type AgyDiagnosticResult } from '../agy/diagnostics.js'
import { AgyConcurrencyLimiter, AgyQueueError } from '../agy/limiter.js'
import {
  buildAgyLogRecord,
  emitAgyLog,
  type AgyBridgeOutcome,
  type AgyLogger,
  type AgyTelemetry,
} from '../agy/log.js'
import { classifyAgyFailure, safeAgyFailureMessage } from '../agy/errors.js'
import {
  AgyParserError,
  AgyStreamParser,
  conversationIdOf,
  emptyAgyEventCategoryCounts,
  errorDetailOf,
  eventCategoryOf,
  isToolEvent,
  isPermissionEvent,
  responseOf,
  statusOf,
  textDeltaOf,
  usageOf,
  type AgyJsonEvent,
} from '../agy/parser.js'
import { resolveAgyExecutable } from '../agy/process.js'
import {
  AGY_RETRYABLE_CODES,
  configuredModels,
  DEFAULT_MODEL,
  type AgyRetryPolicyConfig,
  type Config,
  type ModelConfig,
  type PurposeRouteConfig,
  type PurposeRoutesConfig,
  type PersistentFallbackMode,
  type ToolPolicy,
  type TransportMode,
} from './config.js'
import {
  DSH_CONTEXT_UNAVAILABLE_CODE,
  PERMISSION_REQUIRED_CODE,
  UNSUPPORTED_REASONING_EFFORT_CODE,
  UNSUPPORTED_TOOLS_CODE,
} from './error-codes.js'
import { SessionRegistry, type SessionRecord } from '../session/store.js'
import { AgyPromptError, serializeAgyTurnPrompt } from './serialize.js'
import {
  appendToolProtocolPrompt,
  createStructuredToolProtocol,
  parseStructuredEnvelope,
  ToolProtocolError,
  TOOL_PROTOCOL_RESPONSE_INVALID_CODE,
  type StructuredToolProtocol,
} from './tool-protocol.js'
import {
  AgyImageBridgeError,
  prepareAgyPrompts,
  type AgyImageAttachmentStore,
  type PreparedAgyPrompts,
} from './image-bridge.js'
import {
  DshContextError,
  resolveDshContext,
  type DshContextLookup,
  type DshContextSnapshot,
} from '../dsh/context.js'

export type AgyProcessRunner = (request: AgyRequest) => Promise<ProcessResult>

export interface AgyAdapterDependencies {
  /** Injectable seam for deterministic tests; production uses `runAgyProcess`. */
  runAgyProcess?: AgyProcessRunner
  /** Injectable quota-free `agy models` command for deterministic tests. */
  runModelDiscovery?: AgyModelDiscoveryCommand
  /** Injectable session mapping for tests or a future persistent store. */
  sessionRegistry?: SessionRegistry
  /** Optional structured logger; logging failures never affect the request. */
  logger?: AgyLogger
  /** Injectable process limiter for deterministic concurrency tests. */
  concurrencyLimiter?: AgyConcurrencyLimiter
  /** Optional DSH AttachmentStore; text-only requests do not require it. */
  attachmentStore?: Pick<AttachmentStore, 'readImage'>
  /** Optional Cordis reflection seam for the DSH-owned capability context. */
  dshContext?: DshContextLookup
}

interface AttemptOutcome {
  retryWithFullPrompt: boolean
}

interface EffectiveAgyRoute {
  model: string
  agent: string
  reasoningEffort: AgyReasoningEffort | undefined
}

interface AgyAgentRuntime {
  agent: string
  agentPreset: AgentPresetId | undefined
  agentCanViewFile: boolean
  workspaceRoot: string | undefined
  addDirs: readonly string[] | undefined
  mode: AgyExecutionMode | undefined
  disableSlashCommands: boolean | undefined
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

const DEFAULT_AGENT = 'deepseek-proxy'
const DEFAULT_MINIMUM_AGY_VERSION = '1.1.13'
const DEFAULT_MAX_CONCURRENT = 4
const DEFAULT_MAX_QUEUE = 32
const DEFAULT_QUEUE_TIMEOUT_MS = 30_000
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_EVENT_LINE_LENGTH = 1_048_576

function canonicalWorkspaceRoot(value: string | undefined): string | undefined {
  const selected = value?.trim()
  if (selected === undefined || selected.length === 0) return undefined
  try {
    const canonical = realpathSync(selected)
    if (!statSync(canonical).isDirectory() || canonical === parsePath(canonical).root) {
      throw new Error('workspace root must be a non-root directory')
    }
    return canonical
  } catch (error) {
    throw new RangeError(
      `workspaceRoot must point to an existing non-root directory: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}

function resolveAgyAgentRuntime(config: Config, toolPolicy: ToolPolicy): AgyAgentRuntime {
  const dshOwned = toolPolicy === 'dsh-owned'
  const configuredPreset = config.agentPreset === undefined ? undefined : getAgentPreset(config.agentPreset)
  if (config.agentPreset !== undefined && configuredPreset === undefined) {
    throw new RangeError('agentPreset must be one of: tool-free, read-only, workspace-write')
  }
  const preset = dshOwned
    ? getAgentPreset('tool-free')
    : configuredPreset
  const workspaceRoot = dshOwned ? undefined : canonicalWorkspaceRoot(config.workspaceRoot)
  if (preset?.writeAccess === true && workspaceRoot === undefined) {
    throw new RangeError('workspaceRoot is required when agentPreset is workspace-write')
  }
  return {
    agent: preset?.agentName ?? config.agent ?? DEFAULT_AGENT,
    agentPreset: preset?.id,
    agentCanViewFile: preset?.tools.includes('view_file') === true,
    workspaceRoot,
    addDirs: workspaceRoot === undefined ? undefined : [workspaceRoot],
    mode: preset?.mode,
    disableSlashCommands: preset === undefined ? undefined : true,
  }
}

const AGY_REASONING_METADATA = [
  {
    id: 'low' as ReasoningEffortId,
    name: 'Low',
    description: 'Lower reasoning budget through the AGY model backend.',
  },
  {
    id: 'medium' as ReasoningEffortId,
    name: 'Medium',
    description: 'Balanced reasoning budget through the AGY model backend.',
  },
  {
    id: 'high' as ReasoningEffortId,
    name: 'High',
    description: 'Higher reasoning budget through the AGY model backend.',
  },
] as const

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
  if (error instanceof DshContextError) {
    return new LlmError(error.message, error.code, { cause: error })
  }
  if (error instanceof AgyPromptError) {
    return new LlmError(error.message, error.code, { cause: error })
  }
  if (error instanceof ToolProtocolError) {
    return new LlmError(error.message, error.code, { cause: error })
  }
  if (error instanceof AgyImageBridgeError) {
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
  if (result.termination === 'output-limit') {
    return new LlmError('AGY output exceeded the configured capture limit', 'AGY_OUTPUT_LIMIT')
  }
  if (result.termination !== 'completed' || result.exitCode !== 0) {
    const stderr = result.stderr.trim()
    const code = classifyAgyFailure(stderr, 'AGY_EXIT')
    return new LlmError(
      stderr.length === 0
        ? `AGY exited unsuccessfully (exit code ${result.exitCode ?? 'unknown'})`
        : safeAgyFailureMessage('AGY exited unsuccessfully', stderr),
      code,
    )
  }
  return undefined
}

function isSuccessStatus(status: string | undefined): boolean {
  return status === undefined || status.toUpperCase() === 'SUCCESS'
}

function bridgeOutcomeForError(code: string, current: AgyBridgeOutcome): AgyBridgeOutcome {
  if (code.startsWith('DSH_')) return 'context-rejected'
  if (code === PERMISSION_REQUIRED_CODE) return 'permission-required'
  if (code === 'TOOL_PROTOCOL_SCHEMA_INVALID' || code === 'TOOL_PROTOCOL_SCHEMA_LIMIT') {
    return 'schema-rejected'
  }
  if (code.startsWith('TOOL_PROTOCOL_')) return 'protocol-rejected'
  if (code === UNSUPPORTED_TOOLS_CODE) {
    if (current === 'agy-internal-tool' || current === 'schema-rejected') return current
    return 'failed'
  }
  return current === 'dsh-pending' ? 'failed' : current
}

function setDshTelemetrySnapshot(
  telemetry: AgyTelemetry,
  snapshot: DshContextSnapshot,
): void {
  if (snapshot.permissionPreset === 'read-only'
    || snapshot.permissionPreset === 'workspace-write'
    || snapshot.permissionPreset === 'danger-full-access') {
    telemetry.permissionPreset = snapshot.permissionPreset
  }
  if (snapshot.sandboxMode !== undefined) telemetry.sandboxMode = snapshot.sandboxMode
  if (snapshot.approvalPolicy !== undefined) telemetry.approvalPolicy = snapshot.approvalPolicy
}

function normalizeReasoningEffort(value: unknown): AgyReasoningEffort | undefined {
  if (value === undefined) return undefined
  if (isAgyReasoningEffort(value)) return value
  throw new LlmError(
    'AGY supports reasoning efforts: low, medium, high',
    UNSUPPORTED_REASONING_EFFORT_CODE,
  )
}

function resolveAgyRetryPolicy(config: AgyRetryPolicyConfig | undefined): ResolvedRetryPolicy {
  const maxRetries = config?.maxRetries ?? 0
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 2) {
    throw new RangeError('AGY retryPolicy.maxRetries must be an integer between 0 and 2')
  }
  const retryableCodes = config?.retryableCodes ?? [...AGY_RETRYABLE_CODES]
  if (retryableCodes.length === 0 || retryableCodes.some(code => !AGY_RETRYABLE_CODES.includes(code))) {
    throw new RangeError(`AGY retryPolicy.retryableCodes must use only: ${AGY_RETRYABLE_CODES.join(', ')}`)
  }
  return resolveRetryPolicy({
    mode: 'normal',
    maxRetries,
    retryableCodes: [...retryableCodes],
  }, 'dsh-agy-provider.retryPolicy')
}

function addUsage(left: TokenUsage | undefined, right: TokenUsage): TokenUsage {
  const sumOptional = (key: 'cacheReadTokens' | 'cacheWriteTokens' | 'reasoningTokens'): number | undefined => {
    const leftValue = left?.[key]
    const rightValue = right[key]
    if (leftValue === undefined && rightValue === undefined) return undefined
    return (leftValue ?? 0) + (rightValue ?? 0)
  }
  const cacheReadTokens = sumOptional('cacheReadTokens')
  const cacheWriteTokens = sumOptional('cacheWriteTokens')
  const reasoningTokens = sumOptional('reasoningTokens')
  return {
    inputTokens: (left?.inputTokens ?? 0) + right.inputTokens,
    outputTokens: (left?.outputTokens ?? 0) + right.outputTokens,
    ...(cacheReadTokens === undefined
      ? {}
      : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined
      ? {}
      : { cacheWriteTokens }),
    ...(reasoningTokens === undefined
      ? {}
      : { reasoningTokens }),
  }
}

function purposeRouteFor(
  purpose: GenerateOptions['purpose'],
  routes: PurposeRoutesConfig | undefined,
): PurposeRouteConfig | undefined {
  if (purpose === 'compaction') return routes?.compaction
  if (purpose === 'session-title') return routes?.sessionTitle
  return undefined
}

/** DSH text-only adapter backed by the locally authenticated AGY CLI. */
export class AgyAdapter extends LlmAdapter {
  private readonly model: string
  private readonly models: readonly ModelConfig[]
  private readonly agent: string
  private readonly workspaceRoot: string | undefined
  private readonly addDirs: readonly string[] | undefined
  private readonly mode: AgyExecutionMode | undefined
  private readonly disableSlashCommands: boolean | undefined
  private readonly agentCanViewFile: boolean
  private readonly toolPolicy: ToolPolicy
  private readonly dshContext: DshContextLookup | undefined
  private readonly agyPath: string | undefined
  private readonly timeoutMs: number
  private readonly run: AgyProcessRunner
  private readonly sessionMode: 'resume' | 'full'
  private readonly sessions: SessionRegistry
  private readonly minimumAgyVersion: string
  private readonly limiter: AgyConcurrencyLimiter
  private readonly logger: AgyLogger | undefined
  private readonly maxOutputBytes: number
  private readonly maxEventLineLength: number
  private readonly retryPolicy: ResolvedRetryPolicy
  private readonly purposeRoutes: PurposeRoutesConfig | undefined
  private readonly transport: TransportMode
  private readonly persistentIdleTtlMs: number
  private readonly persistentReadyTimeoutMs: number
  private readonly persistentFallback: PersistentFallbackMode
  private readonly persistentTransport: ExperimentalAgyTransport | undefined
  private readonly imageInput: 'off' | 'experimental'
  private readonly attachmentStore: AgyImageAttachmentStore | undefined
  private readonly discovery: AgyModelDiscovery | undefined
  private currentModels: readonly ModelConfig[]
  private modelDiscoveryResult: AgyModelDiscoveryResult | undefined

  constructor(config: Config = {}, dependencies: AgyAdapterDependencies = {}) {
    super()
    this.model = config.model ?? DEFAULT_MODEL
    this.models = configuredModels(config)
    this.toolPolicy = config.toolPolicy === 'agy-owned'
      ? 'agy-owned'
      : config.toolPolicy === 'dsh-owned' ? 'dsh-owned' : 'reject'
    const agentRuntime = resolveAgyAgentRuntime(config, this.toolPolicy)
    this.agent = agentRuntime.agent
    this.agentCanViewFile = agentRuntime.agentCanViewFile
    this.workspaceRoot = agentRuntime.workspaceRoot
    this.addDirs = agentRuntime.addDirs
    this.mode = agentRuntime.mode
    this.disableSlashCommands = agentRuntime.disableSlashCommands
    this.dshContext = dependencies.dshContext
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
    this.maxOutputBytes = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    this.maxEventLineLength = config.maxEventLineLength ?? DEFAULT_MAX_EVENT_LINE_LENGTH
    this.retryPolicy = resolveAgyRetryPolicy(config.retryPolicy)
    this.transport = config.transport === 'persistent' ? 'persistent' : 'one-shot'
    this.persistentIdleTtlMs = config.persistentIdleTtlMs ?? 30_000
    this.persistentReadyTimeoutMs = config.persistentReadyTimeoutMs ?? 10_000
    this.persistentFallback = config.persistentFallback === 'never' ? 'never' : 'before-accept'
    this.purposeRoutes = config.purposeRoutes
    this.imageInput = config.imageInput === 'experimental' ? 'experimental' : 'off'
    this.attachmentStore = dependencies.attachmentStore
    this.currentModels = this.models
    this.discovery = config.modelDiscovery === 'off'
      ? undefined
      : new AgyModelDiscovery({
        ...(this.agyPath === undefined ? {} : { executable: this.agyPath }),
        ...(config.modelDiscoveryTtlMs === undefined ? {} : { ttlMs: config.modelDiscoveryTtlMs }),
        ...(config.modelDiscoveryTimeoutMs === undefined ? {} : { timeoutMs: config.modelDiscoveryTimeoutMs }),
        maxOutputBytes: this.maxOutputBytes,
        ...(dependencies.runModelDiscovery === undefined ? {} : { runCommand: dependencies.runModelDiscovery }),
      })
    // Persistent transport is opt-in; one-shot remains default. It is created only when transport:persistent.
    // Session-affine: one AGY stream-json worker per DSH session, single active turn.
    this.persistentTransport = this.transport !== 'persistent' ? undefined : new ExperimentalAgyTransport({
      executable: resolveAgyExecutable(this.agyPath),
      args: [
        '-p', '',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--agent', this.agent,
        '--model', this.model,
        // workspaceRoot is cwd for persistent worker, not an arg
        ...(this.mode === undefined ? [] : ['--mode', this.mode]),
        ...(this.disableSlashCommands ? ['--disable-slash-commands'] : []),
      ],
      ...(this.workspaceRoot === undefined ? {} : { cwd: this.workspaceRoot }),
      idleTtlMs: this.persistentIdleTtlMs,
      readyTimeoutMs: this.persistentReadyTimeoutMs,
      maxWorkers: config.maxConcurrent ?? 4,
    })
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

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.retryPolicy
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await this.effectiveModels()
    return models.map(model => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
      description: model.description ?? `AGY agent ${this.agent}; uses the local AGY account quota.`,
      inputModalities: ['text'] as const,
    }))
  }

  /** Expose safe discovery state for diagnostics and integration tests. */
  getModelDiscoveryStatus(): AgyModelDiscoveryResult | { source: 'static'; stale: false; models: readonly ModelConfig[] } {
    return this.modelDiscoveryResult ?? {
      models: this.currentModels,
      source: 'static',
      stale: false,
    }
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const configured = this.currentModels.find(entry => entry.id === model)
    return Promise.resolve({
      provider,
      id: model,
      name: configured?.name ?? model,
      ...(configured?.description === undefined ? {} : { description: configured.description }),
      inputModalities: ['text'] as const,
      ...(configured?.contextWindow === undefined
        ? {}
        : { context: { contextWindow: configured.contextWindow } }),
      reasoning: {
        efforts: AGY_REASONING_METADATA,
      },
    })
  }


  private shouldUsePersistent(
    options: GenerateOptions,
    sessionKey: string | undefined,
    dshContextSnapshot: DshContextSnapshot | undefined,
    toolSchemaCount: number,
  ): boolean {
    if (this.transport !== 'persistent' || this.persistentTransport === undefined) return false
    if (sessionKey === undefined) return false
    if ((options.purpose as string) === 'compaction' || (options.purpose as string) === 'sessionTitle' || (options.purpose as string) === 'session-title') return false
    if (this.sessionMode === 'resume') return false
    if (toolSchemaCount > 0 && dshContextSnapshot?.state !== 'ready') return false
    return true
  }

  private async *streamPersistentAttempt(
    options: GenerateOptions,
    sessionKey: string,
    telemetry: AgyTelemetry,
    route: EffectiveAgyRoute,
    prepared: PreparedAgyPrompts,
    toolProtocol: StructuredToolProtocol | undefined,
    dshContextSnapshot: DshContextSnapshot | undefined,
  ): AsyncGenerator<StreamChunk, AttemptOutcome, void> {
    if (toolProtocol !== undefined && (
      dshContextSnapshot?.state !== 'ready'
      || dshContextSnapshot.sessionState !== 'trusted'
      || dshContextSnapshot.workspaceState !== 'trusted'
    )) {
      throw new DshContextError(DSH_CONTEXT_UNAVAILABLE_CODE)
    }
    telemetry.processAttemptCount += 1
    const hasConversation = this.sessions.get(sessionKey)?.conversationId !== undefined
    const basePrompt = hasConversation
      ? (prepared.turnPrompt ?? serializeAgyTurnPrompt(options))
      : prepared.fullPrompt
    const prompt = toolProtocol === undefined
      ? basePrompt
      : appendToolProtocolPrompt(basePrompt, toolProtocol)
    // Persistent worker is session-affine, single active turn, reuse AGY conversation
    const result = await this.persistentTransport!.request({
      sessionId: sessionKey,
      text: prompt,
      timeoutMs: this.timeoutMs,
      maxOutputBytes: this.maxOutputBytes,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    // Reuse one-shot event handling by feeding raw events through the same parser logic
    // For simplicity, treat result.events as already-parsed AGY JSON objects
    let blockStarted = false
    let visibleText = ''
    let resultSeen = false
    let finalResponse: string | undefined
    let finalStatus: string | undefined
    let finalErrorDetail: string | undefined
    let finalUsage: Record<string, unknown> | undefined
    const queue: AgyJsonEvent[] = []
    // Convert raw events to AgyJsonEvent via a lightweight parser
    for (const raw of result.events) {
      const r = raw as Record<string, unknown>
      const ev = r.event as string | undefined
      if (ev === 'step_update') {
        const su = r.step_update as Record<string, unknown> | undefined
        const textDelta = su?.text_delta as string | undefined
        const usage = su?.usage as Record<string, unknown> | undefined
        const convId = su?.conversation_id as string | undefined
        if (convId !== undefined) {
          telemetry.conversationId = convId
          this.sessions.set(sessionKey, convId)
        }
        if (usage !== undefined) finalUsage = usage
        if (textDelta !== undefined && toolProtocol === undefined) {
          queue.push({ event: 'step_update', step_update: su } as unknown as AgyJsonEvent)
        } else if (textDelta !== undefined && toolProtocol !== undefined) {
          // For toolProtocol, ignore step_update delta, finalResponse comes from result.response
          queue.push({ event: 'step_update', step_update: su } as unknown as AgyJsonEvent)
        }
        // Also count events
        telemetry.eventCount += 1
        telemetry.eventCategoryCounts[eventCategoryOf({ event: 'step_update' } as unknown as AgyJsonEvent)] += 1
      } else if (ev === 'result') {
        const res = r.result as Record<string, unknown> | undefined
        const convId = res?.conversation_id as string | undefined
        if (convId !== undefined) {
          telemetry.conversationId = convId
          this.sessions.set(sessionKey, convId)
        }
        finalResponse = typeof res?.response === 'string' ? res.response as string : undefined
        finalStatus = typeof res?.status === 'string' ? res.status as string : undefined
        finalErrorDetail = typeof res?.error === 'string' ? res.error as string : undefined
        finalUsage = (res?.usage as Record<string, unknown> | undefined) ?? finalUsage
        resultSeen = true
        telemetry.finalStatus = finalStatus
        queue.push({ event: 'result', result: res } as unknown as AgyJsonEvent)
        telemetry.eventCount += 1
      } else if (ev === 'init') {
        const convId = r.conversation_id as string | undefined
        if (convId !== undefined) {
          telemetry.conversationId = convId
          this.sessions.set(sessionKey, convId)
        }
        queue.push({ event: 'init' } as unknown as AgyJsonEvent)
        telemetry.eventCount += 1
      }
    }
    // Now yield using same logic as one-shot for toolProtocol handling
    for (const event of queue) {
      telemetry.eventCategoryCounts[eventCategoryOf(event)] += 1
      if (isToolEvent(event)) telemetry.toolEventCount += 1
      if (toolProtocol !== undefined && isToolEvent(event)) {
        throw new LlmError('AGY emitted an internal tool event while DSH-owned tools were enabled', UNSUPPORTED_TOOLS_CODE)
      }
      const delta = toolProtocol === undefined ? textDeltaOf(event) : undefined
      if (delta !== undefined && delta.length > 0) {
        if (!blockStarted) {
          blockStarted = true
          yield { type: 'block-start', index: 0, blockType: 'text' }
        }
        visibleText += delta
        yield { type: 'text-delta', index: 0, text: delta }
      }
      if (event.event === 'result') {
        if (toolProtocol !== undefined && resultSeen && queue.filter(e=>e.event==='result').length>1) {
          throw new ToolProtocolError(TOOL_PROTOCOL_RESPONSE_INVALID_CODE, 'duplicate final response')
        }
      }
    }
    const attemptUsage = finalUsage === undefined ? undefined : mapAgyUsage(finalUsage)
    if (attemptUsage !== undefined) telemetry.usage = addUsage(telemetry.usage, attemptUsage)
    if (toolProtocol !== undefined) {
      if (finalResponse === undefined) {
        throw new ToolProtocolError(TOOL_PROTOCOL_RESPONSE_INVALID_CODE, 'missing final response')
      }
      const envelope = parseStructuredEnvelope(finalResponse, toolProtocol)
      if (envelope.kind === 'message') {
        telemetry.bridgeOutcome = 'dsh-message'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        if (envelope.content.length > 0) yield { type: 'text-delta', index: 0, text: envelope.content }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: envelope.content } }
        if (attemptUsage !== undefined) yield { type: 'usage', usage: attemptUsage }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return { retryWithFullPrompt: false }
      }
      const callId = CallId(randomUUID())
      const argumentsJson = JSON.stringify(envelope.arguments)
      telemetry.toolCallCount += 1
      telemetry.bridgeOutcome = 'dsh-tool-call'
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: callId, name: envelope.name, argumentsDelta: argumentsJson }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: envelope.name, arguments: argumentsJson } }
      if (attemptUsage !== undefined) yield { type: 'usage', usage: attemptUsage }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return { retryWithFullPrompt: false }
    }
    // Text-only: already yielded deltas, need to close block and finish
    if (blockStarted) {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: visibleText } }
    } else if (finalResponse !== undefined) {
      // No delta was yielded, but result has response
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: finalResponse }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: finalResponse } }
    }
    if (attemptUsage !== undefined) yield { type: 'usage', usage: attemptUsage }
    yield { type: 'finish', reason: { kind: 'stop' } }
    return { retryWithFullPrompt: false }
  }

    private async effectiveModels(): Promise<readonly ModelConfig[]> {
    if (this.discovery === undefined) {
      this.currentModels = this.models
      this.modelDiscoveryResult = undefined
      return this.currentModels
    }
    const result = await this.discovery.discover(this.models)
    this.currentModels = result.models
    this.modelDiscoveryResult = result
    return this.currentModels
  }

  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk, void, void> {
    if (options.signal?.aborted) throw abortError()
    const toolSchemaCount = options.tools?.length ?? 0
    const sessionKey = options.sessionId === undefined ? undefined : String(options.sessionId)
    let toolProtocol: StructuredToolProtocol | undefined
    let dshContextSnapshot: DshContextSnapshot | undefined
    const purposeRoute = purposeRouteFor(options.purpose, this.purposeRoutes)
    const requestedReasoningEffort = normalizeReasoningEffort(options.reasoningEffort)
    const purposeReasoningEffort = normalizeReasoningEffort(purposeRoute?.reasoningEffort)
    const route: EffectiveAgyRoute = {
      model: purposeRoute?.model ?? (options.model || this.model),
      agent: purposeRoute?.agent ?? this.agent,
      reasoningEffort: purposeReasoningEffort ?? requestedReasoningEffort,
    }

    const telemetry: AgyTelemetry = {
      requestId: randomUUID(),
      provider: options.provider,
      model: route.model,
      agent: route.agent,
      toolPolicy: this.toolPolicy,
      toolSchemaCount,
      toolCallCount: 0,
      bridgeOutcome: toolSchemaCount === 0
        ? 'text-only'
        : this.toolPolicy === 'dsh-owned'
          ? 'dsh-pending'
          : this.toolPolicy === 'agy-owned' ? 'agy-owned' : 'schema-rejected',
      ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
      ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
      ...(this.discovery === undefined
        ? { modelDiscoverySource: 'static' as const }
        : this.modelDiscoveryResult === undefined
          ? {}
          : {
              modelDiscoverySource: this.modelDiscoveryResult.source,
              ...(this.modelDiscoveryResult.warningCode === undefined
                ? {}
                : { modelDiscoveryWarningCode: this.modelDiscoveryResult.warningCode }),
            }),
      sessionId: sessionKey,
      startedAt: Date.now(),
      attempt: 1,
      processAttemptCount: 0,
      retryMaxRetries: this.retryPolicy.mode === 'normal' ? this.retryPolicy.maxRetries : 0,
      eventCount: 0,
      toolEventCount: 0,
      permissionEventCount: 0,
      eventCategoryCounts: emptyAgyEventCategoryCounts(),
      finalStatus: undefined,
      conversationId: undefined,
      queueWaitMs: undefined,
      process: undefined,
      usage: undefined,
      durationMs: undefined,
    }
    emitAgyLog(this.logger, buildAgyLogRecord(telemetry, 'agy.request.started'))

    let releaseSession: (() => void) | undefined
    let releaseProcess: (() => void) | undefined
    let preparedPrompts: PreparedAgyPrompts | undefined
    try {
      if (toolSchemaCount > 0 && this.toolPolicy === 'dsh-owned') {
        dshContextSnapshot = await resolveDshContext(this.dshContext, {
          ...(sessionKey === undefined ? {} : { sessionId: sessionKey }),
          toolSchemaCount,
        })
        setDshTelemetrySnapshot(telemetry, dshContextSnapshot)
        try {
          toolProtocol = createStructuredToolProtocol(options.tools ?? [])
        } catch (error) {
          telemetry.bridgeOutcome = 'schema-rejected'
          throw error
        }
      }
      if (toolSchemaCount > 0 && this.toolPolicy === 'reject') {
        throw new LlmError(
          'AGY text MVP does not accept DSH tool schemas under toolPolicy: reject; set toolPolicy: dsh-owned or agy-owned explicitly',
          UNSUPPORTED_TOOLS_CODE,
        )
      }
      if (options.temperature !== undefined || options.maxTokens !== undefined || options.stop !== undefined) {
        throw new LlmError(
          'AGY text MVP does not yet map sampling, maxTokens, or stop controls',
          'UNSUPPORTED_OPTIONS',
        )
      }
      const prepared = await prepareAgyPrompts(options, {
        enabled: this.imageInput === 'experimental',
        agentCanViewFile: this.agentCanViewFile,
        attachmentStore: this.attachmentStore,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      preparedPrompts = prepared
      releaseSession = sessionKey === undefined ? undefined : await this.sessions.acquire(sessionKey)
      const queueStartedAt = Date.now()
      releaseProcess = await this.limiter.acquire(options.signal)
      telemetry.queueWaitMs = Date.now() - queueStartedAt

      // V8-M2 persistent dispatch: one Session one worker, before-accept fallback
      if (this.shouldUsePersistent(options, sessionKey, dshContextSnapshot, toolSchemaCount)) {
        try {
          const outcome = yield* this.streamPersistentAttempt(
            options,
            sessionKey!,
            telemetry,
            route,
            prepared,
            toolProtocol,
            dshContextSnapshot,
          )
          if (!outcome.retryWithFullPrompt) {
            telemetry.durationMs = Date.now() - telemetry.startedAt
            emitAgyLog(this.logger, buildAgyLogRecord(telemetry, 'agy.request.completed'))
            return
          }
        } catch (error) {
          const beforeAccept = error instanceof Error && (error as any).code !== undefined
            ? ['WORKER_START_FAILED','WORKER_LIMIT','DISPOSED','ABORTED','WORKER_STOPPED'].includes((error as any).code)
            : false
          if (this.persistentFallback === 'before-accept' && beforeAccept) {
            // fallback to one-shot, keep telemetry for retry
          } else {
            throw error
          }
        }
      }

      let requestedConversationId = sessionKey === undefined || this.sessionMode === 'full'
        ? undefined
        : this.sessions.get(sessionKey)?.conversationId

      for (let attempt = 0; attempt < 2; attempt += 1) {
        telemetry.attempt = attempt + 1
        const outcome = yield* this.streamAttempt(
          options,
          sessionKey,
          requestedConversationId,
          telemetry,
          route,
          prepared,
          toolProtocol,
          dshContextSnapshot,
        )
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
      telemetry.bridgeOutcome = bridgeOutcomeForError(mapped.code, telemetry.bridgeOutcome)
      telemetry.durationMs = Date.now() - telemetry.startedAt
      emitAgyLog(this.logger, buildAgyLogRecord(telemetry, 'agy.request.failed', mapped.code))
      throw mapped
    } finally {
      telemetry.durationMs ??= Date.now() - telemetry.startedAt
      await preparedPrompts?.cleanup()
      releaseProcess?.()
      releaseSession?.()
    }
  }

  private async *streamAttempt(
    options: GenerateOptions,
    sessionKey: string | undefined,
    requestedConversationId: string | undefined,
    telemetry: AgyTelemetry,
    route: EffectiveAgyRoute,
    prepared: PreparedAgyPrompts,
    toolProtocol: StructuredToolProtocol | undefined,
    dshContextSnapshot: DshContextSnapshot | undefined,
  ): AsyncGenerator<StreamChunk, AttemptOutcome, void> {
    if (toolProtocol !== undefined && (
      dshContextSnapshot?.state !== 'ready'
      || dshContextSnapshot.sessionState !== 'trusted'
      || dshContextSnapshot.workspaceState !== 'trusted'
    )) {
      throw new DshContextError(DSH_CONTEXT_UNAVAILABLE_CODE)
    }
    telemetry.processAttemptCount += 1
    const basePrompt = requestedConversationId === undefined
      ? prepared.fullPrompt
      : prepared.turnPrompt ?? serializeAgyTurnPrompt(options)
    const prompt = toolProtocol === undefined
      ? basePrompt
      : appendToolProtocolPrompt(basePrompt, toolProtocol)
    const addDirs = [
      ...(this.addDirs ?? []),
      ...(prepared.imageDirectory === undefined ? [] : [prepared.imageDirectory]),
    ]
    const queue = new AsyncQueue<AgyJsonEvent>()
    const parser = new AgyStreamParser({ maxLineLength: this.maxEventLineLength })
    const controller = new AbortController()
    const forwardAbort = (): void => controller.abort()
    options.signal?.addEventListener('abort', forwardAbort, { once: true })

    let result: ProcessResult | undefined
    let settled = false
    const request: AgyRequest = {
      prompt,
      agent: route.agent,
      model: route.model,
      timeoutMs: this.timeoutMs,
      maxStdoutBytes: this.maxOutputBytes,
      maxStderrBytes: this.maxOutputBytes,
      signal: controller.signal,
      onStdoutLine: line => {
        for (const event of parser.push(`${line}\n`)) queue.push(event)
      },
      ...(requestedConversationId === undefined ? {} : { conversation: requestedConversationId }),
      ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
      ...(this.agyPath === undefined ? {} : { executable: this.agyPath }),
      ...(this.workspaceRoot === undefined ? {} : { cwd: this.workspaceRoot }),
      ...(addDirs.length === 0 ? {} : { addDirs }),
      ...(this.mode === undefined ? {} : { mode: this.mode }),
      ...(this.disableSlashCommands === undefined ? {} : { disableSlashCommands: this.disableSlashCommands }),
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
    let finalErrorDetail: string | undefined
    let finalUsage: Record<string, unknown> | undefined
    let conversationMismatch = false
    let permissionRequested = false

    try {
      for await (const event of queue) {
        telemetry.eventCount += 1
        telemetry.eventCategoryCounts[eventCategoryOf(event)] += 1
        if (isToolEvent(event)) telemetry.toolEventCount += 1
        if (toolProtocol !== undefined && isToolEvent(event)) {
          telemetry.bridgeOutcome = 'agy-internal-tool'
          controller.abort()
          throw new LlmError(
            'AGY emitted an internal tool event while DSH-owned tools were enabled',
            UNSUPPORTED_TOOLS_CODE,
          )
        }
        if (isPermissionEvent(event)) telemetry.permissionEventCount += 1
        const errorDetail = errorDetailOf(event)
        if (errorDetail !== undefined) finalErrorDetail = errorDetail
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
          if (toolProtocol !== undefined) telemetry.bridgeOutcome = 'permission-required'
          permissionRequested = true
          controller.abort()
          continue
        }

        const delta = toolProtocol === undefined ? textDeltaOf(event) : undefined
        if (delta !== undefined && delta.length > 0) {
          if (!blockStarted) {
            blockStarted = true
            yield { type: 'block-start', index: 0, blockType: 'text' }
          }
          visibleText += delta
          yield { type: 'text-delta', index: 0, text: delta }
        }

        if (event.event === 'result') {
          if (toolProtocol !== undefined && resultSeen) {
            controller.abort()
            throw new ToolProtocolError(TOOL_PROTOCOL_RESPONSE_INVALID_CODE, 'duplicate final response')
          }
          resultSeen = true
          finalResponse = responseOf(event)
          finalStatus = statusOf(event)
          telemetry.finalStatus = finalStatus
        }
        const usage = usageOf(event)
        if (usage !== undefined) {
          finalUsage = usage
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

    const attemptUsage = finalUsage === undefined ? undefined : mapAgyUsage(finalUsage)
    if (attemptUsage !== undefined) telemetry.usage = addUsage(telemetry.usage, attemptUsage)

    if (conversationMismatch) return { retryWithFullPrompt: true }
    if (permissionRequested) {
      if (toolProtocol !== undefined) telemetry.bridgeOutcome = 'permission-required'
      throw new LlmError(
        'AGY requested interactive permission; headless Provider cannot approve it. Adjust AGY Agent permissions or tool configuration',
        PERMISSION_REQUIRED_CODE,
      )
    }

    const failure = result === undefined ? new LlmError('AGY process did not return a result', 'AGY_PROCESS') : processFailure(result)
    if (failure !== undefined) throw failure
    if (resultSeen && !isSuccessStatus(finalStatus)) {
      const detail = [finalStatus, finalErrorDetail].filter(value => value !== undefined).join(' ')
      const code = classifyAgyFailure(detail, 'AGY_STATUS')
      throw new LlmError(safeAgyFailureMessage(`AGY returned status ${finalStatus}`, detail), code)
    }
    if (!resultSeen && finalErrorDetail !== undefined) {
      const code = classifyAgyFailure(finalErrorDetail, 'AGY_STATUS')
      throw new LlmError(safeAgyFailureMessage('AGY reported a failure', finalErrorDetail), code)
    }

    if (toolProtocol !== undefined) {
      if (finalResponse === undefined) {
        throw new ToolProtocolError(TOOL_PROTOCOL_RESPONSE_INVALID_CODE, 'missing final response')
      }
      const envelope = parseStructuredEnvelope(finalResponse, toolProtocol)
      if (envelope.kind === 'message') {
        telemetry.bridgeOutcome = 'dsh-message'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        if (envelope.content.length > 0) yield { type: 'text-delta', index: 0, text: envelope.content }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: envelope.content } }
        if (attemptUsage !== undefined) yield { type: 'usage', usage: attemptUsage }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return { retryWithFullPrompt: false }
      }
      const callId = CallId(randomUUID())
      const argumentsJson = JSON.stringify(envelope.arguments)
      telemetry.toolCallCount += 1
      telemetry.bridgeOutcome = 'dsh-tool-call'
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield {
        type: 'tool-call-delta',
        index: 0,
        id: callId,
        name: envelope.name,
        argumentsDelta: argumentsJson,
      }
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: callId,
          name: envelope.name,
          arguments: argumentsJson,
        },
      }
      if (attemptUsage !== undefined) yield { type: 'usage', usage: attemptUsage }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return { retryWithFullPrompt: false }
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
      throw new LlmError('AGY completed without a text response', EMPTY_RESPONSE_CODE)
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: visibleText } }
    if (attemptUsage !== undefined) yield { type: 'usage', usage: attemptUsage }
    yield { type: 'finish', reason: { kind: 'stop' } }
    return { retryWithFullPrompt: false }
  }
}
