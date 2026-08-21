/**
 * DSH bundle entry point.
 *
 * The bundle patch carries explicit ready defaults for DSH profile installs.
 * Keep the public programmatic Config schema safe for direct library callers;
 * BundleConfig is available when a caller explicitly wants bundle defaults.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
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
import { configuredModels } from './provider/config.js'
import type { DshContextLookup } from './dsh/context.js'

export const name = 'dsh-agy-provider'
export const inject = ['llm']

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

export function apply(ctx: Context, config: ConfigType): void {
  // Settings panel: expose AGY as configurable provider (displayName follows DSH locale via Config i18n description)
  // The namespace is the plugin name; settingsPath [] means the whole section is the profile.
  try {
    ctx.llm.registerConfigurableProviders([{
      provider: 'agy',
      displayName: 'AGY',
      settingsNs: 'dsh-agy-provider',
      settingsPath: [],
    }])
  } catch {}
  try {
    ctx.llm.registerModelDiscovery('dsh-agy-provider', async (request) => {
      // If editing an existing agy route, prefer our already-known catalog; otherwise discover via AGY CLI.
      // request.provider being 'agy' or undefined both mean this plugin owns the draft.
      if (request.provider !== undefined && request.provider !== 'agy') return []
      const discovery = new AgyModelDiscovery({
        ...(config.agyPath?.trim() ? { executable: config.agyPath.trim() } : {}),
        ...(config.modelDiscoveryTtlMs === undefined ? {} : { ttlMs: config.modelDiscoveryTtlMs }),
        ...(config.modelDiscoveryTimeoutMs === undefined ? {} : { timeoutMs: config.modelDiscoveryTimeoutMs }),
      })
      const configured = configuredModels(config)
      const result = config.modelDiscovery === 'off'
        ? { models: configured, source: 'static' as const, stale: false }
        : await discovery.discover(configured)
      return result.models.map(m => ({
        id: m.id,
        ...(m.name === undefined ? {} : { name: m.name }),
        ...(m.contextWindow === undefined ? {} : { contextWindow: m.contextWindow }),
      }))
    })
  } catch {}

  if (config.enabled !== true) return
  const provider = config.provider ?? 'agy'
  if (provider === 'agy-mock') {
    ctx.llm.registerAdapter([provider], new MockAdapter(config))
    return
  }
  const logger = ctx.logger('dsh-agy-provider')
  // AttachmentStore is optional for the text-only path. Use the reflection
  // lookup instead of reading ctx.attachments directly: Cordis requires every
  // direct service property access to be declared in `inject`.
  const attachmentStore = ctx.get('attachments') as Pick<AttachmentStore, 'readImage'> | undefined
  ctx.llm.registerAdapter([provider], new AgyAdapter(config, {
    logger: record => logger.info('%s', JSON.stringify(record)),
    ...(attachmentStore === undefined ? {} : { attachmentStore }),
    dshContext: ctx as unknown as DshContextLookup,
  }))
}