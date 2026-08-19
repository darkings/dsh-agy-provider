import { redactText } from '../lib/agy/redact.js'
import { formatDoctorHuman, runDoctor } from '../lib/doctor.js'
import { Config } from '../lib/provider/config.js'

const argv = process.argv.slice(2)
const jsonOutput = argv.includes('--json')

let profile
const profileIdx = argv.indexOf('--profile')
if (profileIdx !== -1 && profileIdx + 1 < argv.length) {
  profile = argv[profileIdx + 1]
}

let dshHome
const dshHomeIdx = argv.indexOf('--dsh-home')
if (dshHomeIdx !== -1 && dshHomeIdx + 1 < argv.length) {
  dshHome = argv[dshHomeIdx + 1]
}

let dshBin
const dshBinIdx = argv.indexOf('--dsh-bin')
if (dshBinIdx !== -1 && dshBinIdx + 1 < argv.length) {
  dshBin = argv[dshBinIdx + 1]
}

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

let result
try {
  result = await runDoctor({
    config: Config(configInputFromEnvironment()),
    profile,
    dshHome,
    dshBin,
  })
} catch (error) {
  result = configFailure(error)
}

if (jsonOutput) console.log(JSON.stringify(result, null, 2))
else if (result.plugin === undefined) {
  console.log(`dsh-agy-provider doctor (schema v${result.schemaVersion})`)
  console.log(`status: FAIL; quotaUsed: ${result.quotaUsed}`)
  for (const issue of result.errors ?? []) console.log(`- [${issue.component}/${issue.code}] ${issue.message}`)
} else console.log(formatDoctorHuman(result))
process.exitCode = result.ok ? 0 : 1
