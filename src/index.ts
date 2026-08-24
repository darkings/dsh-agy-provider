/**
 * DSH bundle entry point.
 *
 * The bundle patch carries explicit ready defaults for DSH profile installs.
 * Keep the public programmatic Config schema safe for direct library callers;
 * BundleConfig is available when a caller explicitly wants bundle defaults.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
// @ts-ignore - dsh-settings is a peer provided by DSH runtime
import { settingsNamespace, type SettingsProvider } from '@deepseek-ai/dsh-settings'
import { AgyAdapter } from './provider/agy.js'
import {
  BundleConfig,
  Config as ConfigSchema,
  createConfigSchema,
  type Config as ConfigType,
} from './provider/config.js'
import type { ModelConfig, ToolPolicy } from './provider/config.js'
import { MockAdapter } from './provider/mock.js'
import { AgyModelDiscovery } from './agy/models.js'
import { appendAgyDiagnosticRecord } from './agy/log.js'
import { configuredModels } from './provider/config.js'
import type { DshContextLookup } from './dsh/context.js'

export const name = 'dsh-agy-provider'
export const inject = ['llm', 'settings']

/** Programmatic library default: enabled=false, toolPolicy=reject. */
export const Config = ConfigSchema
export { AgyAdapter, MockAdapter }
export { AgyModelDiscovery, mergeModelCatalog, parseAgyModels } from './agy/models.js'
export { diagnoseAgy } from './agy/diagnostics.js'
export { diagnoseProvider } from './diagnostics.js'
export { DshContextError, diagnoseDshContext, readDshContextServices, resolveDshContext } from './dsh/context.js'
export {
  appendToolProtocolPrompt,
  createStructuredToolProtocol,
  parseStructuredEnvelope,
  renderToolProtocolPrompt,
  StructuredResponseAccumulator,
  ToolProtocolError,
  TOOL_PROTOCOL_LIMITS,
} from './provider/tool-protocol.js'
export { stageToolSchema } from './provider/tool-schema-file.js'
export type {
  DshApprovalPolicy,
  DshApprovalServiceLike,
  DshContextLookup,
  DshContextServices,
  DshContextSnapshot,
  DshContextState,
  DshContextErrorCode,
  DshContextDiagnostic,
  DshPermissionPreset,
  DshPermissionPresetServiceLike,
  DshSandboxMode,
  DshSandboxPolicyLike,
  DshServiceAvailability,
  DshSessionLike,
  DshSessionState,
  DshSessionStoreLike,
  DshWorkspaceLike,
  DshWorkspaceRegistryLike,
  DshWorkspaceState,
} from './dsh/context.js'
export type {
  StructuredEnvelope,
  StructuredToolProtocol,
  ToolProtocolErrorCode,
} from './provider/tool-protocol.js'
export type { StagedToolSchema } from './provider/tool-schema-file.js'
export { diagnoseProfile, runDoctor } from './doctor.js'
export {
  AgyImageBridgeError,
  DEFAULT_IMAGE_MAX_BYTES,
  DEFAULT_IMAGE_MAX_COUNT,
  IMAGE_MEDIA_TYPES,
  prepareAgyPrompts,
} from './provider/image-bridge.js'
export {
  AGENT_PRESET_IDS,
  getAgentPreset,
  listAgentPresets,
  readAgentPresetTemplate,
  requireAgentPreset,
} from './agent-presets.js'
export {
  DEFAULT_AGENT_DIRECTORY,
  AgentInstallError,
  describeAgentPresets,
  installAgentPreset,
  isAgentPreset,
} from './agent-installer.js'
export { formatAgentsHelp, runAgentsCli } from './agents-cli.js'
export { BundleConfig, ConfigSchema, createConfigSchema }
export type {
  DoctorOptions,
  DoctorResult,
  EffectiveBridgeCapability,
  EffectiveDshContext,
  ProfileDiagnosticOptions,
  ProfileDiagnosticResult,
} from './doctor.js'
export type {
  AgentExecutionMode,
  AgentPreset,
  AgentPresetId,
} from './agent-presets.js'
export type {
  AgentDirectoryEntry,
  AgentInstallAction,
  AgentInstallOptions,
  AgentInstallResult,
} from './agent-installer.js'
export type {
  AgyImageAttachmentStore,
  AgyImageBridgeErrorCode,
  AgyImageMediaType,
  ImageBridgeOptions,
  PreparedAgyPrompts,
} from './provider/image-bridge.js'
export type { ConfigType, ModelConfig, ToolPolicy }
export interface Config extends ConfigType {}

function resolveSettingsConfig(ctx: Context, config: ConfigType): ConfigType {
  const settings = ctx.get('settings') as SettingsProvider | undefined
  if (settings !== undefined) {
    return settings.register(settingsNamespace('dsh-agy-provider'), ConfigSchema, {
      base: config,
      applies: 'restart',
    }).get()
  }

  // Direct library callers may compose only the LLM service. Keep the plugin
  // usable there while registering the settings section if the service appears
  // later in a full DSH composition.
  try {
    ctx.inject(['settings'], settingsCtx => {
      const lateSettings: SettingsProvider = settingsCtx.settings
      lateSettings.register(settingsNamespace('dsh-agy-provider'), ConfigSchema, {
        base: config,
        applies: 'restart',
      })
    })
  } catch {}
  return config
}

export function apply(ctx: Context, config: ConfigType): void {
  const activeConfig = resolveSettingsConfig(ctx, config)
  const modelDiscovery = activeConfig.modelDiscovery === 'off' ? undefined : new AgyModelDiscovery({
    ...(activeConfig.agyPath?.trim() ? { executable: activeConfig.agyPath.trim() } : {}),
    ...(activeConfig.modelDiscoveryTtlMs === undefined ? {} : { ttlMs: activeConfig.modelDiscoveryTtlMs }),
    ...(activeConfig.modelDiscoveryTimeoutMs === undefined ? {} : { timeoutMs: activeConfig.modelDiscoveryTimeoutMs }),
  })
  // Settings panel: expose the local AGY CLI as the Antigravity CLI provider.
  // The namespace is the plugin name; settingsPath [] means the whole section is the profile.
  try {
    ctx.llm.registerConfigurableProviders([{
      provider: 'agy',
      displayName: 'Antigravity CLI',
      settingsNs: 'dsh-agy-provider',
      settingsPath: [],
    }])
  } catch {}
  try {
    ctx.llm.registerModelDiscovery('dsh-agy-provider', async (request) => {
      // If editing an existing agy route, prefer our already-known catalog; otherwise discover via AGY CLI.
      // request.provider being 'agy' or undefined both mean this plugin owns the draft.
      if (request.provider !== undefined && request.provider !== 'agy') return []
      const configured = configuredModels(activeConfig)
      const result = activeConfig.modelDiscovery === 'off'
        ? { models: configured, source: 'static' as const, stale: false }
        : await modelDiscovery!.discover(configured)
      return result.models.map(m => ({
        id: m.id,
        ...(m.name === undefined ? {} : { name: m.name }),
        ...(m.contextWindow === undefined ? {} : { contextWindow: m.contextWindow }),
      }))
    })
  } catch {}

  // Settings are resolved before the enabled check, so disabled profiles can
  // still be edited from the configuration surface.
  if (activeConfig.enabled !== true) return
  const provider = activeConfig.provider ?? 'agy'
  if (provider === 'agy-mock') {
    ctx.llm.registerAdapter([provider], new MockAdapter(activeConfig))
    return
  }
  const logger = ctx.logger('dsh-agy-provider')
  // AttachmentStore is optional for the text-only path. Use the reflection
  // lookup instead of reading ctx.attachments directly: Cordis requires every
  // direct service property access to be declared in `inject`.
  ctx.llm.registerAdapter([provider], new AgyAdapter(activeConfig, {
    logger: record => {
      try {
        logger.info('%s', JSON.stringify(record))
      } finally {
        appendAgyDiagnosticRecord(record)
      }
    },
    // Resolve lazily because attachments is optional and can be composed after
    // this plugin. Text-only requests remain independent of the service.
    resolveAttachmentStore: () => ctx.get('attachments') as Pick<AttachmentStore, 'readImage'> | undefined,
    dshContext: ctx as unknown as DshContextLookup,
  }))
}
