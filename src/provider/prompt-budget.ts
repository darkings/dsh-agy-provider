import { getAgyUserMessageByteLength } from '../agy/stream-protocol.js'

export const DEFAULT_INPUT_FRAME_LIMIT_BYTES = 256 * 1024
// AGY's text input is practically truncated below the stream frame limit.
// Keep a margin below the observed ~192 KiB cutoff so the current turn and
// the DSH protocol cannot disappear from the tail of AGY's input.
export const DEFAULT_AGY_PROMPT_CONTENT_LIMIT_BYTES = 180 * 1024
// AGY 1.1.18's DSH-owned structured envelope has an additional effective
// ceiling from the injected Agent/system contract. In real Desktop requests,
// prompts around 61 KiB still exit without a usable structured response even
// though the stream frame is valid; 56 KiB is the largest tested safe band.
// Keep a lower tool-mode bound so the Provider fails closed with
// AGY_INPUT_TOO_LARGE instead of surfacing AGY_EXIT/not-JSON.
export const DEFAULT_DSH_TOOL_PROMPT_CONTENT_LIMIT_BYTES = 56 * 1024
export const DEFAULT_MAX_SINGLE_TOOL_RESULT_BYTES = 32 * 1024
export const DEFAULT_MAX_HISTORICAL_TOOL_RESULT_BYTES = 96 * 1024

const TOOL_RESULT_MARKER = '[DSH TOOL RESULT]'
const TRUNCATION_SUFFIX = '\n[DSH TOOL RESULT TRUNCATED]\n'
const OMITTED_TOOL_RESULT = `${TOOL_RESULT_MARKER}\n[DSH TOOL RESULT OMITTED FROM HISTORY BUDGET]\n`
const DSH_PROTOCOL_MARKER = '=== DSH TOOL PROTOCOL V1 ==='
const HISTORY_COMPACTION_MARKER = '=== USER ===\n[DSH HISTORY COMPACTED: older messages were omitted to stay within AGY input limits. The latest request and tool result are authoritative; re-read files with DSH tools when needed.]'

export class AgyPromptBudgetError extends Error {
  readonly code = 'AGY_INPUT_TOO_LARGE' as const

  constructor(
    readonly actualBytes: number,
    readonly limitBytes: number,
  ) {
    super(`AGY input exceeds the configured limit (${actualBytes} > ${limitBytes} bytes)`)
    this.name = 'AgyPromptBudgetError'
  }
}

export interface AgyPromptBudgetOptions {
  maxFrameBytes: number
  maxPromptBytes?: number
  maxSingleToolResultBytes?: number
  maxHistoricalToolResultBytes?: number
}

export interface AgyPromptBudgetResult {
  readonly prompt: string
  readonly promptBytes: number
  readonly promptLimitBytes: number
  readonly frameBytes: number
  readonly frameLimitBytes: number
  readonly toolResultCount: number
  readonly largestToolResultBytes: number
  readonly truncatedToolResultCount: number
  readonly historyCompacted: boolean
  readonly omittedMessageCount: number
}

interface ToolResultSegment {
  start: number
  end: number
  text: string
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function prefixForBytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  if (byteLength(value) <= maxBytes) return value

  let low = 0
  let high = value.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (byteLength(value.slice(0, middle)) <= maxBytes) low = middle
    else high = middle - 1
  }
  return value.slice(0, low)
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value
  const suffixBytes = byteLength(TRUNCATION_SUFFIX)
  if (maxBytes <= suffixBytes) return prefixForBytes(value, maxBytes)
  return `${prefixForBytes(value, maxBytes - suffixBytes)}${TRUNCATION_SUFFIX}`
}

function collectToolResultSegments(prompt: string): ToolResultSegment[] {
  const segments: ToolResultSegment[] = []
  let searchFrom = 0
  while (searchFrom < prompt.length) {
    const start = prompt.indexOf(TOOL_RESULT_MARKER, searchFrom)
    if (start < 0) break
    const nextSection = prompt.indexOf('\n=== ', start + TOOL_RESULT_MARKER.length)
    const end = nextSection < 0 ? prompt.length : nextSection
    segments.push({ start, end, text: prompt.slice(start, end) })
    searchFrom = end
  }
  return segments
}

function replaceSegments(
  prompt: string,
  segments: readonly ToolResultSegment[],
  replacements: readonly string[],
): string {
  if (segments.length === 0) return prompt
  let output = ''
  let cursor = 0
  segments.forEach((segment, index) => {
    output += prompt.slice(cursor, segment.start)
    output += replacements[index] ?? segment.text
    cursor = segment.end
  })
  return output + prompt.slice(cursor)
}

function truncateToolResults(
  prompt: string,
  maxSingleToolResultBytes: number,
  maxHistoricalToolResultBytes: number,
): { prompt: string; truncatedCount: number } {
  let candidate = prompt
  let truncatedCount = 0
  let segments = collectToolResultSegments(candidate)
  if (segments.length === 0) return { prompt: candidate, truncatedCount }

  const replacements = segments.map(segment => {
    const replacement = truncateUtf8(segment.text, maxSingleToolResultBytes)
    if (replacement !== segment.text) truncatedCount += 1
    return replacement
  })
  candidate = replaceSegments(candidate, segments, replacements)

  // Once each result has its deterministic per-result bound, enforce the
  // aggregate budget by evicting complete oldest segments. Shrinking an
  // already-retained segment in response to a later result changes the bytes
  // of the old prefix on every turn and destroys upstream prompt-cache
  // eligibility. The fixed omission marker keeps the serialized section
  // shape valid while making the eviction decision stable and observable.
  let totalBytes = collectToolResultSegments(candidate)
    .reduce((total, segment) => total + byteLength(segment.text), 0)
  while (totalBytes > maxHistoricalToolResultBytes) {
    segments = collectToolResultSegments(candidate)
    const segment = segments[0]
    if (segment === undefined) break
    const currentBytes = byteLength(segment.text)
    const replacement = totalBytes - currentBytes + byteLength(OMITTED_TOOL_RESULT) <= maxHistoricalToolResultBytes
      ? OMITTED_TOOL_RESULT
      : ''
    candidate = replaceSegments(candidate, [segment], [replacement])
    totalBytes -= currentBytes - byteLength(replacement)
    truncatedCount += 1
  }

  return { prompt: candidate, truncatedCount }
}

/** Return the immutable prefix before the first dynamic DSH history section. */
export function stableAgyPromptPrefix(prompt: string): string {
  const firstMessage = prompt.search(/\n\n=== (?:USER|ASSISTANT|TOOL) ===\n/)
  if (firstMessage >= 0) return prompt.slice(0, firstMessage).trimEnd()
  if (/^=== (?:USER|ASSISTANT|TOOL) ===\n/.test(prompt)) return ''
  return prompt
}

function splitHistoryAndProtocol(prompt: string): {
  history: string
  protocol: string
  protocolBeforeHistory: boolean
} {
  const markerIndex = prompt.indexOf(DSH_PROTOCOL_MARKER)
  if (markerIndex < 0) return { history: prompt, protocol: '', protocolBeforeHistory: false }

  const dynamicMarker = prompt.search(/\n\n=== (?:USER|ASSISTANT|TOOL) ===\n/)
  // DSH-owned prompts place the immutable system/protocol prefix before the
  // dynamic history so the prefix can remain byte-stable for upstream cache
  // matching. Split that layout back into history + protected protocol for
  // budgeting; otherwise a prefix protocol would make history appear empty.
  if (dynamicMarker >= 0 && markerIndex < dynamicMarker) {
    const stablePrefix = prompt.slice(0, markerIndex).trimEnd()
    const protocolStart = markerIndex
    const protocolEndMarker = '\n=== END DSH TOOL PROTOCOL V1 ==='
    const protocolEnd = prompt.indexOf(protocolEndMarker, protocolStart)
    const protocolEndOffset = protocolEnd < 0
      ? dynamicMarker
      : protocolEnd + protocolEndMarker.length
    const protocol = prompt.slice(protocolStart, protocolEndOffset).trim()
    const afterProtocol = prompt.slice(protocolEndOffset).trimStart()
    const repairIndex = afterProtocol.indexOf('\n\n=== DSH TOOL PROTOCOL REPAIR ===')
    const historyTail = repairIndex < 0
      ? afterProtocol
      : afterProtocol.slice(0, repairIndex).trimEnd()
    const repair = repairIndex < 0 ? '' : afterProtocol.slice(repairIndex + 2).trim()
    const history = [stablePrefix, historyTail].filter(value => value.length > 0).join('\n\n')
    return {
      history,
      protocol: [protocol, repair].filter(value => value.length > 0).join('\n\n'),
      protocolBeforeHistory: true,
    }
  }

  // The protocol is intentionally treated as an immutable suffix. Repair
  // instructions follow the V1 marker and therefore remain protected too.
  const historyEnd = prompt.slice(0, markerIndex).trimEnd()
  return {
    history: historyEnd,
    protocol: prompt.slice(markerIndex),
    protocolBeforeHistory: false,
  }
}

function splitSerializedHistory(history: string): string[] {
  if (history.length === 0) return []
  return history
    .split(/\n\n(?=(?:=== SYSTEM|=== USER|=== ASSISTANT|=== TOOL) ===\n)/)
    .filter(section => section.length > 0)
}

function joinHistorySections(
  sections: readonly string[],
  protocol: string,
  protocolBeforeHistory = false,
): string {
  const history = sections.join('\n\n')
  if (protocol.length === 0) return history
  if (history.length === 0) return protocol
  if (!protocolBeforeHistory) return `${history}\n\n${protocol}`
  if (/^=== (?:USER|ASSISTANT|TOOL) ===\n/.test(history)) {
    return `${protocol}\n\n${history}`
  }
  const firstDynamic = history.search(/\n\n=== (?:USER|ASSISTANT|TOOL) ===\n/)
  if (firstDynamic < 0) {
    return /^=== (?:USER|ASSISTANT|TOOL) ===\n/.test(history)
      ? `${protocol}\n\n${history}`
      : `${history}\n\n${protocol}`
  }
  return `${history.slice(0, firstDynamic)}\n\n${protocol}\n\n${history.slice(firstDynamic + 2)}`
}

function compactSerializedHistory(
  prompt: string,
  maxPromptBytes: number,
): { prompt: string; compacted: boolean; omittedMessageCount: number } {
  if (byteLength(prompt) <= maxPromptBytes) {
    return { prompt, compacted: false, omittedMessageCount: 0 }
  }

  const { history, protocol, protocolBeforeHistory } = splitHistoryAndProtocol(prompt)
  const sections = splitSerializedHistory(history)
  if (sections.length === 0) {
    throw new AgyPromptBudgetError(byteLength(prompt), maxPromptBytes)
  }
  const sectionAt = (index: number): string => sections[index] ?? ''

  const latestIndex = sections.length - 1
  const systemIndexes = sections
    .map((section, index) => section.startsWith('=== SYSTEM ===\n') ? index : -1)
    .filter(index => index >= 0)
  const selected = new Set<number>([latestIndex])

  // Keep the first system instruction when it fits. If it does not fit, the
  // current turn still wins; the protocol is always kept separately.
  const firstSystemIndex = systemIndexes[0]
  if (firstSystemIndex !== undefined) selected.add(firstSystemIndex)

  const omittedMarker = HISTORY_COMPACTION_MARKER
  const fits = (indexes: Iterable<number>, includeMarker: boolean): boolean => {
    const ordered = [...indexes].sort((left, right) => left - right)
    const candidateSections = includeMarker
      ? [
          ...ordered.filter(index => index !== latestIndex && index !== firstSystemIndex)
            .map(sectionAt),
          omittedMarker,
          ...(firstSystemIndex !== undefined && ordered.includes(firstSystemIndex)
            ? [sectionAt(firstSystemIndex)]
            : []),
          sectionAt(latestIndex),
        ]
      : ordered.map(sectionAt)
    return byteLength(joinHistorySections(candidateSections, protocol, protocolBeforeHistory)) <= maxPromptBytes
  }

  // Rebuild the mandatory set in a stable order. The marker is inserted as a
  // synthetic user section so the model knows that older context was removed.
  if (!fits(selected, true)) selected.delete(firstSystemIndex ?? -1)
  if (!fits(selected, true)) selected.clear()
  selected.add(latestIndex)

  // Add recent history first. This preserves the current turn and as much of
  // the immediately preceding tool exchange as the safe AGY limit allows.
  for (let index = latestIndex - 1; index >= 0; index -= 1) {
    const candidate = new Set(selected)
    candidate.add(index)
    if (fits(candidate, true)) selected.add(index)
  }

  // If the first system section was skipped by the recent-history pass, add it
  // only when doing so does not displace the latest section or protocol.
  if (firstSystemIndex !== undefined && !selected.has(firstSystemIndex)) {
    const candidate = new Set(selected)
    candidate.add(firstSystemIndex)
    if (fits(candidate, true)) selected.add(firstSystemIndex)
  }

  const ordered = [...selected].sort((left, right) => left - right)
  const preservedSections = ordered.map(sectionAt)
  const omittedMessageCount = sections.length - selected.size
  const preservedWithoutMarker = preservedSections.filter(
    section => !section.startsWith('=== USER ===\n[DSH HISTORY COMPACTED:'),
  )
  const latestPreserved = preservedWithoutMarker[preservedWithoutMarker.length - 1]
  const withMarker = latestPreserved === undefined
    ? [omittedMarker]
    : [
        ...preservedWithoutMarker.slice(0, -1),
        omittedMarker,
        latestPreserved,
      ]

  // The marker is useful for diagnosis, but it must never cause the latest
  // section or the protocol to be lost. If an unusually small test limit
  // leaves no room, omit the marker rather than the current request.
  let compactedPrompt = joinHistorySections(withMarker, protocol, protocolBeforeHistory)
  if (byteLength(compactedPrompt) > maxPromptBytes) {
    compactedPrompt = joinHistorySections(preservedSections, protocol, protocolBeforeHistory)
  }
  if (byteLength(compactedPrompt) > maxPromptBytes) {
    throw new AgyPromptBudgetError(byteLength(compactedPrompt), maxPromptBytes)
  }

  return {
    prompt: compactedPrompt,
    compacted: true,
    omittedMessageCount,
  }
}

function fitPromptToFrame(
  prompt: string,
  maxFrameBytes: number,
): string {
  let candidate = prompt
  while (getAgyUserMessageByteLength(candidate) > maxFrameBytes) {
    const frameBytes = getAgyUserMessageByteLength(candidate)
    const segments = collectToolResultSegments(candidate)
    const segment = segments.find(item => byteLength(item.text) > byteLength(TOOL_RESULT_MARKER))
    if (segment === undefined) throw new AgyPromptBudgetError(frameBytes, maxFrameBytes)
    const currentBytes = byteLength(segment.text)
    const targetBytes = Math.max(
      byteLength(TOOL_RESULT_MARKER),
      currentBytes - (frameBytes - maxFrameBytes),
    )
    const replacement = truncateUtf8(segment.text, targetBytes)
    if (replacement === segment.text) throw new AgyPromptBudgetError(frameBytes, maxFrameBytes)
    candidate = replaceSegments(candidate, [segment], [replacement])
  }
  return candidate
}

/** Bound historical DSH tool output before the prompt is sent to AGY. */
export function boundAgyPrompt(
  prompt: string,
  options: AgyPromptBudgetOptions,
): AgyPromptBudgetResult {
  if (typeof prompt !== 'string' || prompt.length === 0) {
    throw new AgyPromptBudgetError(0, options.maxFrameBytes)
  }
  if (!Number.isSafeInteger(options.maxFrameBytes) || options.maxFrameBytes < 128) {
    throw new RangeError('AGY input frame limit must be an integer of at least 128 bytes')
  }

  const maxSingleToolResultBytes = options.maxSingleToolResultBytes
    ?? DEFAULT_MAX_SINGLE_TOOL_RESULT_BYTES
  const maxHistoricalToolResultBytes = options.maxHistoricalToolResultBytes
    ?? DEFAULT_MAX_HISTORICAL_TOOL_RESULT_BYTES
  const maxPromptBytes = options.maxPromptBytes
    ?? DEFAULT_AGY_PROMPT_CONTENT_LIMIT_BYTES
  if (!Number.isSafeInteger(maxPromptBytes) || maxPromptBytes < 128) {
    throw new RangeError('AGY prompt content limit must be an integer of at least 128 bytes')
  }
  const compacted = truncateToolResults(
    prompt,
    maxSingleToolResultBytes,
    maxHistoricalToolResultBytes,
  )
  const history = compactSerializedHistory(compacted.prompt, maxPromptBytes)
  const boundedPrompt = fitPromptToFrame(history.prompt, options.maxFrameBytes)
  const segments = collectToolResultSegments(boundedPrompt)
  const frameBytes = getAgyUserMessageByteLength(boundedPrompt)
  return {
    prompt: boundedPrompt,
    promptBytes: byteLength(boundedPrompt),
    promptLimitBytes: maxPromptBytes,
    frameBytes,
    frameLimitBytes: options.maxFrameBytes,
    toolResultCount: segments.length,
    largestToolResultBytes: segments.reduce(
      (largest, segment) => Math.max(largest, byteLength(segment.text)),
      0,
    ),
    truncatedToolResultCount: compacted.truncatedCount,
    historyCompacted: history.compacted,
    omittedMessageCount: history.omittedMessageCount,
  }
}
