import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const dshHome = process.env.DSH_HOME?.trim()
if (dshHome === undefined || dshHome.length === 0) {
  throw new Error('DSH_HOME must point to an isolated DSH home with the target profile installed')
}

const packageMetadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const expectedPackageVersion = process.env.DSH_PROVIDER_EXPECTED_VERSION?.trim() || packageMetadata.version

const dshExecutable = process.env.DSH_BIN?.trim()
  || (process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
const expectedResponse = 'V2-M1 mock smoke passed'
const dshLauncher = resolveDshLauncher(dshExecutable)

function resolveDshLauncher(value) {
  const launcherPath = process.platform === 'win32'
    && /\.cmd$/i.test(value)
    && !/[\\/]/.test(value)
    ? resolve(process.cwd(), 'node_modules', '.bin', value)
    : value
  if (/\.(?:c|m)?js$/i.test(launcherPath)) {
    return { executable: process.execPath, prefixArgs: [resolve(launcherPath)] }
  }
  if (process.platform === 'win32' && /\.cmd$/i.test(launcherPath)) {
    const entry = resolve(dirname(launcherPath), '..', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    if (existsSync(entry)) {
      return { executable: process.execPath, prefixArgs: [entry] }
    }
    throw new Error(`Cannot resolve the DSH JS entry from ${value}; set DSH_BIN to the installed dsh.cmd or @deepseek-ai/dsh/lib/bin.js`)
  }
  return { executable: value, prefixArgs: [] }
}

function runDsh(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(dshLauncher.executable, [...dshLauncher.prefixArgs, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, DSH_HOME: dshHome },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal, stdout, stderr }))
  })
}

const workDir = await mkdtemp(join(tmpdir(), 'dsh-agy-provider-smoke-'))
const patchPath = join(workDir, 'mock.patch.yml')
await writeFile(patchPath, `- id: agent-default-model
  config:
    provider: agy-mock
    model: agy-mock-model
- id: dsh-agy-provider
  config:
    enabled: true
    provider: agy-mock
    model: agy-mock-model
    response: ${expectedResponse}
`, 'utf8')

try {
  const commonArgs = ['--profile', 'headless', '--patch', patchPath]
  const config = await runDsh([...commonArgs, '--dump-config'])
  if (config.exitCode !== 0) {
    throw new Error(`DSH config smoke failed (${config.exitCode ?? config.signal}): ${config.stderr}`)
  }
  if (!config.stdout.includes('# == dsh-agy-provider')
    || !config.stdout.includes('provider: agy-mock')
    || !config.stdout.includes('enabled: true')) {
    throw new Error('DSH config smoke did not activate the dsh-agy-provider mock patch')
  }

  const response = await runDsh([...commonArgs, 'Return the configured mock response without using tools.'])
  if (response.exitCode !== 0) {
    throw new Error(`DSH mock smoke failed (${response.exitCode ?? response.signal}): ${response.stderr}`)
  }
  if (!response.stdout.includes(expectedResponse)) {
    throw new Error(`DSH mock smoke returned an unexpected response: ${response.stdout}`)
  }

  const packagePath = join(dshHome, 'profiles', 'headless', 'node_modules', 'dsh-agy-provider', 'package.json')
  const installedPackage = JSON.parse(await readFile(packagePath, 'utf8'))
  if (installedPackage.name !== 'dsh-agy-provider' || installedPackage.version !== expectedPackageVersion) {
    throw new Error(`The DSH profile does not contain dsh-agy-provider@${expectedPackageVersion}`)
  }

  process.stdout.write(JSON.stringify({
    dshLauncher: process.platform === 'win32' && /\.cmd$/i.test(dshExecutable)
      ? 'windows-js-entry'
      : 'configured-entry',
    dshHome: 'isolated',
    provider: installedPackage.name,
    version: installedPackage.version,
    response: expectedResponse,
    quotaUsed: false,
  }) + '\n')
} finally {
  await rm(workDir, { recursive: true, force: true })
}
