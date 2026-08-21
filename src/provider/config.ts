import z from '@deepseek-ai/schemastery'
import { AGENT_PRESET_IDS, type AgentPresetId } from '../agent-presets.js'

export interface Config {
  /** Keep the bundle inert until explicitly enabled. */
  enabled?: boolean
  /** DSH provider route owned by this plugin. */
  provider?: string
  /** AGY model passed to the CLI when a request does not override it. */
  model?: string
  /** Explicit model catalog; legacy `model` remains the default/fallback entry. */
  models?: ModelConfig[]
  /** Visible models filter; empty means show all discovered models. */
  visibleModels?: string[]
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
  /** Optional bundled Agent capability profile; omitted preserves the configured agent. */
  agentPreset?: AgentPresetId
  /** @deprecated Use DSH session workspace; kept for legacy agy-owned compatibility. */
  workspaceRoot?: string
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
  /** Provider-owned bounded retry policy; omission defaults to zero retries. */
  retryPolicy?: AgyRetryPolicyConfig
  /** Optional model/Agent/effort overrides for DSH auxiliary call purposes. */
  purposeRoutes?: PurposeRoutesConfig
  /** Transport for AGY requests; 'one-shot' keeps 0.7.0 behavior, 'persistent' opt-in reuses one AGY stream-json worker per DSH session. */
  transport?: TransportMode
  /** Idle TTL for a persistent worker in ms; 0 closes immediately after a turn. */
  persistentIdleTtlMs?: number
  /** Ready timeout for persistent worker startup in ms. */
  persistentReadyTimeoutMs?: number
  /** Fallback policy when persistent cannot start: never or before-accept only. */
  persistentFallback?: PersistentFallbackMode
  /** Experimental AttachmentStore-to-file bridge; omitted/off preserves text-only behavior. */
  imageInput?: 'off' | 'experimental'
  /** Deterministic response used only by the M1 mock route. */
  response?: string
  /** Optional delay used only by the M1 mock route. */
  delayMs?: number
}

export type ToolPolicy = 'reject' | 'agy-owned' | 'dsh-owned'
export type TransportMode = 'one-shot' | 'persistent'
export type PersistentFallbackMode = 'never' | 'before-accept'

export const AGY_RETRYABLE_CODES = ['RATE_LIMIT', 'SERVER', 'TRANSPORT'] as const
export type AgyRetryableCode = typeof AGY_RETRYABLE_CODES[number]

export interface AgyRetryPolicyConfig {
  /** Eligible retries after the first AGY process; hard capped at 2. */
  maxRetries?: number
  /** Stable transient codes allowed to consume another AGY attempt. */
  retryableCodes?: AgyRetryableCode[]
}

export type AgyReasoningEffortConfig = 'low' | 'medium' | 'high'

export interface PurposeRouteConfig {
  /** Optional model override for this auxiliary call purpose. */
  model?: string
  /** Optional AGY Agent override for this auxiliary call purpose. */
  agent?: string
  /** Optional AGY reasoning effort override for this auxiliary call purpose. */
  reasoningEffort?: AgyReasoningEffortConfig
}

export interface PurposeRoutesConfig {
  compaction?: PurposeRouteConfig
  sessionTitle?: PurposeRouteConfig
}

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

const RetryPolicyConfig = z.object({
  maxRetries: z.natural().max(2).default(0),
  retryableCodes: z.array(z.union(AGY_RETRYABLE_CODES)).default([...AGY_RETRYABLE_CODES]),
}) as unknown as z<AgyRetryPolicyConfig>

const PurposeRoute = z.object({
  model: z.string().pattern(/^\S(?:.*\S)?$/),
  agent: z.string().pattern(/^\S(?:.*\S)?$/),
  reasoningEffort: z.union(['low', 'medium', 'high'] as const),
}) as unknown as z<PurposeRouteConfig>

const PurposeRoutes = z.object({
  compaction: PurposeRoute,
  sessionTitle: PurposeRoute,
}) as unknown as z<PurposeRoutesConfig>

export function createConfigSchema(defaults: {
  enabled?: boolean
  toolPolicy?: ToolPolicy
} = {}): z<Config> {
  const defaultEnabled = defaults.enabled ?? false
  const defaultToolPolicy = defaults.toolPolicy ?? 'reject'

  const schema = z.object({
    enabled: z.boolean().default(defaultEnabled).description('Enable AGY provider'),
    provider: z.string().default('agy').description('Provider route id'),
    model: z.string().default(DEFAULT_MODEL).description('Default model id (base, without -high/-medium/-low suffix)'),
    models: z.array(ModelConfig).default([]).description('Explicit model catalog; entries are base ids'),
    visibleModels: z.array(z.string().pattern(/^\S(?:.*\S)?$/)).default([]).description('Visible models filter; empty shows all discovered models, non-empty only shows checked base ids'),
    modelDiscovery: z.union(['auto', 'off'] as const).default('auto').description('Discover models via agy models'),
    modelDiscoveryTtlMs: z.number().min(1_000).max(3_600_000).default(300_000).description('Discovery cache TTL ms'),
    modelDiscoveryTimeoutMs: z.number().min(100).max(30_000).default(10_000).description('Discovery timeout ms'),
    toolPolicy: z.union(['reject', 'agy-owned', 'dsh-owned'] as const).default(defaultToolPolicy).description('Tool ownership policy'),
    agent: z.string().default('deepseek-proxy').description('AGY agent profile'),
    agentPreset: z.union(AGENT_PRESET_IDS).description('Optional agent preset'),
    workspaceRoot: z.string().pattern(/^\S(?:.*\S)?$/).description('Deprecated: use DSH session workspace').deprecated(),
    agyPath: z.string().default('').description('AGY executable path'),
    timeoutMs: z.number().min(1).max(3_600_000).default(120_000).description('Per-request timeout ms'),
    sessionMode: z.union(['resume', 'full'] as const).default('full').description('Session mode'),
    minimumAgyVersion: z.string().pattern(/^\d+\.\d+\.\d+$/).default('1.1.13').description('Minimum AGY version'),
    maxConcurrent: z.natural().min(1).max(64).default(4).description('Max concurrent AGY processes'),
    maxQueue: z.natural().max(256).default(32).description('Max queue length'),
    queueTimeoutMs: z.natural().max(3_600_000).default(30_000).description('Queue timeout ms'),
    transport: z.union(['one-shot', 'persistent'] as const).default('one-shot').description('Transport mode'),
    persistentIdleTtlMs: z.number().min(0).max(3_600_000).default(30_000).description('Persistent idle TTL ms'),
    persistentReadyTimeoutMs: z.number().min(1).max(60_000).default(10_000).description('Persistent ready timeout ms'),
    persistentFallback: z.union(['never', 'before-accept'] as const).default('before-accept').description('Persistent fallback policy'),
    maxOutputBytes: z.natural().min(1_024).max(64 * 1024 * 1024).default(8 * 1024 * 1024).description('Max output bytes'),
    maxEventLineLength: z.natural().min(1_024).max(8 * 1024 * 1024).default(1_048_576).description('Max event line length'),
    retryPolicy: RetryPolicyConfig.default({
      maxRetries: 0,
      retryableCodes: [...AGY_RETRYABLE_CODES],
    }),
    purposeRoutes: PurposeRoutes.description('Purpose-specific overrides'),
    imageInput: z.union(['off', 'experimental'] as const).description('Image input mode'),
    response: z.string().default('AGY mock provider is ready.').description('Mock response'),
    delayMs: z.number().min(0).max(60_000).default(0).description('Mock delay ms'),
  })

  return schema.i18n({
    'zh-CN': {
      enabled: { $description: '是否启用 AGY 提供方' },
      provider: { $description: '提供方路由 ID（固定为 agy）' },
      model: { $description: '默认模型 ID（基础名称，不含 -high/-medium/-low 后缀，推理强度另选）' },
      models: { $description: '显式模型目录；条目为基础 ID，可覆盖名称与上下文窗口' },
      visibleModels: { $description: '可见模型过滤；为空时显示全部发现模型，非空时仅显示勾选的基础 ID' },
      modelDiscovery: { $description: '是否通过 agy models 自动发现模型' },
      modelDiscoveryTtlMs: { $description: '模型发现缓存时间（毫秒）' },
      modelDiscoveryTimeoutMs: { $description: '模型发现超时（毫秒）' },
      toolPolicy: { $description: '工具所有权：reject=拒绝 DSH 工具, agy-owned=旧版 AGY 执行, dsh-owned=推荐 DSH 执行' },
      agent: { $description: 'AGY 代理名称，如 deepseek-proxy' },
      agentPreset: { $description: '代理能力预设' },
      workspaceRoot: { $description: '已废弃：请使用 DSH 会话的项目目录，无需手动配置' },
      agyPath: { $description: 'AGY 可执行文件路径，空则自动发现' },
      timeoutMs: { $description: '单次请求超时（毫秒）' },
      sessionMode: { $description: '会话模式：full=每轮完整历史, resume=复用 AGY 会话' },
      minimumAgyVersion: { $description: '最低允许的 AGY 版本' },
      maxConcurrent: { $description: '最大并发 AGY 进程数' },
      maxQueue: { $description: '最大排队长度' },
      queueTimeoutMs: { $description: '排队超时（毫秒）' },
      transport: { $description: '传输模式：one-shot=每请求新进程, persistent=同会话复用 worker' },
      persistentIdleTtlMs: { $description: '持久 worker 空闲回收时间（毫秒）' },
      persistentReadyTimeoutMs: { $description: '持久 worker 就绪超时（毫秒）' },
      persistentFallback: { $description: '持久失败回退策略' },
      maxOutputBytes: { $description: '单次 AGY 输出最大字节' },
      maxEventLineLength: { $description: '单行事件最大长度' },
      purposeRoutes: { $description: '按用途（压缩/标题）的模型覆盖' },
      imageInput: { $description: '图片输入：off=关闭, experimental=实验性' },
    },
    en: {
      enabled: { $description: 'Enable AGY provider' },
      provider: { $description: 'Provider route id (always agy)' },
      model: { $description: 'Default base model id (without -high/-medium/-low suffix; effort selected separately)' },
      models: { $description: 'Explicit model catalog; entries are base ids' },
      visibleModels: { $description: 'Visible models filter; empty shows all discovered base models, non-empty only shows checked ids' },
      modelDiscovery: { $description: 'Auto-discover models via agy models' },
      modelDiscoveryTtlMs: { $description: 'Discovery cache TTL (ms)' },
      modelDiscoveryTimeoutMs: { $description: 'Discovery timeout (ms)' },
      toolPolicy: { $description: 'Tool ownership: reject, agy-owned (legacy), dsh-owned (recommended)' },
      agent: { $description: 'AGY agent profile, e.g. deepseek-proxy' },
      agentPreset: { $description: 'Agent capability preset' },
      workspaceRoot: { $description: 'Deprecated: uses DSH session workspace, no manual path needed' },
      agyPath: { $description: 'AGY executable path, empty auto-discovers' },
      timeoutMs: { $description: 'Per-request timeout (ms)' },
      sessionMode: { $description: 'Session mode: full or resume' },
      minimumAgyVersion: { $description: 'Minimum AGY version' },
      maxConcurrent: { $description: 'Max concurrent AGY processes' },
      maxQueue: { $description: 'Max queue length' },
      queueTimeoutMs: { $description: 'Queue timeout (ms)' },
      transport: { $description: 'Transport: one-shot or persistent' },
      persistentIdleTtlMs: { $description: 'Persistent idle TTL (ms)' },
      persistentReadyTimeoutMs: { $description: 'Persistent ready timeout (ms)' },
      persistentFallback: { $description: 'Persistent fallback policy' },
      maxOutputBytes: { $description: 'Max output bytes per AGY process' },
      maxEventLineLength: { $description: 'Max event line length' },
      purposeRoutes: { $description: 'Purpose-specific model overrides' },
      imageInput: { $description: 'Image input: off or experimental' },
    },
  }) as unknown as z<Config>
}

/** Programmatic library default: enabled=false, toolPolicy=reject */
export const Config: z<Config> = createConfigSchema({ enabled: false, toolPolicy: 'reject' })

/** Bundle default for DSH profile plugin add: enabled=true, DSH owns tools. */
export const BundleConfig: z<Config> = createConfigSchema({ enabled: true, toolPolicy: 'dsh-owned' })

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

/** Normalize a possibly suffixed model id to its base (strip -low/-medium/-high). */
export function normalizeModelId(id: string): string {
  return id.replace(/-(?:low|medium|high)$/i, '')
}

/** Extract effort suffix from a model id, if present. */
export function extractModelEffort(id: string): 'low' | 'medium' | 'high' | undefined {
  const m = /-(low|medium|high)$/i.exec(id)
  if (!m || !m[1]) return undefined
  return m[1].toLowerCase() as 'low' | 'medium' | 'high'
}

/** Filter catalog by visibleModels (empty = all). */
export function filterVisibleModels(models: readonly ModelConfig[], visibleModels: readonly string[] | undefined): readonly ModelConfig[] {
  if (visibleModels === undefined || visibleModels.length === 0) return models
  const allow = new Set(visibleModels.map(normalizeModelId))
  return models.filter(m => allow.has(normalizeModelId(m.id)))
}
