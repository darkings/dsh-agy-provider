/**
 * Small, transport-neutral helpers for AGY's stdin stream-json mode.
 *
 * Real AGY 1.1.15 stream-json input is event-driven. Factual envelope sampled
 * in V8-M1 (see findings.md 2026-08-20, .tmp/v8-m1/three-turn.log):
 *   input:  {"event":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}} per NDJSON line
 *   output: {"event":"init","conversation_id":"...","init":{...}} then
 *           {"event":"step_update",...} then {"event":"result",...} per turn.
 * The generic encodeAgyStreamInput is retained for forward compatibility, but
 * callers should use the typed encodeAgyUserMessage helper.
 */

export type AgyProtocolValue = Record<string, unknown> | readonly unknown[] | string | number | boolean | null

export class AgyStreamProtocolError extends Error {
  constructor(
    message: string,
    readonly code: 'INVALID_INPUT' | 'FRAME_TOO_LARGE' | 'INVALID_OUTPUT',
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'AgyStreamProtocolError'
  }
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

/** Typed input for AGY 1.1.15 stream-json: one user turn per NDJSON line. */
export interface AgyStreamUserMessage {
  readonly event: "user";
  readonly message: {
    readonly role: "user";
    readonly content: readonly { readonly type: "text"; readonly text: string }[];
  };
}

/** Encode one stdin NDJSON message without invoking a shell. */
export function encodeAgyStreamInput(message: unknown, maxFrameBytes = 256 * 1024): string {
  if (message === undefined || typeof message === 'function' || typeof message === 'symbol') {
    throw new AgyStreamProtocolError(
      'AGY stream-json input must be JSON serializable',
      'INVALID_INPUT',
    )
  }
  let line: string
  try {
    line = JSON.stringify(message)
  } catch (error) {
    throw new AgyStreamProtocolError(
      'AGY stream-json input could not be encoded',
      'INVALID_INPUT',
      { cause: error },
    )
  }
  const encoded = `${line}\n`
  if (byteLength(encoded) > maxFrameBytes) {
    throw new AgyStreamProtocolError(
      'AGY stream-json input exceeds the configured frame limit',
      'FRAME_TOO_LARGE',
    )
  }
  return encoded
}

/** Encode one AGY stream-json user turn with the factual V8-M1 envelope. */
export function encodeAgyUserMessage(text: string, maxFrameBytes = 256 * 1024): string {
  if (typeof text !== "string" || text.length === 0) {
    throw new AgyStreamProtocolError("AGY stream-json user text must be a non-empty string", "INVALID_INPUT");
  }
  const payload: AgyStreamUserMessage = {
    event: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  };
  return encodeAgyStreamInput(payload, maxFrameBytes);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeEnumKey(key: string): boolean {
  return key === 'event'
    || key === 'status'
    || key === 'subtype'
    || key === 'step_type'
    || key === 'state'
    || key === 'kind'
    || key === 'type'
    || key === 'role'
}

function safeEnum(value: string): string {
  return /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : '<enum>'
}

/**
 * Replace all free-form strings and identifiers while retaining enough
 * structure to replay parser behavior. Stable protocol enum fields remain.
 */
export function sanitizeAgyProtocolValue(value: unknown, key = '', depth = 0): unknown {
  if (depth > 8) return '<depth-limit>'
  if (typeof value === 'string') {
    if (safeEnumKey(key)) return safeEnum(value)
    return `<string:${value.length}>`
  }
  if (typeof value === 'number') return key.toLowerCase().includes('usage') ? 0 : 0
  if (typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) return value.slice(0, 32).map(item => sanitizeAgyProtocolValue(item, '', depth + 1))
  if (isRecord(value)) {
    const entries = Object.entries(value).slice(0, 128)
    return Object.fromEntries(entries.map(([entryKey, entryValue]) => [
      entryKey,
      sanitizeAgyProtocolValue(entryValue, entryKey, depth + 1),
    ]))
  }
  return '<unsupported>'
}

function collectShape(
  value: unknown,
  path: string,
  paths: Set<string>,
  kinds: Set<string>,
  stringLengths: Record<string, number>,
  depth = 0,
): void {
  if (depth > 8 || paths.size >= 256) return
  if (value === null) {
    kinds.add('null')
    paths.add(path || '$')
    return
  }
  if (Array.isArray(value)) {
    kinds.add('array')
    paths.add(`${path || '$'}[]`)
    for (const item of value.slice(0, 16)) collectShape(item, `${path || '$'}[]`, paths, kinds, stringLengths, depth + 1)
    return
  }
  if (typeof value === 'object') {
    kinds.add('object')
    for (const [key, nested] of Object.entries(value).slice(0, 128)) {
      const nestedPath = path ? `${path}.${key}` : key
      paths.add(nestedPath)
      collectShape(nested, nestedPath, paths, kinds, stringLengths, depth + 1)
    }
    return
  }
  kinds.add(typeof value)
  paths.add(path || '$')
  if (typeof value === 'string') stringLengths[path || '$'] = value.length
}

export interface AgyProtocolRecordSummary {
  readonly topLevelKeys: readonly string[]
  readonly event: string | null
  readonly shapePaths: readonly string[]
  readonly valueKinds: readonly string[]
  readonly stringLengths: Readonly<Record<string, number>>
}

/** Summarize one decoded output record without returning its payload. */
export function summarizeAgyProtocolValue(value: unknown): AgyProtocolRecordSummary {
  const paths = new Set<string>()
  const kinds = new Set<string>()
  const stringLengths: Record<string, number> = {}
  collectShape(value, '', paths, kinds, stringLengths)
  const event = isRecord(value) && typeof value.event === 'string'
    ? safeEnum(value.event)
    : null
  return {
    topLevelKeys: isRecord(value) ? Object.keys(value).sort() : [],
    event,
    shapePaths: [...paths].sort(),
    valueKinds: [...kinds].sort(),
    stringLengths: Object.freeze({ ...stringLengths }),
  }
}

/** Convert one decoded output record into a safe fixture value. */
export function sanitizeAgyProtocolRecord(value: unknown): unknown {
  return sanitizeAgyProtocolValue(value)
}
