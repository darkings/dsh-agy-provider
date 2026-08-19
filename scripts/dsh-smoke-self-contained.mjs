import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, parse } from 'node:path'

const DSH_PACKAGE = '@deepseek-ai/dsh@0.1.0-rc.7'
const PROVIDER_SPEC = process.env.DSH_SMOKE_PROVIDER_SPEC?.trim()
const EXPECTED_TOOL_POLICY = process.env.DSH_SMOKE_EXPECTED_TOOL_POLICY?.trim() || 'dsh-owned'
const EXPECT_V3_DOCTOR = process.env.DSH_SMOKE_EXPECT_V3_DOCTOR?.trim() !== 'false'
const EXPECTED_RESPONSE = 'V6-M5 self-contained mock smoke passed'
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
    const details = [
      result.timedOut ? 'timed out' : `exitCode=${result.exitCode ?? 'null'}`,
      result.signal === null || result.signal === undefined ? undefined : `signal=${result.signal}`,
      result.stderr.trim().length === 0 ? undefined : `stderr=${result.stderr.trim().slice(-4000)}`,
      result.stdout.trim().length === 0 ? undefined : `stdout=${result.stdout.trim().slice(-2000)}`,
    ].filter(Boolean).join('\n')
    throw new Error(`${code}\n${details}`)
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
      const root = join(npxRoot, entry.name, 'node_modules', '@deepseek-ai', 'dsh')
      const dshEntry = join(root, 'lib', 'bin.js')
      const packageJson = join(root, 'package.json')
      if (!existsSync(dshEntry) || !existsSync(packageJson)) continue
      const packageInfo = JSON.parse(await readFile(packageJson, 'utf8'))
      if (packageInfo.version === '0.1.0-rc.7') return dshEntry
    }
  }
  return undefined
}

function safeVersion(value) {
  const match = value.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)
  return match?.[0] ?? 'unknown'
}

async function packageVersion(path) {
  const metadata = JSON.parse(await readFile(path, 'utf8'))
  return { name: metadata.name, version: metadata.version }
}

function smokeTempParent() {
  const configured = process.env.DSH_SMOKE_TEMP_ROOT?.trim()
  if (configured !== undefined && configured.length > 0) return configured
  // DSH resolves bundles from the dsh install anchor before the profile. On
  // Windows, a user-level node_modules ancestor can therefore shadow the
  // profile tarball; use the drive root for a clean resolution boundary.
  return process.platform === 'win32' ? parse(process.cwd()).root : tmpdir()
}

async function main() {
  const workDir = await mkdtemp(join(smokeTempParent(), 'dsh-agy-provider-v6-smoke-'))
  const isolatedHome = join(workDir, 'dsh-home')
  const installRoot = join(workDir, 'dsh-install')
  const providerTarballDir = join(workDir, 'provider-tarball')
  const patchPath = join(workDir, 'mock.patch.yml')
  const dshEnv = { DSH_HOME: isolatedHome }
  try {
    let providerSource = PROVIDER_SPEC
    if (providerSource === undefined) {
      await mkdir(providerTarballDir, { recursive: true })
      await runNpm([
        'pack', '--ignore-scripts', '--pack-destination', providerTarballDir,
      ], { cwd: process.cwd() }).then(result => assertSuccess(result, 'PROVIDER_PACK_FAILED'))
      const tarballs = (await readdir(providerTarballDir)).filter(name => name.endsWith('.tgz'))
      if (tarballs.length !== 1) throw new Error('PROVIDER_TARBALL_NOT_FOUND')
      providerSource = join(providerTarballDir, tarballs[0])
    }

    let dshEntry = process.env.DSH_SMOKE_DSH_ENTRY?.trim()
    if (dshEntry !== undefined && dshEntry.length === 0) dshEntry = undefined
    if (dshEntry === undefined) dshEntry = await findCachedDshEntry()
    if (dshEntry === undefined) {
      await runNpm([
        'install', '--prefix', installRoot, '--no-package-lock', '--ignore-scripts', '--prefer-offline',
        '--no-audit', '--no-fund', DSH_PACKAGE,
      ], { cwd: process.cwd() }).then(result => assertSuccess(result, 'DSH_INSTALL_FAILED'))
      dshEntry = join(installRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    }
    await mkdir(installRoot, { recursive: true })
    if (!existsSync(dshEntry)) throw new Error('DSH_ENTRY_NOT_FOUND')
    const dshPackageJson = join(dirname(dirname(dshEntry)), 'package.json')

    const dshVersionResult = await runNode(dshEntry, ['--version'], { cwd: installRoot, env: dshEnv })
    assertSuccess(dshVersionResult, 'DSH_VERSION_FAILED')
    const dshVersion = safeVersion(dshVersionResult.stdout)

    // 1. Native plugin add to web profile
    const addWebResult = await runNode(dshEntry, ['plugin', '--profile', 'web', 'add', providerSource], {
      cwd: installRoot,
      env: dshEnv,
    })
    assertSuccess(addWebResult, 'DSH_PLUGIN_ADD_WEB_FAILED')

    const webProfileRoot = join(isolatedHome, 'profiles', 'web')
    if (!existsSync(webProfileRoot)) throw new Error('DSH_WEB_PROFILE_NOT_CREATED')

    const webPackage = JSON.parse(await readFile(join(webProfileRoot, 'package.json'), 'utf8'))
    if (!webPackage.dependencies?.['dsh-agy-provider']) throw new Error('WEB_PROFILE_DEPENDENCY_MISSING')
    if (!Array.isArray(webPackage.dsh?.profile?.bundles) || !webPackage.dsh.profile.bundles.includes('dsh-agy-provider')) {
      throw new Error('WEB_PROFILE_BUNDLE_DECLARATION_MISSING')
    }

    // Verify web profile dump-config has ready DSH-owned defaults without manual patch
    const webDumpConfig = await runNode(dshEntry, ['--profile', 'web', '--dump-config'], {
      cwd: installRoot,
      env: dshEnv,
    })
    assertSuccess(webDumpConfig, 'DSH_WEB_DUMP_CONFIG_FAILED')
    const webChecks = [
      '# == dsh-agy-provider',
      'enabled: true',
      `toolPolicy: ${EXPECTED_TOOL_POLICY}`,
      'provider: agy',
      'model: gemini-3.1-pro-high',
    ]
    if (!webChecks.every(value => webDumpConfig.stdout.includes(value))) {
      const webConfigSummary = webDumpConfig.stdout
        .split(/\r?\n/)
        .filter(line => /# == dsh-agy-provider|enabled:|toolPolicy:|provider:|model:/.test(line))
        .map(line => line.trim().replace(/\s+/g, ' '))
        .slice(0, 12)
      process.stderr.write(`Web bundle config summary: ${JSON.stringify(webConfigSummary)}\n`)
      process.stderr.write(`Missing web bundle checks: ${JSON.stringify(webChecks.filter(v => !webDumpConfig.stdout.includes(v)))}\n`)
      throw new Error('WEB_PROFILE_BUNDLE_DEFAULTS_MISMATCH')
    }

    // Run Doctor CLI check against the web profile
    const installedProviderRoot = join(webProfileRoot, 'node_modules', 'dsh-agy-provider')
    const doctorCliEntry = join(installedProviderRoot, 'bin', 'dsh-agy-provider.js')
    const doctorResult = await runNode(doctorCliEntry, [
      'doctor', '--profile', 'web', '--dsh-home', isolatedHome, '--dsh-bin', dshEntry, '--json',
    ], {
      cwd: webProfileRoot,
      env: dshEnv,
    })
    if (doctorResult.exitCode !== 0 && doctorResult.exitCode !== 1) {
      throw new Error('DOCTOR_CLI_EXECUTION_FAILED')
    }
    const doctorParsed = JSON.parse(doctorResult.stdout)
    if (doctorParsed.quotaUsed !== false
      || doctorParsed.profile?.packageInstalled !== true
      || doctorParsed.profile?.bundleDeclared !== true
      || doctorParsed.profile?.bundleEnabled !== true
      || doctorParsed.profile?.toolPolicy !== EXPECTED_TOOL_POLICY
      || doctorParsed.profile?.effectiveProvider !== 'agy'
      || doctorParsed.profile?.effectiveModel !== 'gemini-3.1-pro-high'
      || (EXPECT_V3_DOCTOR && (doctorParsed.profile?.profileSchemaVersion !== 3
        || doctorParsed.profile?.effective?.dumpStatus !== 'ok'
        || doctorParsed.profile?.effective?.provider !== 'agy'
        || doctorParsed.profile?.effective?.model !== 'gemini-3.1-pro-high'
        || doctorParsed.profile?.effective?.agent !== 'deepseek-proxy'
        || doctorParsed.profile?.effective?.sessionMode !== 'full'
        || JSON.stringify(doctorParsed.profile?.effective?.modelCapability?.inputModalities) !== '["text"]'))) {
      process.stderr.write(`Doctor profile summary: ${JSON.stringify({
        quotaUsed: doctorParsed.quotaUsed,
        packageInstalled: doctorParsed.profile?.packageInstalled,
        bundleDeclared: doctorParsed.profile?.bundleDeclared,
        bundleEnabled: doctorParsed.profile?.bundleEnabled,
        toolPolicy: doctorParsed.profile?.toolPolicy,
        effectiveProvider: doctorParsed.profile?.effectiveProvider,
        effectiveModel: doctorParsed.profile?.effectiveModel,
        effective: doctorParsed.profile?.effective,
        issueCodes: doctorParsed.errors?.map(issue => issue.code),
        dumpConfigLines: webDumpConfig.stdout
          .split(/\r?\n/)
          .filter(line => /dsh-agy-provider|enabled:|toolPolicy:|provider:|model:|agent:|sessionMode:/.test(line))
          .map(line => line.trim().replace(/\s+/g, ' '))
          .slice(0, 24),
      })}\n`)
      throw new Error('DOCTOR_PROFILE_DIAGNOSTIC_MISMATCH')
    }

    // 2. Native plugin add to headless profile and test mock response
    const addHeadlessResult = await runNode(dshEntry, ['plugin', '--profile', 'headless', 'add', providerSource], {
      cwd: installRoot,
      env: dshEnv,
    })
    assertSuccess(addHeadlessResult, 'DSH_PLUGIN_ADD_HEADLESS_FAILED')

    const headlessProfileRoot = join(isolatedHome, 'profiles', 'headless')
    if (!existsSync(headlessProfileRoot)) throw new Error('DSH_HEADLESS_PROFILE_NOT_CREATED')

    await writeFile(patchPath, `- id: agent-default-model
  config:
    provider: agy-mock
    model: agy-mock-model
- id: dsh-agy-provider
  config:
    enabled: true
    provider: agy-mock
    model: agy-mock-model
    toolPolicy: agy-owned
    response: ${EXPECTED_RESPONSE}
`, 'utf8')

    const commonArgs = ['--profile', 'headless', '--patch', patchPath]
    const headlessDumpConfig = await runNode(dshEntry, [...commonArgs, '--dump-config'], {
      cwd: installRoot,
      env: dshEnv,
    })
    assertSuccess(headlessDumpConfig, 'DSH_HEADLESS_CONFIG_SMOKE_FAILED')

    const response = await runNode(dshEntry, [...commonArgs, 'Return the configured mock response without using tools.'], {
      cwd: installRoot,
      env: dshEnv,
    })
    assertSuccess(response, 'DSH_MOCK_RESPONSE_FAILED')
    if (!response.stdout.includes(EXPECTED_RESPONSE)) throw new Error('DSH_MOCK_RESPONSE_MISMATCH')

    const providerMetadata = await packageVersion(join(webProfileRoot, 'node_modules', 'dsh-agy-provider', 'package.json'))
    const dshMetadata = await packageVersion(dshPackageJson)
    const inventory = [
      'lib/index.js',
      'lib/index.d.ts',
      'bin/dsh-agy-provider.js',
      'cordis.patch.yml',
    ]
    if (!inventory.every(file => existsSync(join(webProfileRoot, 'node_modules', 'dsh-agy-provider', file)))) {
      throw new Error('PROVIDER_BUNDLE_INVENTORY_FAILED')
    }

    process.stdout.write(JSON.stringify({
      schemaVersion: 1,
      experiment: 'v6-m5-self-contained-dsh-native-plugin-smoke',
      quotaUsed: false,
      dsh: dshMetadata,
      dshVersion,
      provider: providerMetadata,
      providerSource: PROVIDER_SPEC ?? 'local-pack',
      profiles: ['web', 'headless'],
      installMethod: PROVIDER_SPEC === undefined ? 'dsh plugin add' : 'dsh plugin add (registry spec)',
      bundleDefaults: {
        enabled: true,
        toolPolicy: EXPECTED_TOOL_POLICY,
        provider: 'agy',
        model: 'gemini-3.1-pro-high',
      },
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
