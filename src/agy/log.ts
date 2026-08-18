import { isAgyReasoningEffort, type AgyReasoningEffort, type ProcessResult, type ProcessTermination } from './process.js'
import { redactText } from './redact.js'
import type { AgyEventCategoryCounts } from './parser.js'
import type { ToolPolicy } from '../provider/config.js'
import {
  isModelDiscoveryErrorCode,
  type ModelDiscoveryErrorCode,
} from '../provider/error-codes.js'
import type { ModelDiscoverySource } from './models.js'

export type AgyModelDiscoveryLogSource = 'static' | ModelDiscoverySource

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
  reasoningEffort?: AgyReasoningEffort
  modelDiscoverySource?: AgyModelDiscoveryLogSource
  modelDiscoveryWarningCode?: ModelDiscoveryErrorCode
  attempt: number
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
  errorCode?: string
}

export type AgyLogger = (record: Readonly<AgyLogRecord>) => void

/** Mutable request counters kept separate from the public log shape. */
export interface AgyTelemetry {
  readonly requestId: string
  readonly provider: string
  readonly model: string
  readonly agent: string
  readonly toolPolicy: ToolPolicy
  readonly toolSchemaCount: number
  readonly reasoningEffort?: AgyReasoningEffort
  readonly modelDiscoverySource?: AgyModelDiscoveryLogSource
  readonly modelDiscoveryWarningCode?: ModelDiscoveryErrorCode
  readonly sessionId: string | undefined
  readonly startedAt: number
  durationMs: number | undefined
  attempt: number
  eventCount: number
  toolEventCount: number
  permissionEventCount: number
  eventCategoryCounts: AgyEventCategoryCounts
  finalStatus: string | undefined
  conversationId: string | undefined
  queueWaitMs: number | undefined
  process: ProcessResult | undefined
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
    ...(telemetry.reasoningEffort === undefined ? {} : { reasoningEffort: telemetry.reasoningEffort }),
    ...(telemetry.modelDiscoverySource === undefined ? {} : { modelDiscoverySource: telemetry.modelDiscoverySource }),
    ...(telemetry.modelDiscoveryWarningCode === undefined ? {} : { modelDiscoveryWarningCode: telemetry.modelDiscoveryWarningCode }),
    attempt: telemetry.attempt,
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
    ...(telemetry.sessionId === undefined ? {} : { sessionId: telemetry.sessionId }),
    ...(telemetry.conversationId === undefined ? {} : { conversationId: telemetry.conversationId }),
    ...(telemetry.queueWaitMs === undefined ? {} : { queueWaitMs: telemetry.queueWaitMs }),
    ...(telemetry.finalStatus === undefined ? {} : { finalStatus: telemetry.finalStatus }),
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

/** Apply a final whitelist-only safety pass before the host logger receives metadata. */
export function sanitizeAgyLogRecord(record: AgyLogRecord): AgyLogRecord {
  return {
    event: record.event,
    requestId: redactText(record.requestId, 256),
    provider: redactText(record.provider, 256),
    model: redactText(record.model, 256),
    agent: redactText(record.agent, 256),
    toolPolicy: record.toolPolicy === 'agy-owned' ? 'agy-owned' : 'reject',
    toolSchemaCount: record.toolSchemaCount,
    ...(isAgyReasoningEffort(record.reasoningEffort) ? { reasoningEffort: record.reasoningEffort } : {}),
    ...(isModelDiscoveryLogSource(record.modelDiscoverySource)
      ? { modelDiscoverySource: record.modelDiscoverySource }
      : {}),
    ...(isModelDiscoveryErrorCode(record.modelDiscoveryWarningCode)
      ? { modelDiscoveryWarningCode: record.modelDiscoveryWarningCode }
      : {}),
    attempt: record.attempt,
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
    ...(record.sessionId === undefined ? {} : { sessionId: redactText(record.sessionId, 256) }),
    ...(record.conversationId === undefined ? {} : { conversationId: redactText(record.conversationId, 256) }),
    ...(record.durationMs === undefined ? {} : { durationMs: record.durationMs }),
    ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
    ...(record.termination === undefined ? {} : { termination: record.termination }),
    ...(record.queueWaitMs === undefined ? {} : { queueWaitMs: record.queueWaitMs }),
    ...(record.errorCode === undefined ? {} : { errorCode: redactText(record.errorCode, 128) }),
    ...(record.finalStatus === undefined ? {} : { finalStatus: redactText(record.finalStatus, 128) }),
  }
}

export function emitAgyLog(logger: AgyLogger | undefined, record: AgyLogRecord): void {
  if (logger === undefined) return
  try {
    logger(sanitizeAgyLogRecord(record))
  } catch {
    // Observability must never break a model request.
  }
}
