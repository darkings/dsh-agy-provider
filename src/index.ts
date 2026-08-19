/**
 * DSH bundle entry point.
 *
 * The bundle patch carries explicit ready defaults for DSH profile installs.
 * Keep the public programmatic Config schema safe for direct library callers;
 * BundleConfig is available when a caller explicitly wants bundle defaults.
 */
import type { Context } from '@deepseek-ai/cordis'
import { AgyAdapter } from './provider/agy.js'
import {
  BundleConfig,
  Config as ConfigSchema,
  createConfigSchema,
  type Config as ConfigType,
} from './provider/config.js'
import type { ModelConfig, ToolPolicy } from './provider/config.js'
import { MockAdapter } from './provider/mock.js'

export const name = 'dsh-agy-provider'
export const inject = ['llm']

/** Programmatic library default: enabled=false, toolPolicy=reject. */
export const Config = ConfigSchema
export { AgyAdapter, MockAdapter }
export { AgyModelDiscovery, mergeModelCatalog, parseAgyModels } from './agy/models.js'
export { diagnoseAgy } from './agy/diagnostics.js'
export { diagnoseProvider } from './diagnostics.js'
export { diagnoseProfile, runDoctor } from './doctor.js'
export { BundleConfig, ConfigSchema, createConfigSchema }
export type { DoctorOptions, DoctorResult, ProfileDiagnosticOptions, ProfileDiagnosticResult } from './doctor.js'
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
  ctx.llm.registerAdapter([provider], new AgyAdapter(config, {
    logger: record => logger.info('%s', JSON.stringify(record)),
  }))
}
