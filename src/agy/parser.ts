export interface AgyJsonEvent {
  event: string
  [key: string]: unknown
}

export type AgyParserErrorCode = 'INVALID_JSON_LINE' | 'INVALID_EVENT'

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse one complete NDJSON line and require only the stable event envelope. */
export function parseAgyJsonLine(rawLine: string, lineNumber = 1): AgyJsonEvent {
  let value: unknown
  try {
    value = JSON.parse(rawLine)
  } catch (error) {
    throw new AgyParserError(
      `Invalid AGY JSON at line ${lineNumber}`,
      'INVALID_JSON_LINE',
      lineNumber,
      rawLine,
      { cause: error },
    )
  }
  if (!isRecord(value) || typeof value.event !== 'string' || value.event.length === 0) {
    throw new AgyParserError(
      `AGY event at line ${lineNumber} must be an object with a non-empty event field`,
      'INVALID_EVENT',
      lineNumber,
      rawLine,
    )
  }
  return value as AgyJsonEvent
}

/** Incremental parser for arbitrary stdout chunks, including CRLF streams. */
export class AgyStreamParser {
  private buffer = ''
  private lineNumber = 0

  push(chunk: string): AgyJsonEvent[] {
    this.buffer += chunk
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

/** Extract the advisory tool name from a step update, when present. */
export function toolNameOf(event: AgyJsonEvent): string | undefined {
  const update = stepUpdateOf(event)
  if (typeof update?.tool_name === 'string') return update.tool_name
  return typeof update?.name === 'string' ? update.name : undefined
}

/** Recognize internal AGY tool lifecycle events without mapping them to DSH tools. */
export function isToolEvent(event: AgyJsonEvent): boolean {
  const stepType = stepTypeOf(event)
  return event.event === 'tool_call'
    || event.event === 'tool_result'
    || stepType === 'tool'
    || toolNameOf(event) !== undefined
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
