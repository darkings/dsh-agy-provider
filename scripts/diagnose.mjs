import { diagnoseAgy } from '../lib/agy/diagnostics.js'

const result = await diagnoseAgy({
  executable: process.env.AGY_PATH,
  expectedAgent: process.env.AGY_AGENT ?? 'deepseek-proxy',
  minimumVersion: process.env.AGY_MINIMUM_VERSION ?? '1.1.13',
  timeoutMs: 10_000,
})

console.log(JSON.stringify(result, null, 2))
process.exitCode = result.ok ? 0 : 1
