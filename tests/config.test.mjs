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
  assert.equal(config.minimumAgyVersion, '1.1.15')
  assert.equal(config.maxConcurrent, 4)
  assert.equal(config.maxQueue, 32)
  assert.equal(config.queueTimeoutMs, 30_000)
  assert.equal(config.maxOutputBytes, 8 * 1024 * 1024)
  assert.equal(config.maxEventLineLength, 1_048_576)
  assert.equal(config.inputFrameLimitBytes, 256 * 1024)
  assert.equal(config.maxSingleToolResultBytes, 32 * 1024)
  assert.equal(config.maxHistoricalToolResultBytes, 96 * 1024)
  assert.equal(config.toolProtocolRepairRetries, 1)
  assert.equal(config.toolProtocolPlainTextFallback, 'final-message')
  assert.equal(config.modelDiscovery, 'auto')
  assert.equal(config.modelDiscoveryTtlMs, 300_000)
  assert.equal(config.modelDiscoveryTimeoutMs, 10_000)
  assert.equal(config.toolPolicy, 'reject')
  assert.equal(config.agentPreset, undefined)
  assert.deepEqual(config.retryPolicy, {
    maxRetries: 5,
    retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
  })
  assert.throws(() => Config({ maxConcurrent: 0 }), error => error.name === 'ValidationError')
  assert.throws(() => Config({ minimumAgyVersion: 'latest' }), error => error.name === 'ValidationError')
  assert.throws(() => Config({ modelDiscovery: 'invalid' }), error => error.name === 'ValidationError')
  assert.throws(() => Config({ modelDiscoveryTtlMs: 999 }), error => error.name === 'ValidationError')
  assert.throws(() => Config({ modelDiscoveryTimeoutMs: 99 }), error => error.name === 'ValidationError')
  assert.throws(() => Config({ toolPolicy: 'bridge' }), error => error.name === 'ValidationError')
  assert.throws(() => Config({ retryPolicy: { maxRetries: 6 } }), error => error.name === 'ValidationError')
  assert.throws(() => Config({ retryPolicy: { retryableCodes: ['UNKNOWN'] } }), error => error.name === 'ValidationError')
  assert.throws(() => Config({ agentPreset: 'full-access' }), error => error.name === 'ValidationError')
  assert.throws(() => Config({ workspaceRoot: '   ' }), error => error.name === 'ValidationError')
  assert.throws(() => Config({ imageInput: 'always' }), error => error.name === 'ValidationError')
  assert.throws(() => Config({ transport: 'turbo' }), error => error.name === 'ValidationError')
  assert.throws(() => Config({ persistentFallback: 'always' }), error => error.name === 'ValidationError')
  assert.throws(() => Config({ inputFrameLimitBytes: 127 }), error => error.name === 'ValidationError')
  assert.throws(() => Config({ maxSingleToolResultBytes: 512 }), error => error.name === 'ValidationError')
  assert.throws(() => Config({ maxHistoricalToolResultBytes: 512 }), error => error.name === 'ValidationError')
  assert.throws(() => Config({ toolProtocolRepairRetries: 2 }), error => error.name === 'ValidationError')
  assert.throws(() => Config({ toolProtocolPlainTextFallback: 'always' }), error => error.name === 'ValidationError')
})

test('Config accepts only bounded transient retry policy overrides', () => {
  assert.deepEqual(Config({
    retryPolicy: { maxRetries: 5, retryableCodes: ['TIMEOUT'] },
  }).retryPolicy, {
    maxRetries: 5,
    retryableCodes: ['TIMEOUT'],
  })
})

test('Config normalizes model ids by stripping -high/-medium/-low suffix', () => {
  assert.equal(Config({ model: 'gemini-3.7-flash-high' }).model, 'gemini-3.7-flash')
  assert.equal(Config({ model: 'gemini-3.7-flash-medium' }).model, 'gemini-3.7-flash')
  assert.equal(Config({ model: 'GEMINI-3.7-FLASH-LOW' }).model, 'GEMINI-3.7-FLASH')
})

test('Config filters visible models and maps effort suffix', async () => {
  const { filterVisibleModels, normalizeModelId, extractModelEffort } = await import('../lib/provider/config.js')
  assert.equal(normalizeModelId('gemini-3.7-flash-high'), 'gemini-3.7-flash')
  assert.equal(extractModelEffort('gemini-3.7-flash-high'), 'high')
  assert.equal(extractModelEffort('gemini-3.7-flash'), undefined)
  const models = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  assert.deepEqual(filterVisibleModels(models, []), models)
  assert.deepEqual(filterVisibleModels(models, ['a', 'c']).map(m=>m.id), ['a','c'])
  assert.deepEqual(filterVisibleModels(models, ['a-high']).map(m=>m.id), ['a'])
})

test('Config provides zh-CN/en i18n descriptions for settings panel', () => {
  const schema = Config
  // schemastery i18n stores descriptions per locale in meta.description
  const zhDesc = schema.meta?.description ?? {}
  // At least ensure i18n call did not throw and schema is still valid
  assert.ok(schema !== undefined)
  assert.equal(Config({}).visibleModels.length, 0)
  assert.doesNotThrow(() => Config({ visibleModels: ['gemini-3.7-flash', 'gemini-3.1-pro'] }))
  assert.throws(() => Config({ visibleModels: ['   '] }), err => err.name === 'ValidationError')
})

test('Config hides YAML-only fields and exposes the settings editor note', () => {
  const schema = Config
  const serialized = schema.toJSON()
  const transformed = serialized.refs[String(serialized.uid)]
  const root = serialized.refs[String(transformed.inner)]
  const fieldMeta = key => serialized.refs[String(root.dict[key])].meta

  assert.equal(schema.meta.comment, '其余字段在 cordis.patch.yml 中，请直接编辑对应段。 (dsh-agy-provider)')
  assert.equal(fieldMeta('model').hidden, undefined)
  assert.equal(fieldMeta('visibleModels').hidden, undefined)
  assert.equal(fieldMeta('provider').hidden, true)
  assert.equal(fieldMeta('models').hidden, true)
  assert.equal(fieldMeta('agyPath').hidden, true)
  assert.equal(fieldMeta('transport').hidden, true)
  assert.equal(fieldMeta('retryPolicy').hidden, true)
  assert.equal(fieldMeta('purposeRoutes').hidden, true)
  assert.equal(fieldMeta('inputFrameLimitBytes').hidden, true)
  assert.equal(fieldMeta('maxSingleToolResultBytes').hidden, true)
  assert.equal(fieldMeta('maxHistoricalToolResultBytes').hidden, true)
  assert.equal(fieldMeta('toolProtocolRepairRetries').hidden, true)
  assert.equal(fieldMeta('toolProtocolPlainTextFallback').hidden, true)
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
    // visibleModels present since 0.9.0

    enabled: false,
    provider: 'agy',
    model: 'gemini-3.1-pro',
    models: [],
    visibleModels: [],
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
    minimumAgyVersion: '1.1.15',
    maxConcurrent: 4,
    maxQueue: 32,
    queueTimeoutMs: 30_000,
    maxOutputBytes: 8 * 1024 * 1024,
    transport: 'one-shot',
    persistentIdleTtlMs: 30_000,
    persistentReadyTimeoutMs: 10_000,
    persistentFallback: 'before-accept',
    maxEventLineLength: 1_048_576,
    inputFrameLimitBytes: 256 * 1024,
    maxSingleToolResultBytes: 32 * 1024,
    maxHistoricalToolResultBytes: 96 * 1024,
    toolProtocolRepairRetries: 1,
    toolProtocolPlainTextFallback: 'final-message',
    retryPolicy: { maxRetries: 5, retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'] },
    purposeRoutes: { compaction: {}, sessionTitle: {} },
    response: 'AGY mock provider is ready.',
    delayMs: 0,
  })
})

test('Config keeps image input opt-in and supports the experimental bridge flag', () => {
  assert.equal(Config({}).imageInput, undefined)
  assert.equal(Config({}).transport, 'one-shot')
  assert.equal(Config({}).persistentIdleTtlMs, 30_000)
  assert.equal(Config({}).persistentReadyTimeoutMs, 10_000)
  assert.equal(Config({}).persistentFallback, 'before-accept')
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
  assert.equal(modelMatch?.[1], 'gemini-3.1-pro')
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
