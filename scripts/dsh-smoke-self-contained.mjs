import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const DSH_PACKAGE = '@deepseek-ai/dsh@0.1.0-rc.7'
const EXPECTED_RESPONSE = 'V4-M4 self-contained mock smoke passed'
const COMMAND_TIMEOUT_MS = 10 * 60_000
const OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024

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
    child.once('close', (exitCode, signal) => finish({
      exitCode,
      signal,
      timedOut,
      stdout,
      stderr,
    }))
  })
}

function assertSuccess(result, code) {
  if (result.timedOut || result.exitCode !== 0) {
    throw new Error(code)
  }
}

function runNode(entry, args, options) {
  return runCommand(process.execPath, [entry, ...args], options)
}

function runNpm(args, options) {
  return runNode(resolveNpmCli(), args, options)
}

function safeVersion(value) {
  const match = value.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)
  return match?.[0] ?? 'unknown'
}

async function packageVersion(path) {
  const metadata = JSON.parse(await readFile(path, 'utf8'))
  return { name: metadata.name, version: metadata.version }
}

async function main() {
  const workDir = await mkdtemp(join(tmpdir(), 'dsh-agy-provider-v4-smoke-'))
  const isolatedHome = join(workDir, 'dsh-home')
  const installRoot = join(workDir, 'dsh-install')
  const providerTarballDir = join(workDir, 'provider-tarball')
  const patchPath = join(workDir, 'mock.patch.yml')
  const dshEnv = { DSH_HOME: isolatedHome }
  try {
    await mkdir(providerTarballDir, { recursive: true })
    await runNpm([
      'pack', '--ignore-scripts', '--pack-destination', providerTarballDir,
    ], { cwd: process.cwd() }).then(result => assertSuccess(result, 'PROVIDER_PACK_FAILED'))
    const tarballs = (await readdir(providerTarballDir)).filter(name => name.endsWith('.tgz'))
    if (tarballs.length !== 1) throw new Error('PROVIDER_TARBALL_NOT_FOUND')
    const providerTarball = join(providerTarballDir, tarballs[0])

    await runNpm([
      'install', '--prefix', installRoot, '--no-package-lock', '--ignore-scripts', '--prefer-offline',
      '--no-audit', '--no-fund', DSH_PACKAGE,
    ], { cwd: process.cwd() }).then(result => assertSuccess(result, 'DSH_INSTALL_FAILED'))
    const dshEntry = join(installRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    if (!existsSync(dshEntry)) throw new Error('DSH_ENTRY_NOT_FOUND')

    const dshVersionResult = await runNode(dshEntry, ['--version'], { cwd: installRoot, env: dshEnv })
    assertSuccess(dshVersionResult, 'DSH_VERSION_FAILED')
    const dshVersion = safeVersion(dshVersionResult.stdout)

    const bootstrap = await runNode(dshEntry, ['--profile', 'headless', '--dump-config'], {
      cwd: installRoot,
      env: dshEnv,
    })
    assertSuccess(bootstrap, 'DSH_PROFILE_BOOTSTRAP_FAILED')
    const profileRoot = join(isolatedHome, 'profiles', 'headless')
    if (!existsSync(profileRoot)) throw new Error('DSH_PROFILE_NOT_CREATED')

    await runNpm([
      'install', '--prefix', profileRoot, '--no-package-lock', '--ignore-scripts', '--prefer-offline',
      '--no-audit', '--no-fund', providerTarball,
    ], { cwd: installRoot, env: dshEnv }).then(result => assertSuccess(result, 'PROVIDER_PROFILE_INSTALL_FAILED'))

    const profilePackagePath = join(profileRoot, 'package.json')
    const profilePackage = JSON.parse(await readFile(profilePackagePath, 'utf8'))
    const bundles = profilePackage.dsh?.profile?.bundles
    if (!Array.isArray(bundles)) throw new Error('DSH_PROFILE_BUNDLES_MISSING')
    if (!bundles.includes('dsh-agy-provider')) bundles.push('dsh-agy-provider')
    await writeFile(profilePackagePath, `${JSON.stringify(profilePackage, null, 2)}\n`, 'utf8')

    await writeFile(patchPath, `- id: agent-default-model
  config:
    provider: agy-mock
    model: agy-mock-model
- id: dsh-agy-provider
  config:
    enabled: true
    provider: agy-mock
    model: agy-mock-model
    toolPolicy: reject
    response: ${EXPECTED_RESPONSE}
`, 'utf8')

    const commonArgs = ['--profile', 'headless', '--patch', patchPath]
    const config = await runNode(dshEntry, [...commonArgs, '--dump-config'], {
      cwd: installRoot,
      env: dshEnv,
    })
    assertSuccess(config, 'DSH_CONFIG_SMOKE_FAILED')
    const configChecks = [
      '# == dsh-agy-provider',
      'provider: agy-mock',
      'model: agy-mock-model',
      'toolPolicy: reject',
    ]
    if (!configChecks.every(value => config.stdout.includes(value))) throw new Error('DSH_CONFIG_PATCH_NOT_ACTIVE')

    const response = await runNode(dshEntry, [...commonArgs, 'Return the configured mock response without using tools.'], {
      cwd: installRoot,
      env: dshEnv,
    })
    assertSuccess(response, 'DSH_MOCK_RESPONSE_FAILED')
    if (!response.stdout.includes(EXPECTED_RESPONSE)) throw new Error('DSH_MOCK_RESPONSE_MISMATCH')

    const providerMetadata = await packageVersion(join(profileRoot, 'node_modules', 'dsh-agy-provider', 'package.json'))
    const dshMetadata = await packageVersion(join(installRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    const inventory = [
      'lib/index.js',
      'lib/index.d.ts',
      'cordis.patch.yml',
    ]
    if (!inventory.every(file => existsSync(join(profileRoot, 'node_modules', 'dsh-agy-provider', file)))) {
      throw new Error('PROVIDER_BUNDLE_INVENTORY_FAILED')
    }

    process.stdout.write(JSON.stringify({
      schemaVersion: 1,
      experiment: 'v4-m4-self-contained-dsh-mock-smoke',
      quotaUsed: false,
      dsh: dshMetadata,
      dshVersion,
      provider: providerMetadata,
      profile: 'headless',
      model: 'agy-mock-model',
      toolPolicy: 'reject',
      bundleInventory: inventory,
      response: EXPECTED_RESPONSE,
      cleanup: 'completed',
    }) + '\n')
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

try {
  await main()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'DSH_SMOKE_FAILED'}\n`)
  process.exitCode = 1
}
