import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AgyModelDiscovery,
  mergeModelCatalog,
  parseAgyModels,
} from '../lib/agy/models.js'

function result(stdoutLines, exitCode = 0) {
  return {
    exitCode,
    signal: null,
    termination: exitCode === 0 ? 'completed' : 'non-zero',
    stdoutLines,
    stderr: exitCode === 0 ? '' : 'discovery failed',
    durationMs: 1,
  }
}

test('parseAgyModels accepts tab-separated ids and ignores unsafe/duplicate rows', () => {
  assert.deepEqual(parseAgyModels([
    'gemini-3.7-flash-high\tGemini 3.7 Flash High',
    'gemini-3.7-flash-high\tDuplicate',
    'bad model\tInvalid',
    'id\tDisplay Name',
    'claude-sonnet-4-6',
    'unsafe\u0000label\tInvalid',
  ].join('\n')), [
    { id: 'gemini-3.7-flash-high', name: 'Gemini 3.7 Flash High' },
    { id: 'claude-sonnet-4-6' },
  ])
})

test('mergeModelCatalog preserves configured order and metadata precedence', () => {
  assert.deepEqual(mergeModelCatalog([
    { id: 'configured', name: 'Configured Name' },
    { id: 'fallback' },
  ], [
    { id: 'configured', name: 'AGY Name', description: 'AGY Description' },
    { id: 'discovered', name: 'Discovered Name' },
  ]), [
    { id: 'configured', name: 'Configured Name', description: 'AGY Description' },
    { id: 'fallback' },
    { id: 'discovered', name: 'Discovered Name' },
  ])
})

test('AgyModelDiscovery uses TTL cache and single-flight refreshes', async () => {
  let now = 0
  let calls = 0
  let release
  const gate = new Promise(resolve => { release = resolve })
  const discovery = new AgyModelDiscovery({
    ttlMs: 1_000,
    timeoutMs: 100,
    now: () => now,
    runCommand: async request => {
      calls += 1
      assert.deepEqual(request.args, ['models'])
      await gate
      return result(['gemini-live\tGemini Live'])
    },
  })

  const first = discovery.discover([{ id: 'configured' }])
  const second = discovery.discover([{ id: 'configured' }])
  assert.equal(calls, 1)
  release()
  const [firstResult, secondResult] = await Promise.all([first, second])
  assert.equal(firstResult.source, 'merged')
  assert.equal(secondResult.source, 'merged')

  const discoveredOnly = new AgyModelDiscovery({
    runCommand: async () => result(['gemini-live\tGemini Live']),
  })
  assert.equal((await discoveredOnly.discover([])).source, 'discovered')

  now = 500
  const cached = await discovery.discover([{ id: 'configured' }])
  assert.equal(cached.source, 'cache')
  assert.equal(calls, 1)
})

test('AgyModelDiscovery fails open to static catalog and stale cache', async () => {
  let now = 0
  let calls = 0
  const discovery = new AgyModelDiscovery({
    ttlMs: 100,
    timeoutMs: 100,
    now: () => now,
    runCommand: async () => {
      calls += 1
      return calls === 1
        ? result(['gemini-live\tGemini Live'])
        : result([], 1)
    },
  })
  const configured = [{ id: 'configured' }]

  const discovered = await discovery.discover(configured)
  assert.equal(discovered.source, 'merged')
  now = 101
  const stale = await discovery.discover(configured)
  assert.equal(stale.source, 'cache')
  assert.equal(stale.stale, true)
  assert.equal(stale.warning, 'AGY model discovery command failed')
  assert.equal(stale.warningCode, 'MODEL_DISCOVERY_FAILED')
  assert.deepEqual(stale.models.map(model => model.id), ['configured', 'gemini-live'])

  const fallback = new AgyModelDiscovery({
    runCommand: async () => result([], 1),
  })
  const fallbackResult = await fallback.discover(configured)
  assert.equal(fallbackResult.source, 'fallback')
  assert.equal(fallbackResult.stale, true)
  assert.equal(fallbackResult.warningCode, 'MODEL_DISCOVERY_FAILED')
  assert.deepEqual(fallbackResult.models, configured)
})

test('AgyModelDiscovery exposes stable timeout and output-limit warning codes', async () => {
  const timeout = new AgyModelDiscovery({
    runCommand: async () => ({
      exitCode: null,
      signal: null,
      termination: 'timeout',
      stdoutLines: [],
      stderr: '',
      durationMs: 1,
    }),
  })
  const outputLimit = new AgyModelDiscovery({
    runCommand: async () => ({
      exitCode: null,
      signal: null,
      termination: 'output-limit',
      stdoutLines: [],
      stderr: '',
      durationMs: 1,
    }),
  })

  assert.equal((await timeout.discover([])).warningCode, 'MODEL_DISCOVERY_TIMEOUT')
  assert.equal((await outputLimit.discover([])).warningCode, 'MODEL_DISCOVERY_OUTPUT_LIMIT')
})
