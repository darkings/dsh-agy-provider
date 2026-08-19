import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { parse, join, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const DSH_PACKAGE = '@deepseek-ai/dsh@0.1.0-rc.7'
const COMMAND_TIMEOUT_MS = 3 * 60_000
const OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024
const SCENARIOS = [
  { name: 'read', permissionMode: 'read-only', target: 'read-target.txt', expected: 'read-success' },
  { name: 'write', permissionMode: 'read-only', target: 'write-target.txt', expected: 'write-denied' },
  { name: 'write', permissionMode: 'workspace-write', target: 'write-target.txt', expected: 'write-success' },
  { name: 'write-outside', permissionMode: 'workspace-write', target: 'outside-target.txt', expected: 'write-denied' },
  { name: 'write-outside', permissionMode: 'danger-full-access', target: 'outside-target.txt', expected: 'write-success-outside' },
  { name: 'write-escalate', permissionMode: 'workspace-write', target: null, expected: 'approval-denied' },
  { name: 'edit', permissionMode: 'read-only', target: 'edit-target.txt', expected: 'edit-denied' },
  { name: 'edit', permissionMode: 'workspace-write', target: 'edit-target.txt', expected: 'edit-success' },
  { name: 'glob', permissionMode: 'read-only', target: null, expected: 'search-success' },
  { name: 'grep', permissionMode: 'read-only', target: null, expected: 'search-success' },
  { name: 'web-fetch', permissionMode: 'read-only', target: null, expected: 'web-success' },
  { name: 'mcp', permissionMode: 'read-only', target: null, expected: 'mcp-success' },
  { name: 'shell', permissionMode: 'workspace-write', target: null, expected: 'shell-cwd' },
  { name: 'shell-write', permissionMode: 'read-only', target: 'shell-target.txt', expected: 'write-denied' },
  { name: 'shell-write', permissionMode: 'workspace-write', target: 'shell-target.txt', expected: 'write-success' },
]

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
  ...(process.platform === 'win32' ? ['tool-bash'] : ['tool-pwsh']),
  'tool-fs-search',
  'tool-jobs',
  'fs-observation-policy',
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
    error.detail = `${result.stderr.slice(-2000)}\n${result.stdout.slice(-2000)}`
    throw error
  }
}

function runNode(entry, args, options) {
  return runCommand(process.execPath, [entry, ...args], options)
}

function runNpm(args, options) {
  return runNode(resolveNpmCli(), args, options)
}

async function findCachedDshEntry() {
  const cacheRoots = [
    process.env.npm_config_cache,
    process.env.NPM_CONFIG_CACHE,
    process.env.LOCALAPPDATA === undefined ? undefined : join(process.env.LOCALAPPDATA, 'npm-cache'),
  ].filter(value => typeof value === 'string' && value.length > 0)
  for (const cacheRoot of cacheRoots) {
    const npxRoot = join(cacheRoot, '_npx')
    if (!existsSync(npxRoot)) continue
    for (const entry of await readdir(npxRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dshEntry = join(npxRoot, entry.name, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      const packageJson = join(npxRoot, entry.name, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
      if (!existsSync(dshEntry) || !existsSync(packageJson)) continue
      const packageInfo = JSON.parse(await readFile(packageJson, 'utf8'))
      if (packageInfo.version === '0.1.0-rc.7') return dshEntry
    }
  }
  return undefined
}

function smokeTempParent() {
  const configured = process.env.DSH_SMOKE_TEMP_ROOT?.trim()
  if (configured !== undefined && configured.length > 0) return configured
  return process.platform === 'win32' ? parse(process.cwd()).root : process.env.TEMP ?? process.cwd()
}

function disabledEntriesPatch() {
  return DISABLED_TOOL_ENTRIES.map(id => `- id: ${id}\n  disabled: true`).join('\n')
}

function patchForFixture(fixturePath, webFixturePath, mcpServerPath) {
  const quote = value => value.replaceAll("'", "''")
  return `
- id: agent-default-model
  config:
    provider: fixture
    model: fixture-model
${disabledEntriesPatch()}
- id: tool-web
  config:
    fetch: true
- insert:
    - id: dsh-web-runtime-fixture
      name: '@deepseek-ai/dsh-web'
    - id: dsh-web-local-provider-fixture
      name: '${webFixturePath}'
    - id: dsh-mcp-client-fixture
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: matrix
        command: '${quote(process.execPath)}'
        args:
          - '${quote(mcpServerPath)}'
        cwd: '${quote(dirname(mcpServerPath))}'
        toolCallTimeoutMs: 10000
        failOnStartupError: true
    - id: dsh-capability-model-fixture
      name: '${fixturePath}'
`
}

function scenarioEnv(workspaceDir, scenario, outsidePath, shellPath, webUrl) {
  return {
    DSH_HOME: join(workspaceDir, '.dsh-home'),
    DSH_PERMISSION_MODE: scenario.permissionMode,
    DSH_CAPABILITY_SCENARIO: scenario.name,
    DSH_CAPABILITY_OUTSIDE_PATH: outsidePath,
    DSH_CAPABILITY_SHELL_PATH: shellPath,
    DSH_CAPABILITY_WEB_URL: webUrl,
  }
}

function classifyScenario(scenario, result, workspaceDir, outsidePath, shellPath) {
  const roundTripObserved = result.stdout.includes(`DSH_CAPABILITY_${scenario.name.toUpperCase()}_RESULT`)
  const targetPath = scenario.target === null ? null : join(workspaceDir, scenario.target)
  const targetExists = targetPath !== null && existsSync(targetPath)
  const outsideExists = existsSync(outsidePath)
  const shellExists = existsSync(shellPath)
  const workspaceMentioned = result.stdout.toLowerCase().includes(workspaceDir.toLowerCase())
  const approvalMentioned = `${result.stdout}\n${result.stderr}`.toLowerCase()
    .match(/approval|permission|sandbox|denied|escalat/) !== null
  return {
    scenario: scenario.name,
    permissionMode: scenario.permissionMode,
    expected: scenario.expected,
    roundTripObserved,
    targetExists,
    outsideExists,
    shellExists,
    workspaceMentioned,
    approvalMentioned,
    webContentObserved: result.stdout.includes('LOCAL_WEB_MATRIX_SUCCESS'),
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

async function assertObservation(observation, workspaceDir, outsidePath, shellPath) {
  if (!observation.roundTripObserved && observation.expected !== 'approval-denied') {
    throw new Error(`DSH_TOOL_RESULT_NOT_OBSERVED:${observation.scenario}`)
  }
  if (observation.expected === 'read-success') {
    if (!observation.stdout.includes('DSH_CAPABILITY_READ_RESULT')) throw new Error('DSH_READ_RESULT_MISSING')
    return
  }
  if (observation.expected === 'write-denied') {
    if (observation.scenario === 'write-outside') {
      if (observation.outsideExists) throw new Error(`DSH_OUTSIDE_WRITE_OCCURRED:${outsidePath}`)
    } else if (observation.scenario === 'shell-write') {
      if (observation.shellExists) throw new Error(`DSH_PWSH_WRITE_OCCURRED:${shellPath}`)
    } else if (observation.targetExists) {
      throw new Error(`DSH_WRITE_OCCURRED:${join(workspaceDir, 'write-target.txt')}`)
    }
    return
  }
  if (observation.expected === 'edit-denied') {
    const content = await readFile(join(workspaceDir, 'edit-target.txt'), 'utf8')
    if (content !== 'before\n') throw new Error('DSH_EDIT_OCCURRED_IN_READ_ONLY')
    return
  }
  if (observation.expected === 'approval-denied') {
    if (observation.outsideExists) throw new Error(`DSH_APPROVAL_ESCALATION_OCCURRED:${outsidePath}`)
    if (!observation.approvalMentioned) throw new Error('DSH_APPROVAL_SIGNAL_NOT_OBSERVED')
    return
  }
  if (observation.expected === 'edit-success') {
    const content = await readFile(join(workspaceDir, 'edit-target.txt'), 'utf8')
    if (!content.includes('after')) throw new Error('DSH_EDIT_NOT_EXECUTED')
    return
  }
  if (observation.expected === 'search-success') {
    if (!observation.stdout.includes(`DSH_CAPABILITY_${observation.scenario.toUpperCase()}_RESULT`)) {
      throw new Error(`DSH_${observation.scenario.toUpperCase()}_RESULT_MISSING`)
    }
    return
  }
  if (observation.expected === 'web-success') {
    if (!observation.stdout.includes('DSH_CAPABILITY_WEB-FETCH_RESULT')) throw new Error('DSH_WEB_FETCH_RESULT_MISSING')
    if (!observation.webContentObserved) throw new Error('DSH_LOCAL_WEB_CONTENT_NOT_OBSERVED')
    return
  }
  if (observation.expected === 'mcp-success') {
    if (!observation.stdout.includes('DSH_CAPABILITY_MCP_RESULT')) throw new Error('DSH_MCP_RESULT_MISSING')
    if (!observation.stdout.includes('MCP_STDIO_MATRIX_SUCCESS')) throw new Error('DSH_MCP_CONTENT_NOT_OBSERVED')
    return
  }
  if (observation.expected === 'write-success') {
    if (observation.scenario === 'shell-write') {
      if (!observation.shellExists) throw new Error('DSH_PWSH_WRITE_NOT_EXECUTED')
    } else if (!observation.targetExists) {
      throw new Error('DSH_WRITE_NOT_EXECUTED')
    }
    return
  }
  if (observation.expected === 'write-success-outside') {
    if (!observation.outsideExists) throw new Error('DSH_FULL_ACCESS_WRITE_NOT_EXECUTED')
    return
  }
  if (observation.expected === 'shell-cwd' && !observation.workspaceMentioned) {
    throw new Error(`DSH_PWSH_CWD_NOT_OBSERVED:${workspaceDir}`)
  }
}

async function main() {
  const workDir = await mkdtemp(join(smokeTempParent(), 'dsh-agy-provider-v7-permission-'))
  const installRoot = join(workDir, 'dsh-install')
  const fixtureWorkspaceRoot = join(workDir, 'workspaces')
  const fixturePath = new URL('../tests/fixtures/dsh-capability-model-fixture.mjs', import.meta.url).href
  const webFixturePath = new URL('../tests/fixtures/dsh-web-local-provider-fixture.mjs', import.meta.url).href
  const mcpServerPath = fileURLToPath(new URL('../tests/fixtures/mcp-stdio-matrix-server.mjs', import.meta.url))
  const rows = []
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('LOCAL_WEB_MATRIX_SUCCESS\n')
  })
  try {
    await mkdir(fixtureWorkspaceRoot, { recursive: true })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('LOCAL_WEB_SERVER_ADDRESS_UNAVAILABLE')
    const webUrl = `http://127.0.0.1:${address.port}/matrix`
    let dshEntry = process.env.DSH_SMOKE_DSH_ENTRY?.trim()
    if (dshEntry === undefined || dshEntry.length === 0 || !existsSync(dshEntry)) {
      dshEntry = await findCachedDshEntry()
    }
    if (dshEntry === undefined) {
      await runNpm([
        'install', '--prefix', installRoot, '--no-package-lock', '--ignore-scripts', '--prefer-offline',
        '--no-audit', '--no-fund', DSH_PACKAGE,
      ], { cwd: process.cwd() }).then(result => assertSuccess(result, 'DSH_INSTALL_FAILED'))
      dshEntry = join(installRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    }
    if (!existsSync(dshEntry)) throw new Error('DSH_ENTRY_NOT_FOUND')

    for (const [index, scenario] of SCENARIOS.entries()) {
      const workspaceDir = join(fixtureWorkspaceRoot, `${String(index + 1).padStart(2, '0')}-${scenario.name}-${scenario.permissionMode}`)
      const outsidePath = join(workDir, `${String(index + 1).padStart(2, '0')}-outside-target.txt`)
      const shellPath = join(workspaceDir, 'shell-target.txt')
      await mkdir(workspaceDir, { recursive: true })
      if (scenario.name === 'read') await writeFile(join(workspaceDir, 'read-target.txt'), 'DSH_READ_MATRIX_SUCCESS\n', 'utf8')
      if (scenario.name === 'edit') await writeFile(join(workspaceDir, 'edit-target.txt'), 'before\n', 'utf8')
      if (scenario.name === 'glob' || scenario.name === 'grep') {
        await writeFile(join(workspaceDir, 'search-target.txt'), 'DSH_SEARCH_MATRIX\n', 'utf8')
      }
      const patchPath = join(workDir, `${String(index + 1).padStart(2, '0')}.patch.yml`)
      await writeFile(patchPath, patchForFixture(fixturePath, webFixturePath, mcpServerPath), 'utf8')
      const task = `Run the ${scenario.name} capability exactly once. After DSH executes it, report the tool result and do not call another tool.`
      const result = await runNode(dshEntry, ['--profile', 'headless', '--patch', patchPath, task], {
        cwd: workspaceDir,
        env: scenarioEnv(workspaceDir, scenario, outsidePath, shellPath, webUrl),
      })
      assertSuccess(result, `DSH_PERMISSION_MATRIX_REQUEST_FAILED:${scenario.name}:${scenario.permissionMode}`)
      const observation = classifyScenario(scenario, result, workspaceDir, outsidePath, shellPath)
      await assertObservation(observation, workspaceDir, outsidePath, shellPath)
      rows.push({
        scenario: observation.scenario,
        permissionMode: observation.permissionMode,
        expected: observation.expected,
        roundTripObserved: observation.roundTripObserved,
        targetExists: observation.targetExists,
        outsideExists: observation.outsideExists,
        shellExists: observation.shellExists,
        workspaceMentioned: observation.workspaceMentioned,
        approvalMentioned: observation.approvalMentioned,
        webContentObserved: observation.webContentObserved,
        shellTool: process.platform === 'win32' ? 'pwsh' : 'bash',
      })
    }

    process.stdout.write(JSON.stringify({
      schemaVersion: 1,
      experiment: 'v7-m4-dsh-permission-matrix',
      quotaUsed: false,
      modelProvider: 'fixture',
      toolExecution: 'dsh-tool-runtime',
      scenarios: rows,
      cleanup: 'completed',
    }) + '\n')
  } catch (error) {
    if (error?.detail !== undefined) process.stderr.write(`${error.message}\n${error.detail}\n`)
    throw error
  } finally {
    await new Promise(resolve => server.close(() => resolve()))
    await rm(workDir, { recursive: true, force: true })
  }
}

try {
  await main()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'DSH_PERMISSION_MATRIX_SMOKE_FAILED'}\n`)
  process.exitCode = 1
}
