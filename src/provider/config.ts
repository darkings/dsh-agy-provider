import z from '@deepseek-ai/schemastery'

export interface Config {
  /** Keep the bundle inert until explicitly enabled. */
  enabled?: boolean
  /** DSH provider route owned by this plugin. */
  provider?: string
  /** AGY model passed to the CLI when a request does not override it. */
  model?: string
  /** Explicit model catalog; legacy `model` remains the default/fallback entry. */
  models?: ModelConfig[]
  /** Discover additional models with `agy models`; `off` keeps static-only behavior. */
  modelDiscovery?: 'auto' | 'off'
  /** In-memory model discovery cache lifetime. */
  modelDiscoveryTtlMs?: number
  /** Timeout for the quota-free `agy models` command. */
  modelDiscoveryTimeoutMs?: number
  /** Ownership policy for DSH tool schemas; AGY remains the internal tool owner. */
  toolPolicy?: ToolPolicy
  /** AGY agent profile, for example `deepseek-proxy`. */
  agent?: string
  /** Explicit AGY executable path; empty means discover from environment/PATH. */
  agyPath?: string
  /** Hard upper bound for one AGY child process. */
  timeoutMs?: number
  /** `full` sends DSH history; `resume` reuses an AGY conversation. */
  sessionMode?: 'resume' | 'full'
  /** Minimum AGY version accepted by the diagnostic command. */
  minimumAgyVersion?: string
  /** Maximum number of active AGY child processes per adapter instance. */
  maxConcurrent?: number
  /** Maximum number of AGY requests waiting for a process slot. */
  maxQueue?: number
  /** Maximum queue wait in milliseconds; `0` disables the queue timeout. */
  queueTimeoutMs?: number
  /** Maximum stdout/stderr bytes captured from one AGY process. */
  maxOutputBytes?: number
  /** Maximum length of one AGY stream-json line. */
  maxEventLineLength?: number
  /** Deterministic response used only by the M1 mock route. */
  response?: string
  /** Optional delay used only by the M1 mock route. */
  delayMs?: number
}

export type ToolPolicy = 'reject' | 'agy-owned'

export interface ModelConfig {
  /** Exact model id passed to AGY. */
  id: string
  /** Optional selector label; defaults to `id`. */
  name?: string
  /** Optional selector description. */
  description?: string
  /** Optional provider-declared combined context capacity. */
  contextWindow?: number
}

export const DEFAULT_MODEL = 'gemini-3.1-pro-high'

const ModelConfig = z.object({
  id: z.string().pattern(/^\S(?:.*\S)?$/).required(),
  name: z.string().pattern(/^\S(?:.*\S)?$/),
  description: z.string(),
  contextWindow: z.natural().min(1).max(10_000_000),
}) as unknown as z<ModelConfig>

export function createConfigSchema(defaults: {
  enabled?: boolean
  toolPolicy?: ToolPolicy
} = {}): z<Config> {
  const defaultEnabled = defaults.enabled ?? false
  const defaultToolPolicy = defaults.toolPolicy ?? 'reject'

  return z.object({
    enabled: z.boolean().default(defaultEnabled),
    provider: z.string().default('agy'),
    model: z.string().default(DEFAULT_MODEL),
    models: z.array(ModelConfig).default([]),
    modelDiscovery: z.union(['auto', 'off'] as const).default('auto'),
    modelDiscoveryTtlMs: z.number().min(1_000).max(3_600_000).default(300_000),
    modelDiscoveryTimeoutMs: z.number().min(100).max(30_000).default(10_000),
    toolPolicy: z.union(['reject', 'agy-owned'] as const).default(defaultToolPolicy),
    agent: z.string().default('deepseek-proxy'),
    agyPath: z.string().default(''),
    timeoutMs: z.number().min(1).max(3_600_000).default(120_000),
    sessionMode: z.union(['resume', 'full'] as const).default('full'),
    minimumAgyVersion: z.string().pattern(/^\d+\.\d+\.\d+$/).default('1.1.13'),
    maxConcurrent: z.natural().min(1).max(64).default(4),
    maxQueue: z.natural().max(256).default(32),
    queueTimeoutMs: z.natural().max(3_600_000).default(30_000),
    maxOutputBytes: z.natural().min(1_024).max(64 * 1024 * 1024).default(8 * 1024 * 1024),
    maxEventLineLength: z.natural().min(1_024).max(8 * 1024 * 1024).default(1_048_576),
    response: z.string().default('AGY mock provider is ready.'),
    delayMs: z.number().min(0).max(60_000).default(0),
  })
}

/** Programmatic library default: enabled=false, toolPolicy=reject */
export const Config: z<Config> = createConfigSchema({ enabled: false, toolPolicy: 'reject' })

/** Bundle default for DSH profile plugin add: enabled=true, toolPolicy=agy-owned */
export const BundleConfig: z<Config> = createConfigSchema({ enabled: true, toolPolicy: 'agy-owned' })

/**
 * Resolve the effective catalog while keeping the 0.1.0 `model` setting
 * compatible. Catalog membership is advisory; unknown exact model ids remain
 * valid request targets and are handled by each adapter's resolveModel().
 */
export function configuredModels(config: Pick<Config, 'model' | 'models'> = {}): readonly ModelConfig[] {
  const fallbackId = config.model?.trim() || DEFAULT_MODEL
  const entries = config.models !== undefined && config.models.length > 0
    ? config.models
    : [{ id: fallbackId }]
  const catalog: ModelConfig[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    const id = entry.id.trim()
    if (id.length === 0 || seen.has(id)) continue
    seen.add(id)
    catalog.push({ ...entry, id })
  }
  if (!seen.has(fallbackId)) catalog.push({ id: fallbackId })
  return catalog
}
