import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { redactText } from './agy/redact.js'
import {
  diagnoseProvider,
  type DiagnosticIssue,
  type ProviderDiagnosticOptions,
  type ProviderDiagnosticResult,
} from './diagnostics.js'
import { Config, type Config as ConfigType, type ToolPolicy } from './provider/config.js'

const require = createRequire(import.meta.url)

interface PackageMetadata {
  name?: string
  version?: string
}

function loadPackageMetadata(): PackageMetadata {
  try {
    return require('../package.json') as PackageMetadata
  } catch {
    return {}
  }
}

const packageMetadata = loadPackageMetadata()
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function isSafeProfileName(value: string): boolean {
  return PROFILE_NAME_PATTERN.test(value)
}

function resolveDshInvocation(value: string): { executable: string; prefixArgs: string[] } {
  if (process.platform !== 'win32' || !/\.cmd$/i.test(value)) {
    if (/\.(?:c|m)?js$/i.test(value)) return { executable: process.execPath, prefixArgs: [value] }
    return { executable: value, prefixArgs: [] }
  }

  if (/[\\/]/.test(value)) {
    const entry = join(dirname(value), '..', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    if (existsSync(entry)) return { executable: process.execPath, prefixArgs: [entry] }
  }

  // npm's Windows .cmd shims cannot be spawned directly with shell=false.
  // Keep shell=false and invoke the shim through the Windows command
  // interpreter; profile names and DSH_HOME are passed as regular argv/env.
  return {
    executable: process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe',
    prefixArgs: ['/d', '/s', '/c', 'call', value],
  }
}

export interface ProfileDiagnosticOptions {
  profileName: string
  dshHome?: string | undefined
  dshBin?: string | undefined
  timeoutMs?: number | undefined
  runCommand?: ((
    executable: string,
    args: readonly string[],
    options?: { timeoutMs?: number | undefined; cwd?: string | undefined; env?: NodeJS.ProcessEnv | undefined },
  ) => Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }>) | undefined
}

export interface ProfileDiagnosticResult {
  name: string
  dshHomePresent: boolean
  profilePresent: boolean
  packageInstalled: boolean
  bundleDeclared: boolean
  bundleEnabled: boolean | null
  toolPolicy: ToolPolicy | string | null
  effectiveProvider: string | null
  effectiveModel: string | null
  issues: DiagnosticIssue[]
}

export interface DoctorOptions extends ProviderDiagnosticOptions {
  profile?: string | undefined
  dshHome?: string | undefined
  dshBin?: string | undefined
  runProfileCommand?: ProfileDiagnosticOptions['runCommand'] | undefined
}

export interface DoctorResult extends ProviderDiagnosticResult {
  profile?: ProfileDiagnosticResult | undefined
}

function killProcessTree(child: ReturnType<typeof spawn>): void {
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

function defaultRunCommand(
  executable: string,
  args: readonly string[],
  options: { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const timeoutMs = options.timeoutMs ?? 10_000
  const maxOutputBytes = 1024 * 1024
  return new Promise(resolve => {
    let stdout = ''
    let stderr = ''
    let totalBytes = 0
    let timedOut = false
    let settled = false

    const child = spawn(executable, args as string[], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const timer = setTimeout(() => {
      timedOut = true
      killProcessTree(child)
    }, timeoutMs)

    const finish = (exitCode: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ exitCode, stdout, stderr, timedOut })
    }

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', chunk => {
      totalBytes += Buffer.byteLength(chunk, 'utf8')
      if (totalBytes <= maxOutputBytes) stdout += chunk
    })
    child.stderr?.on('data', chunk => {
      if (Buffer.byteLength(stderr, 'utf8') <= maxOutputBytes) stderr += chunk
    })
    child.once('error', () => finish(null))
    child.once('close', exitCode => finish(exitCode))
  })
}

function resolveDshHome(customHome?: string): string {
  const envHome = process.env.DSH_HOME?.trim()
  if (customHome !== undefined && customHome.trim().length > 0) return customHome.trim()
  if (envHome !== undefined && envHome.length > 0) return envHome
  return join(homedir(), '.dsh')
}

function parseDumpConfig(stdout: string): {
  bundleEnabled: boolean | null
  toolPolicy: string | null
  effectiveProvider: string | null
  effectiveModel: string | null
} {
  let bundleEnabled: boolean | null = null
  let toolPolicy: string | null = null
  let effectiveProvider: string | null = null
  let effectiveModel: string | null = null

  const lines = stdout.split(/\r?\n/)
  let inBundleSection = false

  for (const line of lines) {
    if (line.includes('# == dsh-agy-provider') || line.includes('id: dsh-agy-provider')) {
      inBundleSection = true
      continue
    }
    if (inBundleSection && line.startsWith('# == ')) {
      inBundleSection = false
    }
    if (inBundleSection) {
      const enabledMatch = /^\s*enabled:\s*(true|false)/i.exec(line)
      if (enabledMatch?.[1] !== undefined) bundleEnabled = enabledMatch[1].toLowerCase() === 'true'
      const toolPolicyMatch = /^\s*toolPolicy:\s*([^\s#]+)/.exec(line)
      if (toolPolicyMatch?.[1] !== undefined) toolPolicy = toolPolicyMatch[1]
      const providerMatch = /^\s*provider:\s*([^\s#]+)/.exec(line)
      if (providerMatch?.[1] !== undefined) effectiveProvider = providerMatch[1]
      const modelMatch = /^\s*model:\s*([^\s#]+)/.exec(line)
      if (modelMatch?.[1] !== undefined) effectiveModel = modelMatch[1]
    }
  }

  return { bundleEnabled, toolPolicy, effectiveProvider, effectiveModel }
}

export async function diagnoseProfile(
  options: ProfileDiagnosticOptions,
): Promise<ProfileDiagnosticResult> {
  const profileName = options.profileName.trim()
  const dshHome = resolveDshHome(options.dshHome)
  const dshHomePresent = existsSync(dshHome)
  const validProfileName = isSafeProfileName(profileName)
  const profileDir = validProfileName ? join(dshHome, 'profiles', profileName) : ''
  const profilePresent = dshHomePresent && existsSync(profileDir)
  const issues: DiagnosticIssue[] = []

  if (!validProfileName) {
    return {
      name: '<invalid>',
      dshHomePresent,
      profilePresent: false,
      packageInstalled: false,
      bundleDeclared: false,
      bundleEnabled: null,
      toolPolicy: null,
      effectiveProvider: null,
      effectiveModel: null,
      issues: [{
        component: 'profile',
        code: 'PROFILE_NAME_INVALID',
        message: 'Profile name must contain 1-64 letters, numbers, dots, underscores, or hyphens and must not contain path separators',
      }],
    }
  }

  let packageInstalled = false
  let bundleDeclared = false
  let bundleEnabled: boolean | null = null
  let toolPolicy: string | null = null
  let effectiveProvider: string | null = null
  let effectiveModel: string | null = null

  if (!dshHomePresent) {
    issues.push({
      component: 'profile',
      code: 'DSH_HOME_NOT_FOUND',
      message: `DSH home directory not found: run DSH once or set DSH_HOME`,
    })
  } else if (!profilePresent) {
    issues.push({
      component: 'profile',
      code: 'PROFILE_NOT_FOUND',
      message: `Profile "${profileName}" not found. Create with: npx @deepseek-ai/dsh plugin --profile ${profileName} add dsh-agy-provider`,
    })
  } else {
    const profilePackageJsonPath = join(profileDir, 'package.json')
    if (existsSync(profilePackageJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(profilePackageJsonPath, 'utf8'))
        const deps = pkg.dependencies ?? {}
        const devDeps = pkg.devDependencies ?? {}
        packageInstalled = Boolean(deps['dsh-agy-provider'] || devDeps['dsh-agy-provider'])
        const bundles = pkg.dsh?.profile?.bundles
        bundleDeclared = Array.isArray(bundles) && bundles.includes('dsh-agy-provider')
      } catch {
        issues.push({
          component: 'profile',
          code: 'PROFILE_PACKAGE_JSON_INVALID',
          message: `Could not parse package.json for profile "${profileName}"`,
        })
      }
    }

    if (!packageInstalled) {
      issues.push({
        component: 'profile',
        code: 'PROFILE_PACKAGE_MISSING',
        message: `Package dsh-agy-provider is not installed in profile "${profileName}". Run: npx @deepseek-ai/dsh plugin --profile ${profileName} add dsh-agy-provider`,
      })
    } else if (!bundleDeclared) {
      issues.push({
        component: 'profile',
        code: 'PROFILE_BUNDLE_MISSING',
        message: `Bundle dsh-agy-provider is not declared in dsh.profile.bundles for profile "${profileName}". Re-run: npx @deepseek-ai/dsh plugin --profile ${profileName} add dsh-agy-provider`,
      })
    }

    // Attempt to inspect effective dump-config if DSH CLI is available
    const runCmd = options.runCommand ?? defaultRunCommand
    const customBin = options.dshBin?.trim() || process.env.DSH_BIN?.trim()
    const dshCandidates = [
      ...(customBin ? [customBin] : []),
      join(profileDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      join(dirname(profileDir), '..', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    ]
    const pathDshCommand = process.platform === 'win32' ? 'dsh.cmd' : 'dsh'
    const dshEntry = options.runCommand !== undefined
      ? (customBin ?? pathDshCommand)
      : dshCandidates.find(p => existsSync(p))
        ?? pathDshCommand

    if (dshEntry !== undefined) {
      try {
        const invocation = resolveDshInvocation(dshEntry)
        const args = [...invocation.prefixArgs, '--profile', profileName, '--dump-config']
        const dumpResult = await runCmd(invocation.executable, args, {
          timeoutMs: options.timeoutMs ?? 10_000,
          cwd: profileDir,
          env: { ...process.env, DSH_HOME: dshHome },
        })
        if (dumpResult.exitCode === 0 && !dumpResult.timedOut) {
          const parsed = parseDumpConfig(dumpResult.stdout)
          bundleEnabled = parsed.bundleEnabled
          toolPolicy = parsed.toolPolicy
          effectiveProvider = parsed.effectiveProvider
          effectiveModel = parsed.effectiveModel
        }
      } catch {
        // dump-config is optional diagnostic enhancement
      }
    }

    // Check bundleEnabled and toolPolicy warnings
    if (bundleEnabled === false) {
      issues.push({
        component: 'profile',
        code: 'PROFILE_BUNDLE_DISABLED',
        message: `Bundle dsh-agy-provider is disabled in profile "${profileName}". Enable in cordis.patch.yml or profile config`,
      })
    }
    if (toolPolicy === 'reject' && profileName === 'web') {
      issues.push({
        component: 'profile',
        code: 'PROFILE_TOOL_POLICY_REJECT',
        message: `Profile "${profileName}" carries tool schemas by default, but toolPolicy is "reject". Set toolPolicy: agy-owned to prevent UNSUPPORTED_TOOLS errors`,
      })
    }
  }

  return {
    name: profileName,
    dshHomePresent,
    profilePresent,
    packageInstalled,
    bundleDeclared,
    bundleEnabled,
    toolPolicy,
    effectiveProvider,
    effectiveModel,
    issues,
  }
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorResult> {
  const providerResult = await diagnoseProvider(options)
  let profileResult: ProfileDiagnosticResult | undefined

  const profileName = options.profile?.trim()
  if (profileName !== undefined && profileName.length > 0) {
    profileResult = await diagnoseProfile({
      profileName,
      ...(options.dshHome === undefined ? {} : { dshHome: options.dshHome }),
      ...(options.dshBin === undefined ? {} : { dshBin: options.dshBin }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.runProfileCommand === undefined ? {} : { runCommand: options.runProfileCommand }),
    })
  }

  const allErrors: DiagnosticIssue[] = [...providerResult.errors]
  if (profileResult !== undefined) {
    allErrors.push(...profileResult.issues)
  }

  return {
    ...providerResult,
    ok: allErrors.length === 0,
    ...(profileResult === undefined ? {} : { profile: profileResult }),
    errors: allErrors,
  }
}

export function formatDoctorHuman(result: DoctorResult): string {
  const lines: string[] = []
  lines.push(`dsh-agy-provider doctor (schema v${result.schemaVersion})`)
  lines.push(`status: ${result.ok ? 'PASS' : 'FAIL'}; quotaUsed: ${result.quotaUsed}`)
  lines.push(`plugin: ${result.plugin.name}@${result.plugin.version ?? 'unknown'}; enabled: ${result.plugin.enabled}`)
  lines.push(`node: ${result.node.version} (${result.node.supported ? 'supported' : 'unsupported'})`)
  lines.push(
    `dsh: cli=${result.dsh.cliVersion ?? 'unknown'}; llm=${result.dsh.llmContractVersion ?? 'unknown'}; bundle=${result.dsh.bundlePatchPresent ? 'present' : 'missing'}`,
  )

  if (result.profile !== undefined) {
    const p = result.profile
    lines.push(
      `profile [${p.name}]: exists=${p.profilePresent}; packageInstalled=${p.packageInstalled}; bundleDeclared=${p.bundleDeclared}; enabled=${p.bundleEnabled ?? 'unknown'}; toolPolicy=${p.toolPolicy ?? 'unknown'}`,
    )
  }

  lines.push(
    `provider: ${result.configuration.provider}; agent=${result.configuration.agent}; defaultModel=${result.configuration.defaultModel}; toolPolicy=${result.configuration.toolPolicy}`,
  )
  lines.push(`models: ${result.models.map(m => `${m.id} (${m.name})`).join(', ') || 'none'}`)
  lines.push(
    `modelCatalog: source=${result.modelCatalog.source}; stale=${result.modelCatalog.stale}; warningCode=${result.modelCatalog.warningCode ?? 'none'}`,
  )
  lines.push(
    `agy: version=${result.agy.version ?? 'unknown'}; agents=${result.agy.agents.join(', ') || 'none'}; executableSource=${result.agy.executableSource}`,
  )

  if (result.errors.length > 0) {
    lines.push('issues:')
    for (const issue of result.errors) {
      lines.push(`- [${issue.component}/${issue.code}] ${issue.message}`)
    }
  }

  return lines.join('\n')
}

export function formatDoctorHelp(): string {
  return `Usage: dsh-agy-provider [doctor] [options]

Quota-free diagnostic CLI for dsh-agy-provider and DSH profiles.

Commands:
  doctor                  Run diagnostic checks (default)

Options:
  --profile <name>        DSH profile to inspect (e.g. web, headless)
  --dsh-home <path>       Custom DSH home directory path
  --dsh-bin <path>        Custom DSH CLI executable / entry path
  --json                  Output structured JSON
  -v, --version           Print version and exit
  -h, --help              Show help information

Examples:
  npx dsh-agy-provider doctor
  npx dsh-agy-provider doctor --profile web
  npx dsh-agy-provider doctor --profile web --json
`
}

export async function runDoctorCli(
  argv: readonly string[],
  stdout: (text: string) => void = text => process.stdout.write(text),
  stderr: (text: string) => void = text => process.stderr.write(text),
): Promise<number> {
  const args = [...argv]
  if (args[0] === 'doctor') args.shift()

  if (args.includes('-h') || args.includes('--help')) {
    stdout(`${formatDoctorHelp()}\n`)
    return 0
  }

  if (args.includes('-v') || args.includes('--version')) {
    stdout(`${packageMetadata.version ?? 'unknown'}\n`)
    return 0
  }

  const jsonOutput = args.includes('--json')

  let profile: string | undefined
  const profileIdx = args.indexOf('--profile')
  if (profileIdx !== -1 && profileIdx + 1 < args.length) {
    profile = args[profileIdx + 1]
  }

  let dshHome: string | undefined
  const dshHomeIdx = args.indexOf('--dsh-home')
  if (dshHomeIdx !== -1 && dshHomeIdx + 1 < args.length) {
    dshHome = args[dshHomeIdx + 1]
  }

  let dshBin: string | undefined
  const dshBinIdx = args.indexOf('--dsh-bin')
  if (dshBinIdx !== -1 && dshBinIdx + 1 < args.length) {
    dshBin = args[dshBinIdx + 1]
  }

  try {
    const result = await runDoctor({
      ...(profile === undefined ? {} : { profile }),
      ...(dshHome === undefined ? {} : { dshHome }),
      ...(dshBin === undefined ? {} : { dshBin }),
      config: Config({}),
    })

    if (jsonOutput) {
      stdout(`${JSON.stringify(result, null, 2)}\n`)
    } else {
      stdout(`${formatDoctorHuman(result)}\n`)
    }
    return result.ok ? 0 : 1
  } catch (error) {
    const message = redactText(error instanceof Error ? error.message : String(error), 512)
    if (jsonOutput) {
      stdout(
        JSON.stringify(
          {
            schemaVersion: 1,
            ok: false,
            quotaUsed: false,
            errors: [{ component: 'config', code: 'DOCTOR_EXECUTION_FAILED', message }],
          },
          null,
          2,
        ) + '\n',
      )
    } else {
      stderr(`Error running doctor: ${message}\n`)
    }
    return 1
  }
}
