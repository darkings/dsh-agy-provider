import { AgyProcessError, resolveAgyExecutable, runProcess, type ProcessRequest, type ProcessResult } from './process.js'
import { redactText } from './redact.js'

export interface AgyDiagnosticOptions {
  executable?: string
  expectedAgent?: string
  minimumVersion?: string
  timeoutMs?: number
  runCommand?: AgyDiagnosticCommand
}

export type AgyDiagnosticCommand = (request: ProcessRequest) => Promise<ProcessResult>

export interface AgyDiagnosticResult {
  ok: boolean
  /** Safe source label; never contains the resolved user filesystem path. */
  executable: string
  executableSource: 'explicit' | 'environment' | 'path'
  version: string | undefined
  agents: readonly string[]
  expectedAgent: string | undefined
  minimumVersion: string | undefined
  versionSupported: boolean
  agentAvailable: boolean
  errors: readonly string[]
}

interface ParsedVersion {
  major: number
  minor: number
  patch: number
  text: string
}

function parseVersionValue(value: string): ParsedVersion | undefined {
  const match = /(?:^|\D)(\d+)\.(\d+)\.(\d+)(?:$|\D)/.exec(value)
  if (match === null) return undefined
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  if (![major, minor, patch].every(Number.isSafeInteger)) return undefined
  return { major, minor, patch, text: `${major}.${minor}.${patch}` }
}

export function parseAgyVersion(output: string): string | undefined {
  return parseVersionValue(output)?.text
}

export function isAgyVersionAtLeast(actual: string, minimum: string): boolean {
  const actualVersion = parseVersionValue(actual)
  const minimumVersion = parseVersionValue(minimum)
  if (actualVersion === undefined || minimumVersion === undefined) return false
  if (actualVersion.major !== minimumVersion.major) return actualVersion.major > minimumVersion.major
  if (actualVersion.minor !== minimumVersion.minor) return actualVersion.minor > minimumVersion.minor
  return actualVersion.patch >= minimumVersion.patch
}

/** Parse the plain one-agent-per-line output of `agy agents`. */
export function parseAgyAgents(output: string): string[] {
  return [...new Set(output
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(line)))]
}

function commandRequest(executable: string, args: readonly string[], timeoutMs: number | undefined): ProcessRequest {
  return timeoutMs === undefined
    ? { executable, args, windowsNoConsole: true }
    : { executable, args, timeoutMs, windowsNoConsole: true }
}

function commandFailure(label: string, result: ProcessResult): string | undefined {
  if (result.termination === 'completed' && result.exitCode === 0) return undefined
  return `${label} failed (${result.termination}, exit code ${result.exitCode ?? 'unknown'})`
}

function executableSource(options: AgyDiagnosticOptions): 'explicit' | 'environment' | 'path' {
  if (options.executable?.trim()) return 'explicit'
  if (process.env.AGY_PATH?.trim() || process.env.AGY_EXECUTABLE?.trim()) return 'environment'
  return 'path'
}

async function runDiagnosticCommand(
  label: string,
  executable: string,
  args: readonly string[],
  timeoutMs: number | undefined,
  runCommand: AgyDiagnosticCommand,
): Promise<{ result: ProcessResult | undefined; error: string | undefined }> {
  try {
    const result = await runCommand(commandRequest(executable, args, timeoutMs))
    return { result, error: commandFailure(label, result) }
  } catch (error) {
    if (error instanceof AgyProcessError) {
      return { result: undefined, error: redactText(error.message, 512) }
    }
    return {
      result: undefined,
      error: `${label} failed: ${redactText(error instanceof Error ? error.message : String(error), 512)}`,
    }
  }
}

/** Check the local AGY executable without spending model quota or invoking tools. */
export async function diagnoseAgy(options: AgyDiagnosticOptions = {}): Promise<AgyDiagnosticResult> {
  const executable = resolveAgyExecutable(options.executable)
  const source = executableSource(options)
  const runCommand = options.runCommand ?? runProcess
  const versionCheck = await runDiagnosticCommand(
    'agy --version',
    executable,
    ['--version'],
    options.timeoutMs,
    runCommand,
  )
  const agentsCheck = await runDiagnosticCommand(
    'agy agents',
    executable,
    ['agents'],
    options.timeoutMs,
    runCommand,
  )

  const versionOutput = versionCheck.result === undefined
    ? ''
    : versionCheck.result.stdoutLines.join('\n')
  const version = parseAgyVersion(versionOutput)
  const agentsOutput = agentsCheck.result === undefined
    ? ''
    : agentsCheck.result.stdoutLines.join('\n')
  const agents = parseAgyAgents(agentsOutput)
  const versionSupported = options.minimumVersion === undefined
    ? version !== undefined
    : version !== undefined && isAgyVersionAtLeast(version, options.minimumVersion)
  const agentAvailable = options.expectedAgent === undefined || agents.includes(options.expectedAgent)
  const errors = [
    ...(versionCheck.error === undefined ? [] : [versionCheck.error]),
    ...(agentsCheck.error === undefined ? [] : [agentsCheck.error]),
    ...(version === undefined ? ['Unable to parse AGY version from --version output'] : []),
    ...(options.minimumVersion !== undefined && !versionSupported
      ? [`AGY version ${version ?? 'unknown'} is below the required minimum ${options.minimumVersion}`]
      : []),
    ...(options.expectedAgent !== undefined && !agentAvailable
      ? [`AGY Agent "${redactText(options.expectedAgent, 128)}" was not found`] : []),
  ]

  return {
    ok: errors.length === 0,
    executable: source,
    executableSource: source,
    version,
    agents,
    expectedAgent: options.expectedAgent,
    minimumVersion: options.minimumVersion,
    versionSupported,
    agentAvailable,
    errors,
  }
}
