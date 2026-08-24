import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isAgyReasoningEffort,
  type AgyProcessDiagnostic,
  type AgyReasoningEffort,
  type ProcessResult,
  type ProcessTermination,
} from './process.js'
import { redactText } from './redact.js'
import {
  isAgyToolEventKind,
  type AgyToolEventCarrierShape,
  type AgyToolEventDiagnostic,
  type AgyToolEventRecipientClass,
  type AgyEventCategoryCounts,
  type AgyToolEventKind,
} from './parser.js'
import type { ToolPolicy } from '../provider/config.js'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import {
  isModelDiscoveryErrorCode,
  type ModelDiscoveryErrorCode,
} from '../provider/error-codes.js'
import type { ModelDiscoverySource } from './models.js'
import type {
  ToolProtocolArgumentIssue,
  ToolProtocolCompatibility,
} from '../provider/tool-protocol.js'

export type AgyModelDiscoveryLogSource = 'static' | ModelDiscoverySource

export type AgyPermissionPreset = 'read-only' | 'workspace-write' | 'danger-full-access'
export type AgySandboxMode = AgyPermissionPreset
export type AgyApprovalPolicy = 'ask' | 'never'
export type AgyBridgeOutcome =
  | 'text-only'
  | 'dsh-pending'
  | 'dsh-message'
  | 'dsh-tool-call'
  | 'agy-owned'
  | 'context-rejected'
  | 'schema-rejected'
  | 'protocol-rejected'
  | 'agy-internal-tool'
  | 'permission-required'
  | 'failed'

export type AgyRequestMode = 'full' | 'bootstrap' | 'delta' | 'full-fallback'
export type AgyUsageSource = 'step' | 'result-fallback'

export type AgyCarrierValidation =
  | 'recipient-rejected'
  | 'valid-message'
  | 'valid-tool-call'
  | 'invalid-envelope'
  | 'unknown-tool'
  | 'arguments-invalid'
  | 'response-limit'

/** Safe, fixed labels for a rejected DSH-owned final response. */
export type AgyProtocolFailureDetail =
  | 'not-json'
  | 'envelope'
  | 'message-shape'
  | 'tool-call-shape'
  | 'response-limit'
  | 'validation'
  | 'unknown'

export type AgyProtocolArgumentIssue = ToolProtocolArgumentIssue

const PROTOCOL_ARGUMENT_ISSUES: readonly AgyProtocolArgumentIssue[] = [
  'missing-required',
  'unexpected-property',
  'type',
  'enum',
  'constraint',
  'combinator',
  'unknown',
]

const PROTOCOL_COMPATIBILITIES: readonly ToolProtocolCompatibility[] = [
  'pwsh-description-default',
  'json-control-character-escape',
  'agy-call-envelope',
  'agy-command-envelope',
  'agy-thought-call-envelope',
  'agy-bare-call-envelope',
]

function isAgyProtocolArgumentIssue(value: unknown): value is AgyProtocolArgumentIssue {
  return typeof value === 'string'
    && PROTOCOL_ARGUMENT_ISSUES.includes(value as AgyProtocolArgumentIssue)
}

function isToolProtocolCompatibility(value: unknown): value is ToolProtocolCompatibility {
  return typeof value === 'string'
    && PROTOCOL_COMPATIBILITIES.includes(value as ToolProtocolCompatibility)
}

function safeProtocolKeyList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.slice(0, 16).map(key => typeof key === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(key)
    ? key
    : '[redacted]')
}

/** Safe shape labels; the response body is intentionally never logged. */
export type AgyProtocolResponseShape =
  | 'empty'
  | 'object-like'
  | 'array-like'
  | 'fenced'
  | 'plain-text'
  | 'non-string'

const BRIDGE_OUTCOMES: readonly AgyBridgeOutcome[] = [
  'text-only',
  'dsh-pending',
  'dsh-message',
  'dsh-tool-call',
  'agy-owned',
  'context-rejected',
  'schema-rejected',
  'protocol-rejected',
  'agy-internal-tool',
  'permission-required',
  'failed',
]

function isAgyBridgeOutcome(value: unknown): value is AgyBridgeOutcome {
  return typeof value === 'string' && BRIDGE_OUTCOMES.includes(value as AgyBridgeOutcome)
}

function isAgyPermissionPreset(value: unknown): value is AgyPermissionPreset {
  return value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access'
}

function isAgyApprovalPolicy(value: unknown): value is AgyApprovalPolicy {
  return value === 'ask' || value === 'never'
}

const MODEL_DISCOVERY_LOG_SOURCES: readonly AgyModelDiscoveryLogSource[] = [
  'static',
  'discovered',
  'merged',
  'cache',
  'fallback',
]

function isModelDiscoveryLogSource(value: unknown): value is AgyModelDiscoveryLogSource {
  return typeof value === 'string'
    && MODEL_DISCOVERY_LOG_SOURCES.includes(value as AgyModelDiscoveryLogSource)
}

export type AgyLogEvent =
  | 'agy.request.started'
  | 'agy.request.completed'
  | 'agy.request.failed'

export interface AgyLogRecord {
  event: AgyLogEvent
  requestId: string
  provider: string
  model: string
  agent: string
  toolPolicy: ToolPolicy
  toolSchemaCount: number
  toolCallCount: number
  bridgeOutcome: AgyBridgeOutcome
  permissionPreset?: AgyPermissionPreset
  sandboxMode?: AgySandboxMode
  approvalPolicy?: AgyApprovalPolicy
  reasoningEffort?: AgyReasoningEffort
  purpose?: 'compaction' | 'session-title'
  modelDiscoverySource?: AgyModelDiscoveryLogSource
  modelDiscoveryWarningCode?: ModelDiscoveryErrorCode
  attempt: number
  processAttemptCount?: number
  retryMaxRetries?: number
  inputFrameBytes?: number
  inputFrameLimitBytes?: number
  promptBytes?: number
  promptLimitBytes?: number
  toolResultCount?: number
  largestToolResultBytes?: number
  truncatedToolResultCount?: number
  historyCompacted?: boolean
  omittedMessageCount?: number
  toolEventKind?: AgyToolEventKind
  toolEventStreamIndex?: number
  toolEventDiagnostic?: AgyToolEventDiagnostic
  /** True when the wrapper was intentionally aborted after a validated carrier was captured. */
  carrierAbortExpected?: boolean
  carrierValidation?: AgyCarrierValidation
  protocolRepairAttempts?: number
  protocolRepairReason?: 'not-json' | 'arguments-invalid' | 'internal-tool-event'
  protocolFailureDetail?: AgyProtocolFailureDetail
  protocolResponseShape?: AgyProtocolResponseShape
  protocolResponseBytes?: number
  protocolToolName?: string
  protocolArgumentIssue?: AgyProtocolArgumentIssue
  protocolMissingRequiredKeys?: readonly string[]
  protocolReceivedArgumentKeys?: readonly string[]
  protocolCompatibilityApplied?: ToolProtocolCompatibility
  eventCount: number
  toolEventCount: number
  permissionEventCount: number
  eventCategoryCounts: Readonly<AgyEventCategoryCounts>
  finalStatus?: string
  sessionId?: string
  conversationId?: string
  durationMs?: number
  exitCode?: number | null
  termination?: ProcessTermination
  queueWaitMs?: number
  usage?: TokenUsage
  /** Current physical-turn usage selected from the latest step event. */
  usageSource?: AgyUsageSource
  /** AGY result usage is conversation-cumulative and is telemetry only. */
  cumulativeUsage?: TokenUsage
  cacheHit?: boolean
  cacheTokenShare?: number
  requestMode?: AgyRequestMode
  conversationReused?: boolean
  stablePrefixBytes?: number
  stablePrefixHash?: string
  toolSchemaHash?: string
  /** Session/conversation identifiers are represented only by one-way fingerprints. */
  sessionFingerprint?: string
  conversationFingerprint?: string
  processDiagnostic?: AgyProcessDiagnostic
  errorCode?: string
}

export type AgyLogger = (record: Readonly<AgyLogRecord>) => void

/**
 * Temporary test-observability sink. The caller must pass an already
 * sanitized record; this file is intentionally outside the DSH session store
 * because that store currently drops Error.cause and nested diagnostics.
 */
export const AGY_DIAGNOSTIC_LOG_PATH = join(tmpdir(), 'dsh-agy-provider-diagnostic.jsonl')

export function appendAgyDiagnosticRecord(record: Readonly<AgyLogRecord>): void {
  try {
    appendFileSync(AGY_DIAGNOSTIC_LOG_PATH, `${JSON.stringify(record)}\n`, 'utf8')
  } catch {
    // Diagnostic persistence must never affect a model request.
  }
}

/** Mutable request counters kept separate from the public log shape. */
export interface AgyTelemetry {
  readonly requestId: string
  readonly provider: string
  readonly model: string
  readonly agent: string
  readonly toolPolicy: ToolPolicy
  readonly toolSchemaCount: number
  toolCallCount: number
  bridgeOutcome: AgyBridgeOutcome
  permissionPreset?: AgyPermissionPreset
  sandboxMode?: AgySandboxMode
  approvalPolicy?: AgyApprovalPolicy
  readonly reasoningEffort?: AgyReasoningEffort
  readonly purpose?: 'compaction' | 'session-title'
  readonly modelDiscoverySource?: AgyModelDiscoveryLogSource
  readonly modelDiscoveryWarningCode?: ModelDiscoveryErrorCode
  readonly sessionId: string | undefined
  readonly startedAt: number
  durationMs: number | undefined
  attempt: number
  processAttemptCount: number
  retryMaxRetries: number
  inputFrameBytes: number | undefined
  inputFrameLimitBytes: number | undefined
  promptBytes: number | undefined
  promptLimitBytes: number | undefined
  toolResultCount: number | undefined
  largestToolResultBytes: number | undefined
  truncatedToolResultCount: number | undefined
  historyCompacted: boolean
  omittedMessageCount: number
  toolEventKind: AgyToolEventKind | undefined
  toolEventStreamIndex: number | undefined
  toolEventDiagnostic: AgyToolEventDiagnostic | undefined
  carrierAbortExpected: boolean
  carrierValidation: AgyCarrierValidation | undefined
  protocolRepairAttempts: number
  protocolRepairReason: 'not-json' | 'arguments-invalid' | 'internal-tool-event' | undefined
  protocolFailureDetail: AgyProtocolFailureDetail | undefined
  protocolResponseShape: AgyProtocolResponseShape | undefined
  protocolResponseBytes: number | undefined
  protocolToolName: string | undefined
  protocolArgumentIssue: AgyProtocolArgumentIssue | undefined
  protocolMissingRequiredKeys: readonly string[] | undefined
  protocolReceivedArgumentKeys: readonly string[] | undefined
  protocolCompatibilityApplied: ToolProtocolCompatibility | undefined
  eventCount: number
  toolEventCount: number
  permissionEventCount: number
  eventCategoryCounts: AgyEventCategoryCounts
  finalStatus: string | undefined
  conversationId: string | undefined
  queueWaitMs: number | undefined
  process: ProcessResult | undefined
  usage: TokenUsage | undefined
  usageSource: AgyUsageSource | undefined
  cumulativeUsage: TokenUsage | undefined
  cacheHit: boolean | undefined
  cacheTokenShare: number | undefined
  requestMode: AgyRequestMode | undefined
  conversationReused: boolean | undefined
  stablePrefixBytes: number | undefined
  stablePrefixHash: string | undefined
  toolSchemaHash: string | undefined
  processDiagnostic: AgyProcessDiagnostic | undefined
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16)
}

function baseRecord(telemetry: AgyTelemetry): AgyLogRecord {
  return {
    event: 'agy.request.started',
    requestId: telemetry.requestId,
    provider: telemetry.provider,
    model: telemetry.model,
    agent: telemetry.agent,
    toolPolicy: telemetry.toolPolicy,
    toolSchemaCount: telemetry.toolSchemaCount,
    toolCallCount: telemetry.toolCallCount,
    bridgeOutcome: telemetry.bridgeOutcome,
    ...(telemetry.permissionPreset === undefined ? {} : { permissionPreset: telemetry.permissionPreset }),
    ...(telemetry.sandboxMode === undefined ? {} : { sandboxMode: telemetry.sandboxMode }),
    ...(telemetry.approvalPolicy === undefined ? {} : { approvalPolicy: telemetry.approvalPolicy }),
    ...(telemetry.reasoningEffort === undefined ? {} : { reasoningEffort: telemetry.reasoningEffort }),
    ...(telemetry.purpose === undefined ? {} : { purpose: telemetry.purpose }),
    ...(telemetry.modelDiscoverySource === undefined ? {} : { modelDiscoverySource: telemetry.modelDiscoverySource }),
    ...(telemetry.modelDiscoveryWarningCode === undefined ? {} : { modelDiscoveryWarningCode: telemetry.modelDiscoveryWarningCode }),
    attempt: telemetry.attempt,
    processAttemptCount: telemetry.processAttemptCount,
    retryMaxRetries: telemetry.retryMaxRetries,
    ...(telemetry.inputFrameBytes === undefined ? {} : { inputFrameBytes: telemetry.inputFrameBytes }),
    ...(telemetry.inputFrameLimitBytes === undefined ? {} : { inputFrameLimitBytes: telemetry.inputFrameLimitBytes }),
    ...(telemetry.promptBytes === undefined ? {} : { promptBytes: telemetry.promptBytes }),
    ...(telemetry.promptLimitBytes === undefined ? {} : { promptLimitBytes: telemetry.promptLimitBytes }),
    ...(telemetry.toolResultCount === undefined ? {} : { toolResultCount: telemetry.toolResultCount }),
    ...(telemetry.largestToolResultBytes === undefined ? {} : { largestToolResultBytes: telemetry.largestToolResultBytes }),
    ...(telemetry.truncatedToolResultCount === undefined ? {} : { truncatedToolResultCount: telemetry.truncatedToolResultCount }),
    ...(telemetry.historyCompacted ? { historyCompacted: true } : {}),
    ...(telemetry.omittedMessageCount === 0 ? {} : { omittedMessageCount: telemetry.omittedMessageCount }),
    ...(telemetry.toolEventKind === undefined ? {} : { toolEventKind: telemetry.toolEventKind }),
    ...(telemetry.toolEventStreamIndex === undefined ? {} : { toolEventStreamIndex: telemetry.toolEventStreamIndex }),
    ...(telemetry.toolEventDiagnostic === undefined ? {} : { toolEventDiagnostic: telemetry.toolEventDiagnostic }),
    ...(telemetry.carrierAbortExpected ? { carrierAbortExpected: true } : {}),
    ...(telemetry.carrierValidation === undefined ? {} : { carrierValidation: telemetry.carrierValidation }),
    protocolRepairAttempts: telemetry.protocolRepairAttempts,
    ...(telemetry.protocolRepairReason === undefined ? {} : { protocolRepairReason: telemetry.protocolRepairReason }),
    ...(telemetry.protocolFailureDetail === undefined ? {} : { protocolFailureDetail: telemetry.protocolFailureDetail }),
    ...(telemetry.protocolResponseShape === undefined ? {} : { protocolResponseShape: telemetry.protocolResponseShape }),
    ...(telemetry.protocolResponseBytes === undefined ? {} : { protocolResponseBytes: telemetry.protocolResponseBytes }),
    ...(telemetry.protocolToolName === undefined ? {} : { protocolToolName: telemetry.protocolToolName }),
    ...(telemetry.protocolArgumentIssue === undefined ? {} : { protocolArgumentIssue: telemetry.protocolArgumentIssue }),
    ...(telemetry.protocolMissingRequiredKeys === undefined ? {} : { protocolMissingRequiredKeys: telemetry.protocolMissingRequiredKeys }),
    ...(telemetry.protocolReceivedArgumentKeys === undefined ? {} : { protocolReceivedArgumentKeys: telemetry.protocolReceivedArgumentKeys }),
    ...(telemetry.protocolCompatibilityApplied === undefined ? {} : { protocolCompatibilityApplied: telemetry.protocolCompatibilityApplied }),
    eventCount: telemetry.eventCount,
    toolEventCount: telemetry.toolEventCount,
    permissionEventCount: telemetry.permissionEventCount,
    eventCategoryCounts: { ...telemetry.eventCategoryCounts },
  }
}

/** Build a whitelist-only record; prompt, stderr, env and executable are absent by design. */
export function buildAgyLogRecord(
  telemetry: AgyTelemetry,
  event: AgyLogEvent,
  errorCode?: string,
): AgyLogRecord {
  const process = telemetry.process
  const record: AgyLogRecord = {
    ...baseRecord(telemetry),
    event,
    ...(telemetry.queueWaitMs === undefined ? {} : { queueWaitMs: telemetry.queueWaitMs }),
    ...(telemetry.finalStatus === undefined ? {} : { finalStatus: telemetry.finalStatus }),
    ...(telemetry.usage === undefined ? {} : { usage: telemetry.usage }),
    ...(telemetry.usageSource === undefined ? {} : { usageSource: telemetry.usageSource }),
    ...(telemetry.cumulativeUsage === undefined ? {} : { cumulativeUsage: telemetry.cumulativeUsage }),
    ...(telemetry.cacheHit === undefined ? {} : { cacheHit: telemetry.cacheHit }),
    ...(telemetry.cacheTokenShare === undefined ? {} : { cacheTokenShare: telemetry.cacheTokenShare }),
    ...(telemetry.requestMode === undefined ? {} : { requestMode: telemetry.requestMode }),
    ...(telemetry.conversationReused === undefined ? {} : { conversationReused: telemetry.conversationReused }),
    ...(telemetry.stablePrefixBytes === undefined ? {} : { stablePrefixBytes: telemetry.stablePrefixBytes }),
    ...(telemetry.stablePrefixHash === undefined ? {} : { stablePrefixHash: telemetry.stablePrefixHash }),
    ...(telemetry.toolSchemaHash === undefined ? {} : { toolSchemaHash: telemetry.toolSchemaHash }),
    ...(telemetry.sessionId === undefined ? {} : { sessionFingerprint: fingerprint(telemetry.sessionId) }),
    ...(telemetry.conversationId === undefined ? {} : { conversationFingerprint: fingerprint(telemetry.conversationId) }),
    ...(telemetry.processDiagnostic === undefined ? {} : { processDiagnostic: telemetry.processDiagnostic }),
    ...(process === undefined ? {} : {
      exitCode: process.exitCode,
      termination: process.termination,
    }),
    ...(telemetry.durationMs === undefined && process === undefined
      ? {}
      : { durationMs: telemetry.durationMs ?? process?.durationMs ?? 0 }),
    ...(errorCode === undefined ? {} : { errorCode }),
  }
  return record
}

const PROCESS_DIAGNOSTIC_STAGES: readonly AgyProcessDiagnostic['stage'][] = [
  'prepare',
  'spawn',
  'stdin',
  'stdout-handler',
]

const TOOL_EVENT_CARRIER_SHAPES: readonly AgyToolEventCarrierShape[] = [
  'not-send-message',
  'missing-recipient',
  'missing-message',
  'unreadable-recipient',
  'unreadable-message',
  'complete',
]

const TOOL_EVENT_RECIPIENT_CLASSES: readonly AgyToolEventRecipientClass[] = [
  'not-applicable',
  'missing',
  'default-api',
  'dsh-recipient',
  'self-conversation',
  'other-conversation',
  'other',
]

const CARRIER_VALIDATIONS: readonly AgyCarrierValidation[] = [
  'recipient-rejected',
  'valid-message',
  'valid-tool-call',
  'invalid-envelope',
  'unknown-tool',
  'arguments-invalid',
  'response-limit',
]

const TOOL_EVENT_STRUCTURAL_KEYS = new Set([
  'event',
  'init',
  'step_update',
  'checkpoint',
  'agent_response',
  'result',
  'tool_call',
  'tool_result',
  'permission_request',
  'error_message',
  'error',
  'step_type',
  'tool_name',
  'tool_input',
  'state',
  'name',
  'recipient',
  'message',
  'arguments',
  'parameters',
  'input',
  'args',
])

function sanitizeStructuralKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const safe = value.filter((key): key is string => (
    typeof key === 'string' && TOOL_EVENT_STRUCTURAL_KEYS.has(key)
  ))
  return [...new Set(safe)].slice(0, 24)
}

function sanitizeToolEventDiagnostic(value: unknown): AgyToolEventDiagnostic | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Record<string, unknown>
  const kind = candidate.kind
  const carrierShape = candidate.carrierShape
  const recipientClass = candidate.recipientClass
  if (!isAgyToolEventKind(kind)
    || !TOOL_EVENT_CARRIER_SHAPES.includes(carrierShape as AgyToolEventCarrierShape)
    || !TOOL_EVENT_RECIPIENT_CLASSES.includes(recipientClass as AgyToolEventRecipientClass)) {
    return undefined
  }
  const safeText = (key: string): string | undefined => {
    const text = candidate[key]
    return typeof text === 'string' && text.length > 0 ? redactText(text, 128) : undefined
  }
  const eventName = safeText('eventName')
  if (eventName === undefined) return undefined
  const stepType = safeText('stepType')
  const toolName = safeText('toolName')
  return {
    eventName,
    kind,
    ...(stepType === undefined ? {} : { stepType }),
    ...(toolName === undefined ? {} : { toolName }),
    carrierShape: carrierShape as AgyToolEventCarrierShape,
    recipientClass: recipientClass as AgyToolEventRecipientClass,
    topLevelKeys: sanitizeStructuralKeys(candidate.topLevelKeys),
    stepKeys: sanitizeStructuralKeys(candidate.stepKeys),
    toolInputKeys: sanitizeStructuralKeys(candidate.toolInputKeys),
  }
}

function sanitizeProcessDiagnostic(value: unknown): AgyProcessDiagnostic | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Record<string, unknown>
  const stage = candidate.stage
  if (!PROCESS_DIAGNOSTIC_STAGES.includes(stage as AgyProcessDiagnostic['stage'])) return undefined
  const safeStage = stage as AgyProcessDiagnostic['stage']
  const safeNumber = (key: string): number | undefined => {
    const number = candidate[key]
    return typeof number === 'number' && Number.isSafeInteger(number) && number >= 0 ? number : undefined
  }
  const safeText = (key: string, maxLength: number): string | undefined => {
    const text = candidate[key]
    return typeof text === 'string' && text.length > 0 ? redactText(text, maxLength) : undefined
  }
  const lineHash = candidate.lineHash
  const errorName = safeText('errorName', 128)
  const errorCode = safeText('errorCode', 128)
  const lineNumber = safeNumber('lineNumber')
  const lineLength = safeNumber('lineLength')
  const stdoutLineCount = safeNumber('stdoutLineCount')
  const stdoutBytes = safeNumber('stdoutBytes')
  const stderrBytes = safeNumber('stderrBytes')
  return {
    stage: safeStage,
    ...(errorName === undefined ? {} : { errorName }),
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(lineNumber === undefined ? {} : { lineNumber }),
    ...(lineLength === undefined ? {} : { lineLength }),
    ...(typeof lineHash === 'string' && /^[0-9a-f]{16}$/i.test(lineHash)
      ? { lineHash: lineHash.toLowerCase() }
      : {}),
    ...(stdoutLineCount === undefined ? {} : { stdoutLineCount }),
    ...(stdoutBytes === undefined ? {} : { stdoutBytes }),
    ...(stderrBytes === undefined ? {} : { stderrBytes }),
  }
}

/** Apply a final whitelist-only safety pass before the host logger receives metadata. */
export function sanitizeAgyLogRecord(record: AgyLogRecord): AgyLogRecord {
  const safeUsage = sanitizeTokenUsage(record.usage)
  const safeCumulativeUsage = sanitizeTokenUsage(record.cumulativeUsage)
  const processDiagnostic = sanitizeProcessDiagnostic(record.processDiagnostic)
  const toolEventDiagnostic = sanitizeToolEventDiagnostic(record.toolEventDiagnostic)
  const protocolMissingRequiredKeys = safeProtocolKeyList(record.protocolMissingRequiredKeys)
  const protocolReceivedArgumentKeys = safeProtocolKeyList(record.protocolReceivedArgumentKeys)
  const sessionFingerprint = record.sessionFingerprint
    ?? (record.sessionId === undefined ? undefined : fingerprint(record.sessionId))
  const conversationFingerprint = record.conversationFingerprint
    ?? (record.conversationId === undefined ? undefined : fingerprint(record.conversationId))
  return {
    event: record.event,
    requestId: redactText(record.requestId, 256),
    provider: redactText(record.provider, 256),
    model: redactText(record.model, 256),
    agent: redactText(record.agent, 256),
    toolPolicy: record.toolPolicy === 'agy-owned'
      ? 'agy-owned'
      : record.toolPolicy === 'dsh-owned' ? 'dsh-owned' : 'reject',
    toolSchemaCount: record.toolSchemaCount,
    toolCallCount: safeNonNegativeNumber(record.toolCallCount),
    bridgeOutcome: isAgyBridgeOutcome(record.bridgeOutcome) ? record.bridgeOutcome : 'failed',
    ...(isAgyPermissionPreset(record.permissionPreset) ? { permissionPreset: record.permissionPreset } : {}),
    ...(isAgyPermissionPreset(record.sandboxMode) ? { sandboxMode: record.sandboxMode } : {}),
    ...(isAgyApprovalPolicy(record.approvalPolicy) ? { approvalPolicy: record.approvalPolicy } : {}),
    ...(isAgyReasoningEffort(record.reasoningEffort) ? { reasoningEffort: record.reasoningEffort } : {}),
    ...(record.purpose === 'compaction' || record.purpose === 'session-title' ? { purpose: record.purpose } : {}),
    ...(isModelDiscoveryLogSource(record.modelDiscoverySource)
      ? { modelDiscoverySource: record.modelDiscoverySource }
      : {}),
    ...(isModelDiscoveryErrorCode(record.modelDiscoveryWarningCode)
      ? { modelDiscoveryWarningCode: record.modelDiscoveryWarningCode }
      : {}),
    attempt: record.attempt,
    processAttemptCount: safeNonNegativeNumber(record.processAttemptCount ?? record.attempt),
    retryMaxRetries: safeNonNegativeNumber(record.retryMaxRetries ?? 0),
    ...(record.inputFrameBytes === undefined ? {} : { inputFrameBytes: safeNonNegativeNumber(record.inputFrameBytes) }),
    ...(record.inputFrameLimitBytes === undefined ? {} : { inputFrameLimitBytes: safeNonNegativeNumber(record.inputFrameLimitBytes) }),
    ...(record.promptBytes === undefined ? {} : { promptBytes: safeNonNegativeNumber(record.promptBytes) }),
    ...(record.promptLimitBytes === undefined ? {} : { promptLimitBytes: safeNonNegativeNumber(record.promptLimitBytes) }),
    ...(record.toolResultCount === undefined ? {} : { toolResultCount: safeNonNegativeNumber(record.toolResultCount) }),
    ...(record.largestToolResultBytes === undefined ? {} : { largestToolResultBytes: safeNonNegativeNumber(record.largestToolResultBytes) }),
    ...(record.truncatedToolResultCount === undefined ? {} : { truncatedToolResultCount: safeNonNegativeNumber(record.truncatedToolResultCount) }),
    ...(record.historyCompacted === true ? { historyCompacted: true } : {}),
    ...(record.omittedMessageCount === undefined ? {} : { omittedMessageCount: safeNonNegativeNumber(record.omittedMessageCount) }),
    ...(isAgyToolEventKind(record.toolEventKind) ? { toolEventKind: record.toolEventKind } : {}),
    ...(record.toolEventStreamIndex === undefined
      ? {}
      : { toolEventStreamIndex: safeNonNegativeNumber(record.toolEventStreamIndex) }),
    ...(toolEventDiagnostic === undefined ? {} : { toolEventDiagnostic }),
    ...(record.carrierAbortExpected === true ? { carrierAbortExpected: true } : {}),
    ...(CARRIER_VALIDATIONS.includes(record.carrierValidation as AgyCarrierValidation)
      ? { carrierValidation: record.carrierValidation as AgyCarrierValidation }
      : {}),
    protocolRepairAttempts: safeNonNegativeNumber(record.protocolRepairAttempts ?? 0),
    ...(record.protocolRepairReason === 'not-json'
      || record.protocolRepairReason === 'arguments-invalid'
      || record.protocolRepairReason === 'internal-tool-event'
      ? { protocolRepairReason: record.protocolRepairReason }
      : {}),
    ...(record.protocolFailureDetail === 'not-json'
      || record.protocolFailureDetail === 'envelope'
      || record.protocolFailureDetail === 'message-shape'
      || record.protocolFailureDetail === 'tool-call-shape'
      || record.protocolFailureDetail === 'response-limit'
      || record.protocolFailureDetail === 'validation'
      || record.protocolFailureDetail === 'unknown'
      ? { protocolFailureDetail: record.protocolFailureDetail }
      : {}),
    ...(record.protocolResponseShape === 'empty'
      || record.protocolResponseShape === 'object-like'
      || record.protocolResponseShape === 'array-like'
      || record.protocolResponseShape === 'fenced'
      || record.protocolResponseShape === 'plain-text'
      || record.protocolResponseShape === 'non-string'
      ? { protocolResponseShape: record.protocolResponseShape }
      : {}),
    ...(record.protocolResponseBytes === undefined
      ? {}
      : { protocolResponseBytes: safeNonNegativeNumber(record.protocolResponseBytes) }),
    ...(typeof record.protocolToolName === 'string'
      ? { protocolToolName: redactText(record.protocolToolName, 128) }
      : {}),
    ...(isAgyProtocolArgumentIssue(record.protocolArgumentIssue)
      ? { protocolArgumentIssue: record.protocolArgumentIssue }
      : {}),
    ...(protocolMissingRequiredKeys === undefined
      ? {}
      : { protocolMissingRequiredKeys }),
    ...(protocolReceivedArgumentKeys === undefined
      ? {}
      : { protocolReceivedArgumentKeys }),
    ...(isToolProtocolCompatibility(record.protocolCompatibilityApplied)
      ? { protocolCompatibilityApplied: record.protocolCompatibilityApplied }
      : {}),
    eventCount: record.eventCount,
    toolEventCount: record.toolEventCount,
    permissionEventCount: record.permissionEventCount,
    eventCategoryCounts: {
      init: record.eventCategoryCounts.init,
      step_update: record.eventCategoryCounts.step_update,
      checkpoint: record.eventCategoryCounts.checkpoint,
      agent_response: record.eventCategoryCounts.agent_response,
      result: record.eventCategoryCounts.result,
      tool: record.eventCategoryCounts.tool,
      permission: record.eventCategoryCounts.permission,
      error: record.eventCategoryCounts.error,
      unknown: record.eventCategoryCounts.unknown,
    },
    ...(record.durationMs === undefined ? {} : { durationMs: record.durationMs }),
    ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
    ...(record.termination === undefined ? {} : { termination: record.termination }),
    ...(record.queueWaitMs === undefined ? {} : { queueWaitMs: record.queueWaitMs }),
    ...(safeUsage === undefined ? {} : { usage: safeUsage }),
    ...(processDiagnostic === undefined ? {} : { processDiagnostic }),
    ...(record.errorCode === undefined ? {} : { errorCode: redactText(record.errorCode, 128) }),
    ...(record.finalStatus === undefined ? {} : { finalStatus: redactText(record.finalStatus, 128) }),
    ...(record.usageSource === 'step' || record.usageSource === 'result-fallback'
      ? { usageSource: record.usageSource }
      : {}),
    ...(safeCumulativeUsage === undefined ? {} : { cumulativeUsage: safeCumulativeUsage }),
    ...(record.cacheHit === undefined ? {} : { cacheHit: record.cacheHit === true }),
    ...(record.cacheTokenShare === undefined
      ? {}
      : { cacheTokenShare: Math.min(1, Math.max(0, safeNonNegativeNumber(record.cacheTokenShare))) }),
    ...(record.requestMode === 'full'
      || record.requestMode === 'bootstrap'
      || record.requestMode === 'delta'
      || record.requestMode === 'full-fallback'
      ? { requestMode: record.requestMode }
      : {}),
    ...(record.conversationReused === undefined ? {} : { conversationReused: record.conversationReused === true }),
    ...(record.stablePrefixBytes === undefined
      ? {}
      : { stablePrefixBytes: safeNonNegativeNumber(record.stablePrefixBytes) }),
    ...(typeof record.stablePrefixHash === 'string' && /^[0-9a-f]{16,64}$/i.test(record.stablePrefixHash)
      ? { stablePrefixHash: record.stablePrefixHash.toLowerCase() }
      : {}),
    ...(typeof record.toolSchemaHash === 'string' && /^[0-9a-f]{16,64}$/i.test(record.toolSchemaHash)
      ? { toolSchemaHash: record.toolSchemaHash.toLowerCase() }
      : {}),
    ...(sessionFingerprint === undefined ? {} : { sessionFingerprint: redactText(sessionFingerprint, 64) }),
    ...(conversationFingerprint === undefined ? {} : { conversationFingerprint: redactText(conversationFingerprint, 64) }),
  }
}

function sanitizeTokenUsage(usage: TokenUsage | undefined): TokenUsage | undefined {
  if (usage === undefined) return undefined
  return {
    inputTokens: safeNonNegativeNumber(usage.inputTokens),
    outputTokens: safeNonNegativeNumber(usage.outputTokens),
    ...(usage.cacheReadTokens === undefined
      ? {}
      : { cacheReadTokens: safeNonNegativeNumber(usage.cacheReadTokens) }),
    ...(usage.cacheWriteTokens === undefined
      ? {}
      : { cacheWriteTokens: safeNonNegativeNumber(usage.cacheWriteTokens) }),
    ...(usage.reasoningTokens === undefined
      ? {}
      : { reasoningTokens: safeNonNegativeNumber(usage.reasoningTokens) }),
  }
}

function safeNonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

export function emitAgyLog(logger: AgyLogger | undefined, record: AgyLogRecord): void {
  if (logger === undefined) return
  try {
    logger(sanitizeAgyLogRecord(record))
  } catch {
    // Observability must never break a model request.
  }
}
