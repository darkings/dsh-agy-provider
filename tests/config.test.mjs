import assert from 'node:assert/strict'
import test from 'node:test'
import { Config, configuredModels } from '../lib/provider/config.js'
import {
  Config as ExportedConfig,
  BundleConfig as ExportedBundleConfig,
  ConfigSchema as ExportedConfigSchema,
} from '../lib/index.js'

test('Config applies safe M7 defaults and rejects invalid concurrency values', () => {
  const config = Config({})
  assert.equal(config.minimumAgyVersion, '1.1.13')
  assert.equal(config.maxConcurrent, 4)
  assert.equal(config.maxQueue, 32)
  assert.equal(config.queueTimeoutMs, 30_000)
  assert.equal(config.maxOutputBytes, 8 * 1024 * 1024)
  assert.equal(config.maxEventLineLength, 1_048_576)
  assert.equal(config.modelDiscovery, 'auto')
  assert.equal(config.modelDiscoveryTtlMs, 300_000)
  assert.equal(config.modelDiscoveryTimeoutMs, 10_000)
  assert.equal(config.toolPolicy, 'reject')
  assert.throws(() => Config({ maxConcurrent: 0 }), error => error.name === 'ValidationError')
  assert.throws(() => Config({ minimumAgyVersion: 'latest' }), error => error.name === 'ValidationError')
  assert.throws(() => Config({ modelDiscovery: 'invalid' }), error => error.name === 'ValidationError')
  assert.throws(() => Config({ modelDiscoveryTtlMs: 999 }), error => error.name === 'ValidationError')
  assert.throws(() => Config({ modelDiscoveryTimeoutMs: 99 }), error => error.name === 'ValidationError')
  assert.throws(() => Config({ toolPolicy: 'bridge' }), error => error.name === 'ValidationError')
})

test('Config accepts the explicit AGY-owned tool policy', () => {
  assert.equal(Config({ toolPolicy: 'agy-owned' }).toolPolicy, 'agy-owned')
})

test('Config accepts a multi-model catalog and preserves the legacy model fallback', () => {
  const config = Config({
    model: 'gemini-default',
    models: [
      { id: 'gemini-flash', name: 'Flash', contextWindow: 1_000_000 },
      { id: 'gemini-flash', name: 'Duplicate' },
    ],
  })

  assert.deepEqual(configuredModels(config), [
    { id: 'gemini-flash', name: 'Flash', contextWindow: 1_000_000 },
    { id: 'gemini-default' },
  ])
  assert.throws(() => Config({ models: [{ id: '  ' }] }), error => error.name === 'ValidationError')
})

test('cordis.patch.yml defines ready bundle defaults with agy-owned tool policy while library defaults remain inert', async () => {
  const fs = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const patchContent = await fs.readFile(fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)), 'utf8')

  // Parse simple YAML lines from cordis.patch.yml
  const idMatch = patchContent.match(/id:\s*([^\s]+)/)
  const enabledMatch = patchContent.match(/enabled:\s*(true|false)/)
  const toolPolicyMatch = patchContent.match(/toolPolicy:\s*([^\s]+)/)
  const providerMatch = patchContent.match(/provider:\s*([^\s]+)/)
  const modelMatch = patchContent.match(/model:\s*([^\s]+)/)
  const agentMatch = patchContent.match(/agent:\s*([^\s]+)/)
  const sessionModeMatch = patchContent.match(/sessionMode:\s*([^\s]+)/)

  assert.equal(idMatch?.[1], 'dsh-agy-provider')
  assert.equal(enabledMatch?.[1], 'true')
  assert.equal(toolPolicyMatch?.[1], 'agy-owned')
  assert.equal(providerMatch?.[1], 'agy')
  assert.equal(modelMatch?.[1], 'gemini-3.1-pro-high')
  assert.equal(agentMatch?.[1], 'deepseek-proxy')
  assert.equal(sessionModeMatch?.[1], 'full')

  // Verify library defaults are disabled and reject
  const libraryDefault = Config({})
  assert.equal(libraryDefault.enabled, false)
  assert.equal(libraryDefault.toolPolicy, 'reject')
})

test('public Config remains safe while BundleConfig exposes ready defaults', () => {
  assert.equal(ExportedConfig({}).enabled, false)
  assert.equal(ExportedConfig({}).toolPolicy, 'reject')
  assert.equal(ExportedBundleConfig({}).enabled, true)
  assert.equal(ExportedBundleConfig({}).toolPolicy, 'agy-owned')
  assert.equal(ExportedConfigSchema({}).enabled, false)
  assert.equal(ExportedConfigSchema({}).toolPolicy, 'reject')
})

test('package manifest exposes the doctor CLI with npm-normalized bin metadata', async () => {
  const fs = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const packageJson = JSON.parse(await fs.readFile(
    fileURLToPath(new URL('../package.json', import.meta.url)),
    'utf8',
  ))

  assert.deepEqual(packageJson.bin, {
    'dsh-agy-provider': 'bin/dsh-agy-provider.js',
  })
  assert.ok(packageJson.files.includes('bin/**/*.js'))
})
