import type { ProcessResult, ProcessTermination } from './process.js'
import { redactText } from './redact.js'
import type { AgyEventCategoryCounts } from './parser.js'

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

/** Apply a final safety pass before the host logger receives metadata. */
export function sanitizeAgyLogRecord(record: AgyLogRecord): AgyLogRecord {
  return {
    ...record,
    provider: redactText(record.provider, 256),
    model: redactText(record.model, 256),
    agent: redactText(record.agent, 256),
    ...(record.sessionId === undefined ? {} : { sessionId: redactText(record.sessionId, 256) }),
    ...(record.conversationId === undefined ? {} : { conversationId: redactText(record.conversationId, 256) }),
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
