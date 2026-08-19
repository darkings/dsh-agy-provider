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
  assert.equal(config.agentPreset, undefined)
  assert.deepEqual(config.retryPolicy, {
    maxRetries: 0,
    retryableCodes: ['RATE_LIMIT', 'SERVER', 'TRANSPORT'],
  })
  assert.throws(() => Config({ maxConcurrent: 0 }), error => error.name === 'ValidationError')
  assert.throws(() => Config({ minimumAgyVersion: 'latest' }), error => error.name === 'ValidationError')
  assert.throws(() => Config({ modelDiscovery: 'invalid' }), error => error.name === 'ValidationError')
  assert.throws(() => Config({ modelDiscoveryTtlMs: 999 }), error => error.name === 'ValidationError')
  assert.throws(() => Config({ modelDiscoveryTimeoutMs: 99 }), error => error.name === 'ValidationError')
  assert.throws(() => Config({ toolPolicy: 'bridge' }), error => error.name === 'ValidationError')
  assert.throws(() => Config({ retryPolicy: { maxRetries: 3 } }), error => error.name === 'ValidationError')
  assert.throws(() => Config({ retryPolicy: { retryableCodes: ['TIMEOUT'] } }), error => error.name === 'ValidationError')
  assert.throws(() => Config({ agentPreset: 'full-access' }), error => error.name === 'ValidationError')
  assert.throws(() => Config({ workspaceRoot: '   ' }), error => error.name === 'ValidationError')
  assert.throws(() => Config({ imageInput: 'always' }), error => error.name === 'ValidationError')
})

test('Config accepts only bounded transient retry policy overrides', () => {
  assert.deepEqual(Config({
    retryPolicy: { maxRetries: 2, retryableCodes: ['RATE_LIMIT'] },
  }).retryPolicy, {
    maxRetries: 2,
    retryableCodes: ['RATE_LIMIT'],
  })
})

test('Config accepts optional purpose-specific route overrides', () => {
  const config = Config({
    purposeRoutes: {
      compaction: {
        model: 'gemini-3.7-flash-low',
        reasoningEffort: 'low',
      },
      sessionTitle: {
        agent: 'deepseek-proxy',
      },
    },
  })
  assert.deepEqual(config.purposeRoutes, {
    compaction: {
      model: 'gemini-3.7-flash-low',
      reasoningEffort: 'low',
    },
    sessionTitle: {
      agent: 'deepseek-proxy',
    },
  })
  assert.throws(() => Config({
    purposeRoutes: { compaction: { reasoningEffort: 'turbo' } },
  }), error => error.name === 'ValidationError')
})

test('Config accepts explicit Agent capability presets and workspace roots', () => {
  assert.deepEqual(Config({
    agentPreset: 'workspace-write',
    workspaceRoot: 'C:\\workspace',
  }), {
    enabled: false,
    provider: 'agy',
    model: 'gemini-3.1-pro-high',
    models: [],
    modelDiscovery: 'auto',
    modelDiscoveryTtlMs: 300_000,
    modelDiscoveryTimeoutMs: 10_000,
    toolPolicy: 'reject',
    agent: 'deepseek-proxy',
    agentPreset: 'workspace-write',
    workspaceRoot: 'C:\\workspace',
    agyPath: '',
    timeoutMs: 120_000,
    sessionMode: 'full',
    minimumAgyVersion: '1.1.13',
    maxConcurrent: 4,
    maxQueue: 32,
    queueTimeoutMs: 30_000,
    maxOutputBytes: 8 * 1024 * 1024,
    maxEventLineLength: 1_048_576,
    retryPolicy: { maxRetries: 0, retryableCodes: ['RATE_LIMIT', 'SERVER', 'TRANSPORT'] },
    purposeRoutes: { compaction: {}, sessionTitle: {} },
    response: 'AGY mock provider is ready.',
    delayMs: 0,
  })
})

test('Config keeps image input opt-in and supports the experimental bridge flag', () => {
  assert.equal(Config({}).imageInput, undefined)
  assert.equal(Config({ imageInput: 'experimental' }).imageInput, 'experimental')
})

test('Config accepts the explicit AGY-owned and DSH-owned tool policies', () => {
  assert.equal(Config({ toolPolicy: 'agy-owned' }).toolPolicy, 'agy-owned')
  assert.equal(Config({ toolPolicy: 'dsh-owned' }).toolPolicy, 'dsh-owned')
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

test('cordis.patch.yml defines DSH-owned bundle defaults while library defaults remain inert', async () => {
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
  assert.equal(toolPolicyMatch?.[1], 'dsh-owned')
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
  assert.equal(ExportedBundleConfig({}).toolPolicy, 'dsh-owned')
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
  assert.ok(packageJson.files.includes('agents/**/*.md'))
})
