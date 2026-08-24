import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export interface AgyLaunchSpec {
  readonly executable: string
  readonly args: readonly string[]
}

export type WindowsLauncherArchitecture = 'x64' | 'arm64'

export class AgyWindowsLauncherError extends Error {
  constructor(
    message: string,
    readonly code: 'UNSUPPORTED_ARCH' | 'MISSING',
  ) {
    super(message)
    this.name = 'AgyWindowsLauncherError'
  }
}

function launcherArchitecture(arch: string): WindowsLauncherArchitecture {
  if (arch === 'x64') return 'x64'
  if (arch === 'arm64') return 'arm64'
  throw new AgyWindowsLauncherError(
    `No bundled Windows AGY launcher is available for architecture ${arch}`,
    'UNSUPPORTED_ARCH',
  )
}

export function bundledWindowsLauncherPath(
  targetPlatform: NodeJS.Platform = process.platform,
  targetArch: string = process.arch,
): string | undefined {
  if (targetPlatform !== 'win32') return undefined
  const architecture = launcherArchitecture(targetArch)
  return fileURLToPath(new URL(`../../bin/win32-${architecture}/agy-launcher.exe`, import.meta.url))
}

/** Quote one argument using the CommandLineToArgvW/MSVC convention. */
export function quoteWindowsArgument(value: string): string {
  if (value.length === 0) return '""'
  if (!/[\s"]/.test(value)) return value
  let output = '"'
  let backslashes = 0
  for (const character of value) {
    if (character === '\\') {
      backslashes += 1
      continue
    }
    if (character === '"') {
      output += '\\'.repeat(backslashes * 2 + 1)
      output += '"'
      backslashes = 0
      continue
    }
    output += '\\'.repeat(backslashes)
    output += character
    backslashes = 0
  }
  output += '\\'.repeat(backslashes * 2)
  return `${output}"`
}

function childCommandLine(executable: string, args: readonly string[]): string {
  return [executable, ...args].map(quoteWindowsArgument).join(' ')
}

/**
 * Route a Windows console-subsystem AGY executable through the bundled
 * GUI-subsystem launcher. The child command line is UTF-8/base64 encoded so
 * the launcher itself receives only a short, secret-free argument and can
 * pass the original stdin/stdout/stderr handles through unchanged.
 */
export function buildWindowsNoConsoleLaunch(
  executable: string,
  args: readonly string[],
  targetPlatform: NodeJS.Platform = process.platform,
  targetArch: string = process.arch,
): AgyLaunchSpec {
  if (targetPlatform !== 'win32') return { executable, args: [...args] }
  const launcher = bundledWindowsLauncherPath(targetPlatform, targetArch)
  if (launcher === undefined) throw new AgyWindowsLauncherError('Windows launcher is unavailable', 'MISSING')
  const command = childCommandLine(executable, args)
  const encodedCommand = Buffer.from(command, 'utf8').toString('base64')
  return {
    executable: launcher,
    args: ['--command-base64', encodedCommand],
  }
}

export function isWindowsLauncherAvailable(
  targetPlatform: NodeJS.Platform = process.platform,
  targetArch: string = process.arch,
): boolean {
  const launcher = bundledWindowsLauncherPath(targetPlatform, targetArch)
  return launcher !== undefined && existsSync(launcher)
}
