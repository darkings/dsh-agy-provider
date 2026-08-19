import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { dirname, join, parse } from 'node:path'

const DSH_PACKAGE = '@deepseek-ai/dsh@0.1.0-rc.7'
const PROVIDER_SPEC = process.env.DSH_SMOKE_PROVIDER_SPEC?.trim()
const COMMAND_TIMEOUT_MS = 10 * 60_000
const OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024
const DISABLED_TOOL_ENTRIES = [
  'session-title',
  'session-title-llm',
  'agent-instructions',
  'skill',
  'skill-filesystem',
  'tool-skill',
  'commands',
  'command-feedback',
  'goal',
  'goal-round-driver',
  'command-goal',
  'plan-mode',
  'compaction-basic',
  'command-compact',
  'tool-bash',
  'tool-pwsh',
  'tool-jobs',
  'fs-observation-policy',
  'tool-fs',
  'tool-fs-search',
  'subagent',
  'subagent-spawn-in-process',
  'subagent-fork-in-process',
  'tool-subagent-control',
  'tool-subagent-list-agents',
  'tool-subagent',
  'tool-subagent-fork',
  'tool-subagent-report',
  'workflow-worker-thread',
  'tool-workflow',
  'tool-todo',
  'tool-goal',
  'tool-ralph',
  'tool-str-replace-editor',
  'repeat-tool-reminder',
  'web',
  'web-search-deepseek',
  'tool-web',
]

function resolveNpmCli() {
  const configured = process.env.npm_execpath?.trim()
  if (configured !== undefined && configured.length > 0 && existsSync(configured)) return configured
  const candidate = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (existsSync(candidate)) return candidate
  throw new Error('NPM_CLI_NOT_FOUND')
}

function killTree(child) {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    })
    killer.once('error', () => child.kill())
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

function runCommand(executable, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS
  const cwd = options.cwd ?? process.cwd()
  const env = { ...process.env, ...(options.env ?? {}) }
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let outputBytes = 0
    let timedOut = false
    let settled = false
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, timeoutMs)
    const finish = value => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      outputBytes += Buffer.byteLength(chunk, 'utf8')
      if (outputBytes <= OUTPUT_LIMIT_BYTES) stdout += chunk
    })
    child.stderr.on('data', chunk => {
      if (Buffer.byteLength(stderr, 'utf8') <= OUTPUT_LIMIT_BYTES) stderr += chunk
    })
    child.once('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(Object.assign(new Error('COMMAND_SPAWN_FAILED'), { cause: error }))
    })
    child.once('close', (exitCode, signal) => finish({ exitCode, signal, timedOut, stdout, stderr }))
  })
}

function assertSuccess(result, code) {
  if (result.timedOut || result.exitCode !== 0) {
    const error = new Error(code)
    error.detail = result.stderr.slice(-2000)
    throw error
  }
}

function runNode(entry, args, options) {
  return runCommand(process.execPath, [entry, ...args], options)
}

function runNpm(args, options) {
  return runNode(resolveNpmCli(), args, options)
}

function smokeTempParent() {
  const configured = process.env.DSH_SMOKE_TEMP_ROOT?.trim()
  if (configured !== undefined && configured.length > 0) return configured
  return process.platform === 'win32' ? parse(process.cwd()).root : process.env.TEMP ?? process.cwd()
}

function disabledEntriesPatch() {
  return DISABLED_TOOL_ENTRIES.map(id => `- id: ${id}\n  disabled: true`).join('\n')
}

async function main() {
  const workDir = await mkdtemp(join(smokeTempParent(), 'dsh-agy-provider-v7-tool-bridge-'))
  const isolatedHome = join(workDir, 'dsh-home')
  const installRoot = join(workDir, 'dsh-install')
  const providerTarballDir = join(workDir, 'provider-tarball')
  const fixtureWorkspace = join(workDir, 'fixture-workspace')
  const markerPath = join(workDir, 'tool-marker.json')
  const patchPath = join(workDir, 'bridge.patch.yml')
  const dshEnv = {
    DSH_HOME: isolatedHome,
    DSH_PERMISSION_MODE: 'danger-full-access',
    DSH_FIXTURE_MARKER: markerPath,
  }
  try {
    await mkdir(providerTarballDir, { recursive: true })
    await mkdir(fixtureWorkspace, { recursive: true })
    await writeFile(join(fixtureWorkspace, 'fixture.txt'), 'disposable fixture\n', 'utf8')

    let providerSource = PROVIDER_SPEC
    if (providerSource === undefined) {
      await runNpm(['pack', '--ignore-scripts', '--pack-destination', providerTarballDir], {
        cwd: process.cwd(),
      }).then(result => assertSuccess(result, 'PROVIDER_PACK_FAILED'))
      const tarballs = (await readdir(providerTarballDir)).filter(name => name.endsWith('.tgz'))
      if (tarballs.length !== 1) throw new Error('PROVIDER_TARBALL_NOT_FOUND')
      providerSource = join(providerTarballDir, tarballs[0])
    }

    await runNpm([
      'install', '--prefix', installRoot, '--no-package-lock', '--ignore-scripts', '--prefer-offline',
      '--no-audit', '--no-fund', DSH_PACKAGE,
    ], { cwd: process.cwd() }).then(result => assertSuccess(result, 'DSH_INSTALL_FAILED'))
    const dshEntry = join(installRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    if (!existsSync(dshEntry)) throw new Error('DSH_ENTRY_NOT_FOUND')

    await runNode(dshEntry, ['plugin', '--profile', 'headless', 'add', providerSource], {
      cwd: installRoot,
      env: dshEnv,
    }).then(result => assertSuccess(result, 'DSH_PLUGIN_ADD_FAILED'))

    const fixturePlugin = pathToFileURL(join(process.cwd(), 'tests', 'fixtures', 'dsh-tool-bridge-fixture.mjs')).href
    const patch = `
- id: agent-default-model
  config:
    provider: agy
    model: gemini-3.7-flash-low
- id: dsh-agy-provider
  config:
    enabled: true
    provider: agy
    model: gemini-3.7-flash-low
    agent: dsh-agy-tool-free
    modelDiscovery: off
    toolPolicy: dsh-owned
    sessionMode: full
- id: approval
  config:
    policy: never
${disabledEntriesPatch()}
- insert:
    - id: dsh-tool-bridge-fixture
      name: '${fixturePlugin}'
`
    await writeFile(patchPath, patch, 'utf8')

    const task = 'Call the fixture_probe tool exactly once with value bridge. After DSH executes it, report the marker FIXTURE_PROBE_EXECUTED and do not call any other tool.'
    const result = await runNode(dshEntry, ['--profile', 'headless', '--patch', patchPath, task], {
      cwd: fixtureWorkspace,
      env: dshEnv,
    })
    assertSuccess(result, 'DSH_TOOL_BRIDGE_REQUEST_FAILED')
    if (!result.stdout.includes('FIXTURE_PROBE_EXECUTED')) throw new Error('DSH_TOOL_RESULT_NOT_VISIBLE')
    if (!existsSync(markerPath)) throw new Error('DSH_TOOL_WAS_NOT_EXECUTED')
    const marker = JSON.parse(await readFile(markerPath, 'utf8'))
    if (marker.value !== 'bridge' || marker.executedBy !== 'dsh-tool-runtime') throw new Error('DSH_TOOL_MARKER_MISMATCH')

    process.stdout.write(JSON.stringify({
      schemaVersion: 1,
      experiment: 'v7-m2b-disposable-dsh-tool-runtime',
      // This smoke configures the real AGY-backed Provider. Keep the report
      // honest: the fixture tool is disposable, but the model request is not
      // quota-free. No raw prompt, response, credential, or token payload is
      // persisted.
      quotaUsed: true,
      toolExecution: 'dsh-tool-runtime',
      toolCalls: 1,
      toolName: 'fixture_probe',
      toolResultObserved: true,
      providerStructuredSchema: false,
      agyInternalTools: false,
      cleanup: 'completed',
    }) + '\n')
  } catch (error) {
    if (error?.detail !== undefined) process.stderr.write(`${error.message}\n${error.detail}\n`)
    throw error
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

try {
  await main()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'DSH_TOOL_BRIDGE_SMOKE_FAILED'}\n`)
  process.exitCode = 1
}
