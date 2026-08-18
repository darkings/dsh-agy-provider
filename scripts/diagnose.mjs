import { redactText } from '../lib/agy/redact.js'
import { diagnoseProvider } from '../lib/diagnostics.js'
import { Config } from '../lib/provider/config.js'

const jsonOutput = process.argv.slice(2).includes('--json')

function envValue(name) {
  const value = process.env[name]?.trim()
  return value === undefined || value.length === 0 ? undefined : value
}

function configInputFromEnvironment() {
  const input = {}
  const agyPath = envValue('AGY_PATH')
  const agent = envValue('AGY_AGENT')
  const minimumAgyVersion = envValue('AGY_MINIMUM_VERSION')
  const model = envValue('AGY_MODEL')
  if (agyPath !== undefined) input.agyPath = agyPath
  if (agent !== undefined) input.agent = agent
  if (minimumAgyVersion !== undefined) input.minimumAgyVersion = minimumAgyVersion
  if (model !== undefined) input.model = model

  const models = envValue('AGY_MODELS')
  if (models !== undefined) {
    const parsed = JSON.parse(models)
    if (!Array.isArray(parsed)) throw new TypeError('AGY_MODELS must be a JSON array')
    input.models = parsed
  }
  return input
}

function configFailure(error) {
  return {
    schemaVersion: 1,
    ok: false,
    quotaUsed: false,
    errors: [{
      component: 'config',
      code: 'CONFIG_INVALID',
      message: redactText(error instanceof Error ? error.message : String(error), 512),
    }],
  }
}

function printHuman(result) {
  console.log(`dsh-agy-provider diagnose (schema v${result.schemaVersion})`)
  console.log(`status: ${result.ok ? 'PASS' : 'FAIL'}; quotaUsed: ${result.quotaUsed}`)
  if (result.plugin !== undefined) {
    console.log(`plugin: ${result.plugin.name}@${result.plugin.version ?? 'unknown'}; enabled: ${result.plugin.enabled}`)
    console.log(`node: ${result.node.version} (${result.node.supported ? 'supported' : 'unsupported'})`)
    console.log(`dsh: cli=${result.dsh.cliVersion ?? 'unknown'}; llm=${result.dsh.llmContractVersion ?? 'unknown'}; bundle=${result.dsh.bundlePatchPresent ? 'present' : 'missing'}`)
    console.log(`provider: ${result.configuration.provider}; agent=${result.configuration.agent}; defaultModel=${result.configuration.defaultModel}`)
    console.log(`models: ${result.models.map(model => `${model.id} (${model.name})`).join(', ') || 'none'}`)
    console.log(`modelCatalog: source=${result.modelCatalog.source}; stale=${result.modelCatalog.stale}; warningCode=${result.modelCatalog.warningCode ?? 'none'}`)
    console.log(`agy: version=${result.agy.version ?? 'unknown'}; agents=${result.agy.agents.join(', ') || 'none'}; executableSource=${result.agy.executableSource}`)
  }
  if (result.errors.length > 0) {
    console.log('issues:')
    for (const issue of result.errors) console.log(`- [${issue.component}/${issue.code}] ${issue.message}`)
  }
}

let result
try {
  result = await diagnoseProvider({ config: Config(configInputFromEnvironment()) })
} catch (error) {
  result = configFailure(error)
}

if (jsonOutput) console.log(JSON.stringify(result, null, 2))
else printHuman(result)
process.exitCode = result.ok ? 0 : 1
