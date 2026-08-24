export interface AgyJsonEvent {
  event: string
  [key: string]: unknown
}

export type AgyParserErrorCode = 'INVALID_JSON_LINE' | 'INVALID_EVENT' | 'LINE_TOO_LONG'

export const DEFAULT_MAX_LINE_LENGTH = 1_048_576

export interface AgyParserOptions {
  /** Maximum UTF-16 code units accepted for one NDJSON line. */
  maxLineLength?: number
}

export class AgyParserError extends Error {
  constructor(
    message: string,
    readonly code: AgyParserErrorCode,
    readonly lineNumber: number,
    readonly rawLine: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'AgyParserError'
  }
}

export type AgyEventCategory =
  | 'init'
  | 'step_update'
  | 'checkpoint'
  | 'agent_response'
  | 'result'
  | 'tool'
  | 'permission'
  | 'error'
  | 'unknown'

export type AgyEventCategoryCounts = Record<AgyEventCategory, number>

export type AgyToolEventKind =
  | 'event-tool-call'
  | 'event-tool-result'
  | 'step-type-tool'
  | 'explicit-tool-name'

export type AgyToolEventCarrierShape =
  | 'not-send-message'
  | 'missing-recipient'
  | 'missing-message'
  | 'unreadable-recipient'
  | 'unreadable-message'
  | 'complete'

export type AgyToolEventRecipientClass =
  | 'not-applicable'
  | 'missing'
  | 'default-api'
  | 'dsh-recipient'
  | 'self-conversation'
  | 'other-conversation'
  | 'other'

/** Safe structural metadata for diagnosing AGY tool events without logging payload values. */
export interface AgyToolEventDiagnostic {
  readonly eventName: string
  readonly kind: AgyToolEventKind
  readonly stepType?: string
  readonly toolName?: string
  readonly carrierShape: AgyToolEventCarrierShape
  readonly recipientClass: AgyToolEventRecipientClass
  readonly topLevelKeys: readonly string[]
  readonly stepKeys: readonly string[]
  readonly toolInputKeys: readonly string[]
}

const AGY_TOOL_EVENT_KINDS: readonly AgyToolEventKind[] = [
  'event-tool-call',
  'event-tool-result',
  'step-type-tool',
  'explicit-tool-name',
]

/**
 * Stable AGY orchestration recipients used to carry a DSH-owned tool call.
 * Keep this exact-name allowlist narrow; arbitrary recipients remain rejected.
 */
const DSH_CARRIER_RECIPIENTS = ['dsh', 'dsh-session', 'dsh-runner'] as const

export function isDshCarrierRecipient(value: string): boolean {
  return DSH_CARRIER_RECIPIENTS.includes(value as typeof DSH_CARRIER_RECIPIENTS[number])
}

export function isAgyToolEventKind(value: unknown): value is AgyToolEventKind {
  return typeof value === 'string'
    && AGY_TOOL_EVENT_KINDS.includes(value as AgyToolEventKind)
}

export function emptyAgyEventCategoryCounts(): AgyEventCategoryCounts {
  return {
    init: 0,
    step_update: 0,
    checkpoint: 0,
    agent_response: 0,
    result: 0,
    tool: 0,
    permission: 0,
    error: 0,
    unknown: 0,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function diagnosticLine(value: string): string {
  return value.length <= 4_096 ? value : `${value.slice(0, 4_096)}…`
}

/** Parse one complete NDJSON line and require only the stable event envelope. */
export function parseAgyJsonLine(rawLine: string, lineNumber = 1): AgyJsonEvent {
  if (rawLine.length > DEFAULT_MAX_LINE_LENGTH) {
    throw new AgyParserError(
      `AGY event line ${lineNumber} exceeds the maximum length`,
      'LINE_TOO_LONG',
      lineNumber,
      diagnosticLine(rawLine),
    )
  }
  let value: unknown
  try {
    value = JSON.parse(rawLine)
  } catch (error) {
    throw new AgyParserError(
      `Invalid AGY JSON at line ${lineNumber}`,
      'INVALID_JSON_LINE',
      lineNumber,
      diagnosticLine(rawLine),
      { cause: error },
    )
  }
  if (!isRecord(value) || typeof value.event !== 'string' || value.event.length === 0) {
    throw new AgyParserError(
      `AGY event at line ${lineNumber} must be an object with a non-empty event field`,
      'INVALID_EVENT',
      lineNumber,
      diagnosticLine(rawLine),
    )
  }
  return value as AgyJsonEvent
}

/** Incremental parser for arbitrary stdout chunks, including CRLF streams. */
export class AgyStreamParser {
  private buffer = ''
  private lineNumber = 0
  private readonly maxLineLength: number

  constructor(options: AgyParserOptions = {}) {
    this.maxLineLength = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH
    if (!Number.isSafeInteger(this.maxLineLength) || this.maxLineLength < 1) {
      throw new RangeError('maxLineLength must be a positive safe integer')
    }
  }

  push(chunk: string): AgyJsonEvent[] {
    this.buffer += chunk
    if (this.buffer.length > this.maxLineLength && !this.buffer.includes('\n')) {
      this.lineNumber += 1
      const rawLine = diagnosticLine(this.buffer)
      this.buffer = ''
      throw new AgyParserError(
        `AGY event line ${this.lineNumber} exceeds the maximum length`,
        'LINE_TOO_LONG',
        this.lineNumber,
        rawLine,
      )
    }
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''
    return lines.flatMap(line => this.parseLine(line.replace(/\r$/, '')))
  }

  end(): AgyJsonEvent[] {
    if (this.buffer.length === 0) return []
    const line = this.buffer.replace(/\r$/, '')
    this.buffer = ''
    return this.parseLine(line)
  }

  private parseLine(line: string): AgyJsonEvent[] {
    this.lineNumber += 1
    if (line.length > this.maxLineLength) {
      throw new AgyParserError(
        `AGY event line ${this.lineNumber} exceeds the maximum length`,
        'LINE_TOO_LONG',
        this.lineNumber,
        diagnosticLine(line),
      )
    }
    if (line.trim().length === 0) return []
    return [parseAgyJsonLine(line, this.lineNumber)]
  }
}

/** Parse an async sequence of stdout chunks without buffering the full stream. */
export async function* parseAgyChunks(
  chunks: AsyncIterable<string>,
): AsyncIterable<AgyJsonEvent> {
  const parser = new AgyStreamParser()
  for await (const chunk of chunks) {
    yield* parser.push(chunk)
  }
  yield* parser.end()
}

function nestedRecord(event: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = event[key]
  return isRecord(value) ? value : undefined
}

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '')
}

const STRUCTURAL_KEY_NAMES = new Map<string, string>([
  ['event', 'event'],
  ['init', 'init'],
  ['stepupdate', 'step_update'],
  ['checkpoint', 'checkpoint'],
  ['agentresponse', 'agent_response'],
  ['result', 'result'],
  ['toolcall', 'tool_call'],
  ['toolresult', 'tool_result'],
  ['permissionrequest', 'permission_request'],
  ['errormessage', 'error_message'],
  ['error', 'error'],
  ['steptype', 'step_type'],
  ['toolname', 'tool_name'],
  ['toolinput', 'tool_input'],
  ['state', 'state'],
  ['name', 'name'],
  ['recipient', 'recipient'],
  ['message', 'message'],
  ['arguments', 'arguments'],
  ['parameters', 'parameters'],
  ['input', 'input'],
  ['args', 'args'],
])

function structuralKeys(value: unknown): string[] {
  if (!isRecord(value)) return []
  const keys = new Set<string>()
  for (const key of Object.keys(value)) {
    const canonical = STRUCTURAL_KEY_NAMES.get(normalizedKey(key))
    if (canonical !== undefined) keys.add(canonical)
  }
  return [...keys].sort()
}

function valueForKey(value: unknown, key: string): unknown {
  if (!isRecord(value)) return undefined
  const target = normalizedKey(key)
  for (const [candidate, child] of Object.entries(value)) {
    if (normalizedKey(candidate) === target) return child
  }
  return undefined
}

function decodeRecord(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return undefined
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Extract the AGY conversation identity emitted by an init event. */
export function conversationIdOf(event: AgyJsonEvent): string | undefined {
  if (event.event !== 'init') return undefined
  if (typeof event.conversation_id === 'string' && event.conversation_id.length > 0) {
    return event.conversation_id
  }
  const init = nestedRecord(event, 'init')
  return typeof init?.conversation_id === 'string' && init.conversation_id.length > 0
    ? init.conversation_id
    : undefined
}

function stepUpdateOf(event: AgyJsonEvent): Record<string, unknown> | undefined {
  return event.event === 'step_update' ? nestedRecord(event, 'step_update') : undefined
}

/** Return AGY's step type without constraining future event payloads. */
export function stepTypeOf(event: AgyJsonEvent): string | undefined {
  const update = stepUpdateOf(event)
  return typeof update?.step_type === 'string' ? update.step_type : undefined
}

/** Extract an explicit AGY tool name from a step update, when present. */
export function toolNameOf(event: AgyJsonEvent): string | undefined {
  const update = stepUpdateOf(event)
  if (typeof update?.tool_name === 'string') return update.tool_name
  if (typeof event.tool_name === 'string') return event.tool_name
  for (const key of ['tool_call', 'tool_result']) {
    const nested = nestedRecord(event, key)
    if (typeof nested?.tool_name === 'string') return nested.tool_name
  }
  return undefined
}

export interface AgySendMessagePayload {
  readonly recipient: string
  readonly message: string
}

function decodeNestedString(value: string): string {
  let current = value.trim()
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!(current.startsWith('"') && current.endsWith('"'))) break
    try {
      const decoded: unknown = JSON.parse(current)
      if (typeof decoded !== 'string') break
      current = decoded.trim()
    } catch {
      break
    }
  }
  return current
}

function findEncodedFieldCandidates(
  value: unknown,
  field: string,
  candidates: string[] = [],
  depth = 0,
): string[] {
  if (depth > 8 || value === null || typeof value !== 'object') return candidates
  if (Array.isArray(value)) {
    for (const child of value) findEncodedFieldCandidates(child, field, candidates, depth + 1)
    return candidates
  }
  for (const [key, child] of Object.entries(value)) {
    if (normalizedKey(key) === normalizedKey(field) && typeof child === 'string') {
      candidates.push(decodeNestedString(child))
    }
    findEncodedFieldCandidates(child, field, candidates, depth + 1)
  }
  return candidates
}

/**
 * Return one unambiguous encoded field. AGY may wrap tool arguments in several
 * layers; equal duplicates are harmless, but conflicting values must not be
 * resolved by whichever branch happens to be visited first.
 */
function findEncodedField(value: unknown, field: string): string | undefined {
  const candidates = [...new Set(findEncodedFieldCandidates(value, field))]
  return candidates.length === 1 ? candidates[0] : undefined
}

function hasField(value: unknown, field: string, depth = 0): boolean {
  if (depth > 8 || value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(child => hasField(child, field, depth + 1))
  const target = normalizedKey(field)
  for (const [key, child] of Object.entries(value)) {
    if (normalizedKey(key) === target) return true
    if (hasField(child, field, depth + 1)) return true
  }
  return false
}

/** Extract the narrowly-scoped AGY send_message carrier used by DSH-owned mode. */
export function sendMessageOf(event: AgyJsonEvent): AgySendMessagePayload | undefined {
  if (toolNameOf(event) !== 'send_message') return undefined
  const recipient = findEncodedField(event, 'recipient')
  const message = findEncodedField(event, 'message')
  if (recipient === undefined || message === undefined) return undefined
  return { recipient, message }
}

function stepNameOf(event: AgyJsonEvent): string | undefined {
  const update = stepUpdateOf(event)
  return typeof update?.name === 'string' ? update.name : undefined
}

/** Classify only explicit AGY tool lifecycle signals. */
export function toolEventKindOf(event: AgyJsonEvent): AgyToolEventKind | undefined {
  if (event.event === 'tool_call') return 'event-tool-call'
  if (event.event === 'tool_result') return 'event-tool-result'
  if (stepTypeOf(event) === 'tool') return 'step-type-tool'
  if (toolNameOf(event) !== undefined) return 'explicit-tool-name'
  return undefined
}

/** Recognize internal AGY tool lifecycle events without mapping them to DSH tools. */
export function isToolEvent(event: AgyJsonEvent): boolean {
  return toolEventKindOf(event) !== undefined
}

/** Classify a tool event's carrier shape without retaining any payload values. */
export function toolEventDiagnosticOf(
  event: AgyJsonEvent,
  activeConversationId?: string,
): AgyToolEventDiagnostic | undefined {
  const kind = toolEventKindOf(event)
  if (kind === undefined) return undefined

  const step = stepUpdateOf(event)
  const stepType = stepTypeOf(event)
  const toolName = toolNameOf(event)
  const isSendMessage = toolName === 'send_message'
  const hasRecipient = isSendMessage && hasField(event, 'recipient')
  const hasMessage = isSendMessage && hasField(event, 'message')
  const recipient = isSendMessage ? findEncodedField(event, 'recipient') : undefined
  const message = isSendMessage ? findEncodedField(event, 'message') : undefined

  let carrierShape: AgyToolEventCarrierShape = 'not-send-message'
  if (isSendMessage) {
    if (!hasRecipient) carrierShape = 'missing-recipient'
    else if (!hasMessage) carrierShape = 'missing-message'
    else if (recipient === undefined) carrierShape = 'unreadable-recipient'
    else if (message === undefined) carrierShape = 'unreadable-message'
    else carrierShape = 'complete'
  }

  const recipientClass: AgyToolEventRecipientClass = !isSendMessage
    ? 'not-applicable'
    : recipient === undefined
      ? 'missing'
      : recipient === 'default_api'
        ? 'default-api'
        : isDshCarrierRecipient(recipient)
          ? 'dsh-recipient'
        : activeConversationId !== undefined && recipient === activeConversationId
          ? 'self-conversation'
          : activeConversationId !== undefined
            ? 'other-conversation'
            : 'other'

  const toolInput = decodeRecord(valueForKey(step, 'tool_input'))
    ?? decodeRecord(valueForKey(event, 'tool_input'))
    ?? decodeRecord(valueForKey(event, 'arguments'))
    ?? decodeRecord(valueForKey(event, 'input'))

  return {
    eventName: event.event,
    kind,
    ...(stepType === undefined ? {} : { stepType }),
    ...(toolName === undefined ? {} : { toolName }),
    carrierShape,
    recipientClass,
    topLevelKeys: structuralKeys(event),
    stepKeys: structuralKeys(step),
    toolInputKeys: structuralKeys(toolInput),
  }
}

/** Recognize permission checkpoints that cannot be answered by a headless Provider. */
export function isPermissionEvent(event: AgyJsonEvent): boolean {
  const stepType = stepTypeOf(event)
  return event.event === 'permission_request'
    || event.event === 'ask_permission'
    || stepType === 'permission'
    || stepType === 'permission_request'
    || stepType === 'ask_permission'
    || toolNameOf(event) === 'ask_permission'
    || stepNameOf(event) === 'ask_permission'
}

/** Classify only stable event categories; unknown event names remain forward-compatible. */
export function eventCategoryOf(event: AgyJsonEvent): AgyEventCategory {
  if (isPermissionEvent(event)) return 'permission'
  if (isToolEvent(event)) return 'tool'
  switch (event.event) {
    case 'init':
      return 'init'
    case 'step_update':
      return 'step_update'
    case 'checkpoint':
      return 'checkpoint'
    case 'agent_response':
      return 'agent_response'
    case 'result':
      return 'result'
    case 'error':
    case 'error_message':
      return 'error'
    default:
      return 'unknown'
  }
}

/** Extract bounded classification detail from AGY error events without exposing the payload. */
export function errorDetailOf(event: AgyJsonEvent): string | undefined {
  if (event.event !== 'error' && event.event !== 'error_message') return undefined
  const values: string[] = []
  const direct = event[event.event]
  if (typeof direct === 'string' && direct.trim().length > 0) values.push(direct.trim())
  const containers: Array<Record<string, unknown>> = [event]
  if (isRecord(direct)) containers.push(direct)
  const error = nestedRecord(event, 'error')
  if (error !== undefined) containers.push(error)
  const errorMessage = nestedRecord(event, 'error_message')
  if (errorMessage !== undefined) containers.push(errorMessage)
  for (const container of containers) {
    for (const key of ['code', 'type', 'message', 'detail', 'reason', 'text', 'error']) {
      const value = container[key]
      if (typeof value === 'string' && value.trim().length > 0) values.push(value.trim())
    }
  }
  const unique = [...new Set(values)]
  return unique.length === 0 ? undefined : unique.join(' ').slice(0, 2_048)
}

/** Extract a text delta from the observed AGY step_update envelope. */
export function textDeltaOf(event: AgyJsonEvent): string | undefined {
  if (event.event !== 'step_update') return undefined
  const update = nestedRecord(event, 'step_update')
  return typeof update?.text_delta === 'string' ? update.text_delta : undefined
}

/** Extract the final response text from a result event. */
export function responseOf(event: AgyJsonEvent): string | undefined {
  if (event.event !== 'result') return undefined
  const result = nestedRecord(event, 'result')
  return typeof result?.response === 'string' ? result.response : undefined
}

/** Extract the final AGY result status without constraining future statuses. */
export function statusOf(event: AgyJsonEvent): string | undefined {
  if (event.event !== 'result') return undefined
  const result = nestedRecord(event, 'result')
  return typeof result?.status === 'string' ? result.status : undefined
}

/** Extract usage as an opaque object; AGY may add fields across versions. */
export function usageOf(event: AgyJsonEvent): Record<string, unknown> | undefined {
  const container = event.event === 'result'
    ? nestedRecord(event, 'result')
    : event.event === 'step_update'
      ? nestedRecord(event, 'step_update')
      : undefined
  return nestedRecord(container ?? {}, 'usage')
}
