import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import {
  diagnoseAgy,
  type AgyDiagnosticCommand,
  type AgyDiagnosticOptions,
  type AgyDiagnosticResult,
} from './agy/diagnostics.js'
import {
  AgyModelDiscovery,
  type AgyModelDiscoveryCommand,
  type ModelDiscoverySource,
} from './agy/models.js'
import type { ModelDiscoveryErrorCode } from './provider/error-codes.js'
import { redactText } from './agy/redact.js'
import {
  Config as ConfigSchema,
  configuredModels,
  type Config,
  type ModelConfig,
  type ToolPolicy,
} from './provider/config.js'

const require = createRequire(import.meta.url)

interface PackageMetadata {
  name?: string
  version?: string
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

function loadPackageMetadata(): PackageMetadata {
  try {
    return require('../package.json') as PackageMetadata
  } catch {
    return {}
  }
}

const packageMetadata = loadPackageMetadata()

export interface DiagnosticModel {
  id: string
  name: string
  description: string | null
  inputModalities: readonly ('text' | 'image')[]
  contextWindow: number | null
}

export type DiagnosticComponent = 'node' | 'bundle' | 'agy' | 'models' | 'config' | 'profile'

export interface DiagnosticIssue {
  component: DiagnosticComponent
  code: string
  message: string
}

export interface ProviderDiagnosticOptions {
  config?: Config
  executable?: string
  timeoutMs?: number
  runCommand?: AgyDiagnosticCommand
  runModelDiscovery?: AgyModelDiscoveryCommand
  pluginVersion?: string | null
  dshCliVersion?: string | null
  dshLlmVersion?: string | null
  bundlePatchPresent?: boolean
  nodeVersion?: string
}

export interface ProviderDiagnosticResult {
  schemaVersion: 2
  ok: boolean
  quotaUsed: false
  plugin: {
    name: string
    version: string | null
    enabled: boolean
  }
  node: {
    version: string
    major: number | null
    supported: boolean
  }
  dsh: {
    cliVersion: string | null
    llmContractVersion: string | null
    bundlePatchPresent: boolean
  }
  configuration: {
    provider: string
    agent: string
    defaultModel: string
    modelDiscovery: 'auto' | 'off'
    toolPolicy: ToolPolicy
    sessionMode: 'resume' | 'full'
    enabled: boolean
    transport: string
    persistentIdleTtlMs: number
    persistentReadyTimeoutMs: number
    persistentFallback: string
  }
  models: readonly DiagnosticModel[]
  modelCatalog: {
    source: 'static' | ModelDiscoverySource
    stale: boolean
    warning: string | null
    warningCode: ModelDiscoveryErrorCode | null
  }
  agy: AgyDiagnosticResult
  errors: readonly DiagnosticIssue[]
}

function modelDiagnostic(model: ModelConfig, imageInput: Config['imageInput']): DiagnosticModel {
  return {
    id: model.id,
    name: model.name ?? model.id,
    description: model.description ?? null,
    inputModalities: imageInput === 'experimental' ? ['text', 'image'] : ['text'],
    contextWindow: model.contextWindow ?? null,
  }
}

function issueCode(message: string): string {
  if (/below the required minimum/i.test(message)) return 'AGY_VERSION_UNSUPPORTED'
  if (/version from --version/i.test(message)) return 'AGY_VERSION_UNREADABLE'
  if (/Agent .* was not found/i.test(message)) return 'AGY_AGENT_MISSING'
  if (/agents failed/i.test(message)) return 'AGY_AGENT_CHECK_FAILED'
  if (/--version failed/i.test(message)) return 'AGY_VERSION_CHECK_FAILED'
  return 'AGY_DIAGNOSTIC_FAILED'
}

function nodeMajorOf(version: string): number | null {
  const match = /^(\d+)/.exec(version)
  if (match === null) return null
  const major = Number(match[1])
  return Number.isSafeInteger(major) ? major : null
}

/**
 * Build the machine-readable, quota-free diagnostic contract for the plugin.
 * It deliberately exposes only safe labels and metadata, never AGY paths,
 * environment values, credentials, prompts, or session content.
 */
export async function diagnoseProvider(
  options: ProviderDiagnosticOptions = {},
): Promise<ProviderDiagnosticResult> {
  const config = ConfigSchema(options.config ?? {})
  const nodeVersion = options.nodeVersion ?? process.versions.node
  const nodeMajor = nodeMajorOf(nodeVersion)
  const nodeSupported = nodeMajor !== null && nodeMajor >= 20
  const bundlePatchPresent = options.bundlePatchPresent
    ?? existsSync(fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)))
  const executable = options.executable ?? config.agyPath
  const configuredCatalog = configuredModels(config)
  const modelDiscoveryCommand = options.runModelDiscovery ?? options.runCommand
  const discovery = config.modelDiscovery === 'off'
    ? undefined
    : new AgyModelDiscovery({
      ...(executable === undefined || executable.trim().length === 0 ? {} : { executable }),
      ...(config.modelDiscoveryTtlMs === undefined ? {} : { ttlMs: config.modelDiscoveryTtlMs }),
      ...(config.modelDiscoveryTimeoutMs === undefined ? {} : { timeoutMs: config.modelDiscoveryTimeoutMs }),
      ...(config.maxOutputBytes === undefined ? {} : { maxOutputBytes: config.maxOutputBytes }),
      ...(modelDiscoveryCommand === undefined ? {} : { runCommand: modelDiscoveryCommand }),
    })
  const modelCatalog: {
    models: readonly ModelConfig[]
    source: 'static' | ModelDiscoverySource
    stale: boolean
    warning?: string
    warningCode?: ModelDiscoveryErrorCode
  } = discovery === undefined
    ? { models: configuredCatalog, source: 'static' as const, stale: false }
    : await discovery.discover(configuredCatalog)
  const models = modelCatalog.models.map(model => modelDiagnostic(model, config.imageInput))
  const agyOptions: AgyDiagnosticOptions = {
    ...(executable === undefined || executable.trim().length === 0 ? {} : { executable }),
    expectedAgent: config.agent ?? 'deepseek-proxy',
    minimumVersion: config.minimumAgyVersion ?? '1.1.15',
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.runCommand === undefined ? {} : { runCommand: options.runCommand }),
  }
  const agy = await diagnoseAgy(agyOptions)

  const errors: DiagnosticIssue[] = []
  if (!nodeSupported) {
    errors.push({
      component: 'node',
      code: 'NODE_UNSUPPORTED',
      message: `Node.js ${nodeVersion} is below the required major version 20`,
    })
  }
  if (!bundlePatchPresent) {
    errors.push({
      component: 'bundle',
      code: 'BUNDLE_PATCH_MISSING',
      message: 'dsh.bundle.patch and cordis.patch.yml could not be verified',
    })
  }
  if (models.length === 0) {
    errors.push({
      component: 'models',
      code: 'MODEL_CATALOG_EMPTY',
      message: 'No effective model is configured',
    })
  }
  for (const message of agy.errors) {
    errors.push({
      component: 'agy',
      code: issueCode(message),
      message: redactText(message, 512),
    })
  }

  const metadata = packageMetadata
  const llmContractVersion = options.dshLlmVersion
    ?? metadata.devDependencies?.['@deepseek-ai/dsh-llm']
    ?? metadata.peerDependencies?.['@deepseek-ai/dsh-llm']
    ?? null
  return {
    schemaVersion: 2,
    ok: errors.length === 0,
    quotaUsed: false,
    plugin: {
      name: metadata.name ?? 'dsh-agy-provider',
      version: options.pluginVersion ?? metadata.version ?? null,
      enabled: config.enabled === true,
    },
    node: {
      version: nodeVersion,
      major: nodeMajor,
      supported: nodeSupported,
    },
    dsh: {
      cliVersion: options.dshCliVersion ?? process.env.DSH_CLI_VERSION ?? null,
      llmContractVersion,
      bundlePatchPresent,
    },
    configuration: {
      provider: config.provider ?? 'agy',
      agent: config.agent ?? 'deepseek-proxy',
      defaultModel: config.model ?? models[0]?.id ?? 'unknown',
      modelDiscovery: config.modelDiscovery === 'off' ? 'off' : 'auto',
      toolPolicy: config.toolPolicy === 'agy-owned'
        ? 'agy-owned'
        : config.toolPolicy === 'dsh-owned' ? 'dsh-owned' : 'reject',
      sessionMode: config.sessionMode === 'resume' ? 'resume' : 'full',
      enabled: config.enabled === true,
      transport: (config as any).transport ?? 'one-shot',
      persistentIdleTtlMs: (config as any).persistentIdleTtlMs ?? 30000,
      persistentReadyTimeoutMs: (config as any).persistentReadyTimeoutMs ?? 10000,
      persistentFallback: (config as any).persistentFallback ?? 'before-accept',
    },
    models,
    modelCatalog: {
      source: modelCatalog.source,
      stale: modelCatalog.stale,
      warning: modelCatalog.warning ?? null,
      warningCode: modelCatalog.warningCode ?? null,
    },
    agy,
    errors,
  }
}
