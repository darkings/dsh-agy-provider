import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'

export type ProcessTermination = 'completed' | 'non-zero' | 'signaled' | 'aborted' | 'timeout' | 'output-limit'

export const AGY_REASONING_EFFORTS = ['low', 'medium', 'high'] as const
export type AgyReasoningEffort = typeof AGY_REASONING_EFFORTS[number]

export const AGY_EXECUTION_MODES = ['plan', 'accept-edits'] as const
export type AgyExecutionMode = typeof AGY_EXECUTION_MODES[number]

export function isAgyReasoningEffort(value: unknown): value is AgyReasoningEffort {
  return typeof value === 'string'
    && (AGY_REASONING_EFFORTS as readonly string[]).includes(value)
}

export function isAgyExecutionMode(value: unknown): value is AgyExecutionMode {
  return typeof value === 'string'
    && (AGY_EXECUTION_MODES as readonly string[]).includes(value)
}

export class AgyProcessError extends Error {
  constructor(
    message: string,
    readonly code: 'ABORTED' | 'SPAWN_FAILED' | 'OUTPUT_HANDLER_FAILED' | 'OUTPUT_LIMIT',
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'AgyProcessError'
  }
}

export interface ProcessRequest {
  executable: string
  args: readonly string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  /** Maximum captured stdout bytes; omitted means unlimited. */
  maxStdoutBytes?: number
  /** Maximum captured stderr bytes; omitted means unlimited. */
  maxStderrBytes?: number
  signal?: AbortSignal
  /** Called synchronously for each complete stdout line as it arrives. */
  onStdoutLine?: (line: string) => void
}

export interface ProcessResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  termination: ProcessTermination
  stdoutLines: readonly string[]
  stderr: string
  durationMs: number
}

export interface AgyRequest extends Omit<ProcessRequest, 'executable' | 'args'> {
  executable?: string
  prompt: string
  agent?: string
  model?: string
  conversation?: string
  reasoningEffort?: AgyReasoningEffort
  /** Explicit AGY directories made available to the selected Agent. */
  addDirs?: readonly string[]
  /** Bounded AGY execution mode selected by an Agent preset. */
  mode?: AgyExecutionMode
  /** Disable slash commands for bundled non-interactive presets. */
  disableSlashCommands?: boolean
  /** Absolute temporary JSON Schema path passed to AGY's final-result validator. */
  jsonSchemaPath?: string
}

export function defaultAgyCommand(): 'agy.exe' | 'agy' {
  return process.platform === 'win32' ? 'agy.exe' : 'agy'
}

function terminateProcessTree(child: ChildProcess): void {
  const pid = child.pid
  if (pid === undefined) {
    child.kill()
    return
  }
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    })
    killer.once('error', () => child.kill())
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

/**
 * Resolve an explicit AGY path, AGY_PATH/AGY_EXECUTABLE, or an executable on
 * PATH. Returning the bare command in the final fallback lets spawn produce
 * the platform-native diagnostic if PATH changes between discovery and run.
 */
export function resolveAgyExecutable(explicit?: string): string {
  const configured = explicit?.trim()
    || process.env.AGY_PATH?.trim()
    || process.env.AGY_EXECUTABLE?.trim()
  if (configured !== undefined && configured.length > 0) return resolve(configured)

  const command = defaultAgyCommand()
  const pathEntries = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const suffixes = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : ['']
  for (const directory of pathEntries) {
    const direct = join(directory, command)
    if (existsSync(direct)) return direct
    if (process.platform === 'win32' && !command.includes('.')) {
      for (const suffix of suffixes) {
        const candidate = join(directory, `${command}${suffix.toLowerCase()}`)
        if (existsSync(candidate)) return candidate
      }
    }
  }
  return command
}

/** Build AGY's print-mode argv without invoking a shell. */
export function buildAgyArgs(
  request: Pick<
    AgyRequest,
    | 'prompt'
    | 'agent'
    | 'model'
    | 'conversation'
    | 'reasoningEffort'
    | 'addDirs'
    | 'mode'
    | 'disableSlashCommands'
    | 'jsonSchemaPath'
  >,
): string[] {
  if (request.reasoningEffort !== undefined && !isAgyReasoningEffort(request.reasoningEffort)) {
    throw new TypeError('AGY reasoning effort must be one of: low, medium, high')
  }
  if (request.mode !== undefined && !isAgyExecutionMode(request.mode)) {
    throw new TypeError('AGY execution mode must be one of: plan, accept-edits')
  }
  if (request.addDirs?.some(directory => typeof directory !== 'string' || directory.trim().length === 0)) {
    throw new TypeError('AGY add-dir entries must be non-empty paths')
  }
  if (request.jsonSchemaPath !== undefined && request.jsonSchemaPath.trim().length === 0) {
    throw new TypeError('AGY json-schema path must be non-empty')
  }
  return [
    '-p', request.prompt,
    ...(request.agent === undefined ? [] : ['--agent', request.agent]),
    ...(request.model === undefined ? [] : ['--model', request.model]),
    ...(request.conversation === undefined ? [] : ['--conversation', request.conversation]),
    ...(request.reasoningEffort === undefined ? [] : ['--effort', request.reasoningEffort]),
    ...(request.addDirs?.flatMap(directory => ['--add-dir', directory]) ?? []),
    ...(request.mode === undefined ? [] : ['--mode', request.mode]),
    ...(request.disableSlashCommands === true ? ['--disable-slash-commands'] : []),
    ...(request.jsonSchemaPath === undefined ? [] : ['--json-schema', request.jsonSchemaPath]),
    '--output-format', 'stream-json',
  ]
}

function splitLines(buffer: string, final: boolean): { lines: string[]; remainder: string } {
  const parts = buffer.split(/\r?\n/)
  const remainder = parts.pop() ?? ''
  if (final && remainder.length > 0) {
    parts.push(remainder.replace(/\r$/, ''))
    return { lines: parts, remainder: '' }
  }
  return { lines: parts, remainder }
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

/**
 * Run a process with piped output and deterministic lifecycle handling.
 * stdout is delivered line-by-line while the process is running; the result
 * also retains the lines for tests and adapters that do not need live output.
 */
export function runProcess(request: ProcessRequest): Promise<ProcessResult> {
  if (request.signal?.aborted) {
    return Promise.reject(new AgyProcessError('AGY process aborted before start', 'ABORTED'))
  }

  const startedAt = Date.now()
  const child = spawn(request.executable, [...request.args], {
    cwd: request.cwd,
    env: request.env === undefined ? process.env : { ...process.env, ...request.env },
    shell: false,
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  return new Promise<ProcessResult>((resolveResult, rejectResult) => {
    let stdoutBuffer = ''
    let stderr = ''
    let stdoutBytes = 0
    let stderrBytes = 0
    const stdoutLines: string[] = []
    let termination: ProcessTermination | undefined
    let outputHandlerError: unknown
    let settled = false

    const deliver = (line: string): void => {
      stdoutLines.push(line)
      if (request.onStdoutLine === undefined || outputHandlerError !== undefined) return
      try {
        request.onStdoutLine(line)
      } catch (error) {
        outputHandlerError = error
        termination = 'aborted'
        terminateProcessTree(child)
      }
    }

    const flushStdout = (final: boolean): void => {
      const split = splitLines(stdoutBuffer, final)
      stdoutBuffer = split.remainder
      for (const line of split.lines) deliver(line)
    }

    const kill = (reason: Exclude<ProcessTermination, 'completed' | 'non-zero' | 'signaled'>): void => {
      if (termination === undefined) termination = reason
      if (!child.killed) terminateProcessTree(child)
    }

    const abortListener = (): void => kill('aborted')
    request.signal?.addEventListener('abort', abortListener, { once: true })
    const timeout = request.timeoutMs !== undefined && request.timeoutMs > 0
      ? setTimeout(() => kill('timeout'), request.timeoutMs)
      : undefined

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdoutBytes += byteLength(chunk)
      if (request.maxStdoutBytes !== undefined && stdoutBytes > request.maxStdoutBytes) {
        termination = 'output-limit'
        terminateProcessTree(child)
        return
      }
      stdoutBuffer += chunk
      flushStdout(false)
    })
    child.stdout.on('end', () => {
      if (termination !== 'output-limit') flushStdout(true)
    })
    child.stderr.on('data', (chunk: string) => {
      stderrBytes += byteLength(chunk)
      if (request.maxStderrBytes !== undefined && stderrBytes > request.maxStderrBytes) {
        termination = 'output-limit'
        terminateProcessTree(child)
        return
      }
      stderr += chunk
    })
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      if (timeout !== undefined) clearTimeout(timeout)
      request.signal?.removeEventListener('abort', abortListener)
      rejectResult(new AgyProcessError(
        `Unable to start AGY executable (${error.code ?? 'unknown'})`,
        'SPAWN_FAILED',
        { cause: error },
      ))
    })
    child.once('close', (exitCode, signal) => {
      if (settled) return
      settled = true
      if (timeout !== undefined) clearTimeout(timeout)
      request.signal?.removeEventListener('abort', abortListener)
      if (termination !== 'output-limit') flushStdout(true)
      if (outputHandlerError !== undefined) {
        rejectResult(new AgyProcessError(
          'AGY stdout handler failed',
          'OUTPUT_HANDLER_FAILED',
          { cause: outputHandlerError },
        ))
        return
      }
      const finalTermination = termination
        ?? (exitCode === 0 ? 'completed' : signal === null ? 'non-zero' : 'signaled')
      resolveResult({
        exitCode,
        signal,
        termination: finalTermination,
        stdoutLines,
        stderr,
        durationMs: Date.now() - startedAt,
      })
    })
  })
}

export function runAgyProcess(request: AgyRequest): Promise<ProcessResult> {
  const executable = resolveAgyExecutable(request.executable)
  return runProcess({
    ...request,
    executable,
    args: buildAgyArgs(request),
  })
}
