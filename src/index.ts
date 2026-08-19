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
import type { DshContextLookup } from './dsh/context.js'

export const name = 'dsh-agy-provider'
export const inject = ['llm']

/** Programmatic library default: enabled=false, toolPolicy=reject. */
export const Config = ConfigSchema
export { AgyAdapter, MockAdapter }
export { AgyModelDiscovery, mergeModelCatalog, parseAgyModels } from './agy/models.js'
export { diagnoseAgy } from './agy/diagnostics.js'
export { diagnoseProvider } from './diagnostics.js'
export { DshContextError, readDshContextServices, resolveDshContext } from './dsh/context.js'
export type {
  DshApprovalPolicy,
  DshApprovalServiceLike,
  DshContextLookup,
  DshContextServices,
  DshContextSnapshot,
  DshContextState,
  DshContextErrorCode,
  DshPermissionPresetServiceLike,
  DshSandboxMode,
  DshSandboxPolicyLike,
  DshSessionLike,
  DshSessionState,
  DshSessionStoreLike,
  DshWorkspaceLike,
  DshWorkspaceRegistryLike,
  DshWorkspaceState,
} from './dsh/context.js'
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
export type { DoctorOptions, DoctorResult, ProfileDiagnosticOptions, ProfileDiagnosticResult } from './doctor.js'
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
