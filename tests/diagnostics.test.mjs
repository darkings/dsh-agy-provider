import assert from 'node:assert/strict'
import test from 'node:test'
import {
  diagnoseAgy,
  isAgyVersionAtLeast,
  parseAgyAgents,
  parseAgyVersion,
} from '../lib/agy/diagnostics.js'
import { redactText } from '../lib/agy/redact.js'

function result(stdoutLines, exitCode = 0) {
  return {
    exitCode,
    signal: null,
    termination: exitCode === 0 ? 'completed' : 'non-zero',
    stdoutLines,
    stderr: exitCode === 0 ? '' : 'diagnostic failure',
    durationMs: 1,
  }
}

test('diagnostic parsers handle AGY version and agent output', () => {
  assert.equal(parseAgyVersion('agy version 1.1.14\n'), '1.1.14')
  assert.deepEqual(parseAgyAgents('deepseek-proxy\n\nother.agent\n'), ['deepseek-proxy', 'other.agent'])
  assert.equal(isAgyVersionAtLeast('1.1.14', '1.1.13'), true)
  assert.equal(isAgyVersionAtLeast('1.1.12', '1.1.13'), false)
})

test('redactText removes credentials, environment values, and user paths', () => {
  const redacted = redactText([
    'Authorization: Bearer super-secret-token',
    'AGY_PATH=C:\\Users\\Jie\\.local\\bin\\agy.exe',
    'local path C:\\Users\\Jie\\Documents\\prompt.txt',
    'access_token=query-secret',
  ].join(' '))
  assert.doesNotMatch(redacted, /super-secret-token|query-secret|C:\\Users\\Jie/)
  assert.match(redacted, /\[REDACTED\]/)
  assert.match(redacted, /<user-path>/)
})

test('diagnoseAgy checks only version and agents without a model request', async () => {
  const calls = []
  const resultValue = await diagnoseAgy({
    executable: 'agy.exe',
    expectedAgent: 'deepseek-proxy',
    minimumVersion: '1.1.13',
    timeoutMs: 500,
    runCommand: async request => {
      calls.push(request)
      return request.args[0] === '--version'
        ? result(['agy 1.1.14'])
        : result(['deepseek-proxy'])
    },
  })

  assert.equal(resultValue.ok, true)
  assert.equal(resultValue.version, '1.1.14')
  assert.deepEqual(resultValue.agents, ['deepseek-proxy'])
  assert.deepEqual(calls.map(call => call.args), [['--version'], ['agents']])
  assert.equal(calls.some(call => call.args.includes('-p')), false)
})

test('diagnoseAgy reports incompatible version and missing Agent', async () => {
  const resultValue = await diagnoseAgy({
    executable: 'agy.exe',
    expectedAgent: 'deepseek-proxy',
    minimumVersion: '1.1.13',
    runCommand: async request => request.args[0] === '--version'
      ? result(['agy 1.0.0'])
      : result(['other-agent']),
  })

  assert.equal(resultValue.ok, false)
  assert.equal(resultValue.versionSupported, false)
  assert.equal(resultValue.agentAvailable, false)
  assert.match(resultValue.errors.join('\n'), /below the required minimum/)
  assert.match(resultValue.errors.join('\n'), /was not found/)
})
