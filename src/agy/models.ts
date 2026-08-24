import { resolveAgyExecutable, runProcess, type ProcessRequest, type ProcessResult } from './process.js'
import type { ModelConfig } from '../provider/config.js'
import { extractModelEffort, normalizeModelId } from '../provider/config.js'
import {
  MODEL_DISCOVERY_EMPTY_CODE,
  MODEL_DISCOVERY_FAILED_CODE,
  MODEL_DISCOVERY_OUTPUT_LIMIT_CODE,
  MODEL_DISCOVERY_TIMEOUT_CODE,
  type ModelDiscoveryErrorCode,
} from '../provider/error-codes.js'

export type { ModelDiscoveryErrorCode } from '../provider/error-codes.js'

export const DEFAULT_MODEL_DISCOVERY_TTL_MS = 5 * 60_000
export const DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS = 10_000
export const MAX_MODEL_DISCOVERY_OUTPUT_BYTES = 1 * 1024 * 1024

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+@/-]{0,255}$/
const MAX_MODEL_DISPLAY_LENGTH = 512

export type ModelDiscoverySource = 'discovered' | 'merged' | 'cache' | 'fallback'

export interface AgyModelDiscoveryResult {
  models: readonly ModelConfig[]
  source: ModelDiscoverySource
  stale: boolean
  warning?: string
  warningCode?: ModelDiscoveryErrorCode
}

export type AgyModelDiscoveryCommand = (request: ProcessRequest) => Promise<ProcessResult>

export interface AgyModelDiscoveryOptions {
  executable?: string
  ttlMs?: number
  timeoutMs?: number
  maxOutputBytes?: number
  runCommand?: AgyModelDiscoveryCommand
  now?: () => number
}

interface CachedModels {
  models: readonly ModelConfig[]
  expiresAt: number
}

class ModelDiscoveryFailure extends Error {
  constructor(message: string, readonly code: ModelDiscoveryErrorCode) {
    super(message)
    this.name = 'ModelDiscoveryFailure'
  }
}

function isSuccessful(result: ProcessResult): boolean {
  return result.termination === 'completed' && result.exitCode === 0
}

function warningOf(error: unknown): { message: string; code: ModelDiscoveryErrorCode } {
  if (error instanceof ModelDiscoveryFailure) return { message: error.message, code: error.code }
  return { message: 'AGY model discovery failed', code: MODEL_DISCOVERY_FAILED_CODE }
}

function metadataValue<T extends keyof ModelConfig>(
  preferred: ModelConfig,
  fallback: ModelConfig | undefined,
  key: T,
): ModelConfig[T] | undefined {
  const preferredValue = preferred[key]
  if (preferredValue !== undefined) return preferredValue
  return fallback?.[key]
}

/** Merge explicit configuration first, then add AGY-discovered models. Normalizes base ids and dedupes. */
export function mergeModelCatalog(
  configured: readonly ModelConfig[],
  discovered: readonly ModelConfig[],
): readonly ModelConfig[] {
  const normalizedDiscovered = discovered.map(m => ({ ...m, id: normalizeModelId(m.id) }))
  const discoveredById = new Map(normalizedDiscovered.map(model => [model.id.toLowerCase(), model]))
  const merged: ModelConfig[] = []
  const seen = new Set<string>()

  for (const configuredModel of configured) {
    const baseId = normalizeModelId(configuredModel.id)
    const key = baseId.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const discoveredModel = discoveredById.get(baseId.toLowerCase())
    const model: ModelConfig = { id: baseId }
    const name = metadataValue(configuredModel, discoveredModel, 'name')
    const description = metadataValue(configuredModel, discoveredModel, 'description')
    const contextWindow = metadataValue(configuredModel, discoveredModel, 'contextWindow')
    if (name !== undefined) model.name = name
    if (description !== undefined) model.description = description
    if (contextWindow !== undefined) model.contextWindow = contextWindow
    merged.push(model)
  }

  for (const discoveredModel of normalizedDiscovered) {
    const key = discoveredModel.id.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    merged.push({ ...discoveredModel })
  }
  return merged
}

/** @deprecated Use normalizeModelId/extractModelEffort for effort-split handling. */
export const MODEL_EFFORT_SUFFIX_RE = /-(?:low|medium|high)$/i

/** Parse the tab-separated, non-interactive output of `agy models`. Normalizes -high/-medium/-low suffix to base id and dedupes base. */
export function parseAgyModels(output: string): ModelConfig[] {
  const models: ModelConfig[] = []
  const seen = new Set<string>()
  const baseSeen = new Set<string>()
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    const fields = line.split(/\t+/)
    const id = fields.shift()?.trim() ?? ''
    const display = fields.join(' ').trim()
    if (!MODEL_ID_PATTERN.test(id) || seen.has(id)) continue
    const baseId = normalizeModelId(id)
    if (baseSeen.has(baseId.toLowerCase())) continue
    if (id.toLowerCase() === 'id' && /display|name/i.test(display)) continue
    if (display.length > MAX_MODEL_DISPLAY_LENGTH || /[\u0000-\u001f\u007f]/.test(display)) continue
    seen.add(id)
    baseSeen.add(baseId.toLowerCase())
    // Preserve display but normalize id to base for DSH reasoningEffort split
    // Handle displays like "Gemini 3.1 Pro (High)" or "Gemini 3.7 Flash - High"
    const strippedDisplay = display
      .replace(/\s*[\(\[]\s*(?:low|medium|high)\s*[\)\]]\s*$/i, '')
      .replace(/(?:\s+|-)(?:low|medium|high)\s*$/i, '')
      .trim()
    const normalized: ModelConfig = display.length === 0 ? { id: baseId } : { id: baseId, name: strippedDisplay.length === 0 ? baseId : strippedDisplay }
    models.push(normalized)
  }
  return models
}

/**
 * Discover AGY models without invoking a model request. Results are kept in
 * memory only. A refresh is single-flight and all failures fail open to the
 * last successful catalog or the caller's static catalog.
 */
export class AgyModelDiscovery {
  private readonly executable: string | undefined
  private readonly ttlMs: number
  private readonly timeoutMs: number
  private readonly maxOutputBytes: number
  private readonly runCommand: AgyModelDiscoveryCommand
  private readonly now: () => number
  private cache: CachedModels | undefined
  private inFlight: Promise<AgyModelDiscoveryResult> | undefined

  constructor(options: AgyModelDiscoveryOptions = {}) {
    this.executable = options.executable?.trim() === '' ? undefined : options.executable?.trim()
    this.ttlMs = options.ttlMs ?? DEFAULT_MODEL_DISCOVERY_TTL_MS
    this.timeoutMs = options.timeoutMs ?? DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS
    this.maxOutputBytes = Math.min(options.maxOutputBytes ?? MAX_MODEL_DISCOVERY_OUTPUT_BYTES, MAX_MODEL_DISCOVERY_OUTPUT_BYTES)
    this.runCommand = options.runCommand ?? runProcess
    this.now = options.now ?? Date.now
  }

  async discover(configured: readonly ModelConfig[]): Promise<AgyModelDiscoveryResult> {
    const currentTime = this.now()
    if (this.cache !== undefined && this.cache.expiresAt > currentTime) {
      return { models: this.cache.models, source: 'cache', stale: false }
    }
    if (this.inFlight !== undefined) return this.inFlight

    const refresh = this.refresh(configured)
    this.inFlight = refresh
    try {
      return await refresh
    } finally {
      if (this.inFlight === refresh) this.inFlight = undefined
    }
  }

  private async refresh(configured: readonly ModelConfig[]): Promise<AgyModelDiscoveryResult> {
    try {
      const request: ProcessRequest = {
        executable: resolveAgyExecutable(this.executable),
        args: ['models'],
        timeoutMs: this.timeoutMs,
        maxStdoutBytes: this.maxOutputBytes,
        maxStderrBytes: this.maxOutputBytes,
        windowsNoConsole: true,
      }
      const result = await this.runCommand(request)
      if (!isSuccessful(result)) {
        const code = result.termination === 'timeout'
          ? MODEL_DISCOVERY_TIMEOUT_CODE
          : result.termination === 'output-limit'
            ? MODEL_DISCOVERY_OUTPUT_LIMIT_CODE
            : MODEL_DISCOVERY_FAILED_CODE
        throw new ModelDiscoveryFailure(
          code === MODEL_DISCOVERY_TIMEOUT_CODE
            ? 'AGY model discovery command timed out'
            : code === MODEL_DISCOVERY_OUTPUT_LIMIT_CODE
              ? 'AGY model discovery output exceeded its limit'
              : 'AGY model discovery command failed',
          code,
        )
      }
      const discovered = parseAgyModels(result.stdoutLines.join('\n'))
      if (discovered.length === 0) throw new ModelDiscoveryFailure(
        'AGY model discovery returned no usable models',
        MODEL_DISCOVERY_EMPTY_CODE,
      )
      const models = mergeModelCatalog(configured, discovered)
      this.cache = {
        models,
        expiresAt: this.now() + this.ttlMs,
      }
      return {
        models,
        source: configured.length === 0 ? 'discovered' : 'merged',
        stale: false,
      }
    } catch (error) {
      const warning = warningOf(error)
      if (this.cache !== undefined) {
        return {
          models: this.cache.models,
          source: 'cache',
          stale: true,
          warning: warning.message,
          warningCode: warning.code,
        }
      }
      return {
        models: configured,
        source: 'fallback',
        stale: true,
        warning: warning.message,
        warningCode: warning.code,
      }
    }
  }
}
