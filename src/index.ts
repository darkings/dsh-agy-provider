/**
 * DSH bundle entry point.
 *
 * The bundle is disabled by default; tests can still select the deterministic
 * `agy-mock` route while the normal route uses the local AGY CLI.
 */
import type { Context } from '@deepseek-ai/cordis'
import { AgyAdapter } from './provider/agy.js'
import { Config as ConfigSchema, type Config as ConfigType } from './provider/config.js'
import type { ModelConfig } from './provider/config.js'
import { MockAdapter } from './provider/mock.js'

export const name = 'dsh-agy-provider'
export const inject = ['llm']

export const Config = ConfigSchema
export { AgyAdapter, MockAdapter }
export { diagnoseAgy } from './agy/diagnostics.js'
export { diagnoseProvider } from './diagnostics.js'
export type { ConfigType, ModelConfig }
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
