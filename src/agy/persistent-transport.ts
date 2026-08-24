/**
 * Productized persistent transport for AGY 1.1.15 stream-json.
 * Input: {event:"user",message:{role:"user",content:[{type:"text",text}]}} per NDJSON line.
 * Output: {event:"init"} -> {event:"step_update"}* -> {event:"result"} per turn.
 * One AGY process per DSH session, single active turn, idle TTL, before-accept fallback.
 * See findings.md 2026-08-20 V8-M1 and .tmp/v8-m1/three-turn.log.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { encodeAgyUserMessage } from './stream-protocol.js'
import { AgyStreamParser } from './parser.js'
import { buildWindowsNoConsoleLaunch } from './windows-launcher.js'

export type PersistentTransportErrorCode =
  | 'ABORTED'
  | 'DISPOSED'
  | 'EVENT_HANDLER_FAILED'
  | 'FRAME_TOO_LARGE'
  | 'PROTOCOL_ERROR'
  | 'TIMEOUT'
  | 'WORKER_BUSY'
  | 'WORKER_CRASHED'
  | 'WORKER_ERROR'
  | 'WORKER_LIMIT'
  | 'WORKER_START_FAILED'
  | 'WORKER_STOPPED'
  | 'OUTPUT_LIMIT'

export class PersistentTransportError extends Error {
  constructor(
    message: string,
    readonly code: PersistentTransportErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'PersistentTransportError'
  }
}

export type PersistentWorkerState = 'starting' | 'idle' | 'busy' | 'stopping' | 'stopped'

export interface PersistentRequestFrame {
  readonly kind: 'request'
  readonly requestId: string
  readonly sessionId: string
  readonly text: string
}

export interface PersistentShutdownFrame {
  readonly kind: 'shutdown'
}

export type PersistentOutgoingFrame = PersistentRequestFrame | PersistentShutdownFrame

export interface PersistentIncomingFrame {
  readonly kind: 'init' | 'step_update' | 'result'
  readonly conversationId?: string
  readonly raw?: unknown
}

export interface PersistentTransportRequest {
  readonly sessionId: string
  readonly text: string
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  readonly onEvent?: (payload: unknown) => void
}

export interface PersistentTransportResult {
  readonly requestId: string
  readonly sessionId: string
  readonly events: readonly unknown[]
  readonly durationMs: number
  readonly firstEventMs?: number
}

export interface ExperimentalAgyTransportOptions {
  readonly executable: string
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  readonly maxWorkers?: number
  readonly maxFrameBytes?: number
  readonly maxOutputBytes?: number
  readonly maxStderrBytes?: number
  readonly idleTtlMs?: number
  readonly readyTimeoutMs?: number
  readonly shutdownTimeoutMs?: number
  readonly defaultRequestTimeoutMs?: number
}

export interface PersistentTransportStats {
  readonly totalWorkers: number
  readonly startingWorkers: number
  readonly idleWorkers: number
  readonly busyWorkers: number
  readonly stoppingWorkers: number
  readonly maxWorkers: number
  readonly disposed: boolean
}

interface NormalizedOptions {
  readonly executable: string
  readonly args: readonly string[]
  readonly cwd: string | undefined
  readonly env: NodeJS.ProcessEnv | undefined
  readonly maxWorkers: number
  readonly maxFrameBytes: number
  readonly maxOutputBytes: number
  readonly maxStderrBytes: number
  readonly idleTtlMs: number
  readonly readyTimeoutMs: number
  readonly shutdownTimeoutMs: number
  readonly defaultRequestTimeoutMs: number
}

interface ActiveRequest {
  readonly requestId: string
  readonly sessionId: string
  readonly startedAt: number
  readonly maxOutputBytes: number
  readonly events: unknown[]
  readonly onEvent: ((payload: unknown) => void) | undefined
  readonly signal: AbortSignal | undefined
  readonly resolve: (result: PersistentTransportResult) => void
  readonly reject: (error: unknown) => void
  outputBytes: number
  firstEventAt: number | undefined
  timer: ReturnType<typeof setTimeout> | undefined
  abortListener: (() => void) | undefined
}

const DEFAULT_MAX_WORKERS = 8
const DEFAULT_MAX_FRAME_BYTES = 256 * 1024
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024
const DEFAULT_IDLE_TTL_MS = 30_000
const DEFAULT_READY_TIMEOUT_MS = 5_000
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 1_000
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function validateInteger(name: string, value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

function normalizeOptions(options: ExperimentalAgyTransportOptions): NormalizedOptions {
  if (options.executable.trim().length === 0) {
    throw new RangeError('executable must not be empty')
  }
  return {
    executable: options.executable,
    args: options.args ?? [],
    cwd: options.cwd,
    env: options.env,
    maxWorkers: validateInteger('maxWorkers', options.maxWorkers ?? DEFAULT_MAX_WORKERS, 1, 64),
    maxFrameBytes: validateInteger('maxFrameBytes', options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES, 128, 16 * 1024 * 1024),
    maxOutputBytes: validateInteger('maxOutputBytes', options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, 1, 64 * 1024 * 1024),
    maxStderrBytes: validateInteger('maxStderrBytes', options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES, 1, 8 * 1024 * 1024),
    idleTtlMs: validateInteger('idleTtlMs', options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS, 0, 3_600_000),
    readyTimeoutMs: validateInteger('readyTimeoutMs', options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS, 1, 60_000),
    shutdownTimeoutMs: validateInteger('shutdownTimeoutMs', options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS, 1, 60_000),
    defaultRequestTimeoutMs: validateInteger(
      'defaultRequestTimeoutMs',
      options.defaultRequestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      1,
      3_600_000,
    ),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

/** Encode one bounded NDJSON frame, including its trailing newline. */
export function encodePersistentFrame(
  frame: PersistentOutgoingFrame,
  maxFrameBytes: number,
): string {
  const line = JSON.stringify(frame)
  if (line === undefined) {
    throw new PersistentTransportError('Persistent transport frame could not be encoded', 'PROTOCOL_ERROR')
  }
  const encoded = `${line}\n`
  if (byteLength(encoded) > maxFrameBytes) {
    throw new PersistentTransportError(
      'Persistent transport input frame exceeds the configured limit',
      'FRAME_TOO_LARGE',
    )
  }
  return encoded
}

/** Parse and validate the small protocol envelope; payload remains opaque. */
export function parsePersistentFrame(line: string): PersistentIncomingFrame {
  if (line.trim().length === 0) {
    throw new PersistentTransportError('Persistent transport emitted an empty frame', 'PROTOCOL_ERROR')
  }
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch (error) {
    throw new PersistentTransportError('Persistent transport emitted malformed JSON', 'PROTOCOL_ERROR', {
      cause: error,
    })
  }
  if (!isRecord(value) || typeof value.kind !== 'string'
    || !['ready', 'event', 'complete', 'error'].includes(value.kind)) {
    throw new PersistentTransportError('Persistent transport emitted an invalid frame envelope', 'PROTOCOL_ERROR')
  }
  if (value.requestId !== undefined && typeof value.requestId !== 'string') {
    throw new PersistentTransportError('Persistent transport frame requestId is invalid', 'PROTOCOL_ERROR')
  }
  if (value.sessionId !== undefined && typeof value.sessionId !== 'string') {
    throw new PersistentTransportError('Persistent transport frame sessionId is invalid', 'PROTOCOL_ERROR')
  }
  return {
    kind: value.kind as PersistentIncomingFrame['kind'],
    ...(value.requestId === undefined ? {} : { requestId: value.requestId }),
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
    ...(Object.hasOwn(value, 'payload') ? { payload: value.payload } : {}),
    ...(value.message === undefined ? {} : { message: String(value.message).slice(0, 256) }),
  }
}

/** Real AGY 1.1.15 output envelope: init | step_update | result */
function parseAgyOutputLine(line: string): { event: string; raw: unknown } {
  if (line.trim().length === 0) {
    throw new PersistentTransportError('Persistent AGY emitted an empty line', 'PROTOCOL_ERROR')
  }
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch (error) {
    throw new PersistentTransportError('Persistent AGY emitted malformed JSON', 'PROTOCOL_ERROR', { cause: error })
  }
  if (!isRecord(value) || typeof value.event !== 'string') {
    throw new PersistentTransportError('Persistent AGY output missing event field', 'PROTOCOL_ERROR')
  }
  return { event: value.event, raw: value }
}

function terminateWorkerTree(child: ChildProcessWithoutNullStreams): void {
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
    const fallback = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // The child may have exited while taskkill was traversing the tree.
      }
    }, 250)
    try {
      // Ask the direct child to close immediately so the parent can finish
      // its lifecycle without waiting for taskkill's process to exit.
      child.kill()
    } catch {
      // taskkill remains responsible for descendants and the close handler
      // still completes the worker state transition.
    }
    killer.once('error', () => {
      clearTimeout(fallback)
      try {
        child.kill()
      } catch {
        // The child may already be closed.
      }
    })
    killer.once('close', () => clearTimeout(fallback))
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

function errorFromUnknown(
  error: unknown,
  fallbackCode: PersistentTransportErrorCode,
  fallbackMessage: string,
): PersistentTransportError {
  if (error instanceof PersistentTransportError) return error
  return new PersistentTransportError(fallbackMessage, fallbackCode, {
    cause: error instanceof Error ? error : new Error(String(error)),
  })
}

class PersistentAgyWorker {
  private readonly options: NormalizedOptions
  private readonly sessionId: string
  private readonly onStopped: (worker: PersistentAgyWorker) => void
  private state: PersistentWorkerState = 'starting'
  private child: ChildProcessWithoutNullStreams | undefined
  private active: ActiveRequest | undefined
  private conversationId: string | undefined
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private startPromise: Promise<void> | undefined
  private closePromise: Promise<void> = Promise.resolve()
  private closeResolve: (() => void) | undefined
  private closed = true
  private notifiedStopped = false
  private stdoutBuffer = ''
  private stderrBytes = 0
  private readyResolve: (() => void) | undefined
  private readyReject: ((error: unknown) => void) | undefined
  private readySettled = false

  constructor(
    sessionId: string,
    options: NormalizedOptions,
    onStopped: (worker: PersistentAgyWorker) => void,
  ) {
    this.sessionId = sessionId
    this.options = options
    this.onStopped = onStopped
  }

  getState(): PersistentWorkerState {
    return this.state
  }

  async start(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'stopping') {
      throw new PersistentTransportError('Persistent AGY worker is stopped', 'WORKER_STOPPED')
    }
    if (this.state === 'idle' || this.state === 'busy') return
    if (this.startPromise !== undefined) return this.startPromise
    this.startPromise = this.spawnAndWaitForReady()
    try {
      await this.startPromise
    } finally {
      this.startPromise = undefined
    }
  }

  async request(input: PersistentTransportRequest): Promise<PersistentTransportResult> { // text-based
    await this.start()
    if (this.state !== 'idle') {
      throw new PersistentTransportError('Persistent AGY worker already has an active request', 'WORKER_BUSY')
    }
    if (input.signal?.aborted) {
      await this.stop('reset')
      throw new PersistentTransportError('Persistent AGY request aborted before write', 'ABORTED')
    }
    const timeoutMs = input.timeoutMs ?? this.options.defaultRequestTimeoutMs
    validateInteger('timeoutMs', timeoutMs, 1, 3_600_000)
    const maxOutputBytes = Math.min(
      input.maxOutputBytes ?? this.options.maxOutputBytes,
      this.options.maxOutputBytes,
    )
    validateInteger('maxOutputBytes', maxOutputBytes, 1, this.options.maxOutputBytes)
    this.clearIdleTimer()
    this.state = 'busy'

    return new Promise<PersistentTransportResult>((resolve, reject) => {
      const active: ActiveRequest = {
        requestId: randomUUID(),
        sessionId: this.sessionId,
        startedAt: Date.now(),
        maxOutputBytes,
        events: [],
        onEvent: input.onEvent,
        signal: input.signal,
        resolve,
        reject,
        outputBytes: 0,
        firstEventAt: undefined,
        timer: undefined,
        abortListener: undefined,
      }
      this.active = active
      active.abortListener = () => this.failActiveAndReset(
        new PersistentTransportError('Persistent AGY request aborted', 'ABORTED'),
      )
      input.signal?.addEventListener('abort', active.abortListener, { once: true })
      active.timer = setTimeout(() => this.failActiveAndReset(
        new PersistentTransportError('Persistent AGY request exceeded its timeout', 'TIMEOUT'),
      ), timeoutMs)
      void this.sendRequest(active, input.text)
    })
  }

  async stop(reason: 'dispose' | 'idle' | 'reset' = 'dispose'): Promise<void> {
    if (this.state === 'stopped') return
    if (this.state === 'stopping') {
      await this.closePromise
      return
    }
    this.clearIdleTimer()
    if (this.state === 'starting') {
      this.rejectReady(reason === 'dispose'
        ? new PersistentTransportError(
          'Persistent AGY transport was disposed during worker startup',
          'DISPOSED',
        )
        : new PersistentTransportError(
          'Persistent AGY worker stopped before startup completed',
          'WORKER_STOPPED',
        ))
    }
    if (this.active !== undefined) {
      this.settleActiveError(new PersistentTransportError(
        reason === 'dispose'
          ? 'Persistent AGY transport was disposed'
          : 'Persistent AGY worker was stopped before request completion',
        reason === 'dispose' ? 'DISPOSED' : 'WORKER_STOPPED',
      ))
    }
    this.state = 'stopping'
    const child = this.child
    if (child === undefined || this.closed) {
      this.state = 'stopped'
      this.notifyStopped()
      return
    }

    if (reason === 'dispose' || reason === 'idle') {
      try {
        child.stdin.end()
      } catch {
        // The close handler below still performs the final state transition.
      }
      await Promise.race([this.closePromise, delay(this.options.shutdownTimeoutMs)])
    }
    if (!this.closed) terminateWorkerTree(child)
    await this.closePromise
  }

  private async spawnAndWaitForReady(): Promise<void> {
    this.state = 'starting'
    this.closed = false
    this.stdoutBuffer = ''
    this.stderrBytes = 0
    this.readySettled = false
    this.closePromise = new Promise(resolve => { this.closeResolve = resolve })
    const readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    try {
      const launch = process.platform === 'win32'
        ? buildWindowsNoConsoleLaunch(this.options.executable, this.options.args)
        : { executable: this.options.executable, args: this.options.args }
      const child = spawn(launch.executable, [...launch.args], {
        cwd: this.options.cwd,
        env: {
          ...process.env,
          ...this.options.env,
          DSH_AGY_EXPERIMENTAL_SESSION: this.sessionId,
        },
        shell: false,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      this.child = child
      this.attachChild(child)
      const timeout = setTimeout(() => {
        this.rejectReady(new PersistentTransportError(
          'Persistent AGY worker did not become ready in time',
          'WORKER_START_FAILED',
        ))
      }, this.options.readyTimeoutMs)
      try {
        await readyPromise
      } finally {
        clearTimeout(timeout)
      }
      const stateAfterReady = this.getState()
      if (stateAfterReady === 'stopped' || stateAfterReady === 'stopping') {
        throw new PersistentTransportError('Persistent AGY worker stopped during startup', 'WORKER_START_FAILED')
      }
      this.state = 'idle'
      this.armIdleTimer()
    } catch (error) {
      const mapped = errorFromUnknown(error, 'WORKER_START_FAILED', 'Persistent AGY worker failed to start')
      await this.stop('reset')
      throw mapped
    } finally {
      this.readyResolve = undefined
      this.readyReject = undefined
    }
  }

  private attachChild(child: ChildProcessWithoutNullStreams): void {
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.handleStdout(chunk))
    child.stderr.on('data', (chunk: string) => {
      this.stderrBytes += byteLength(chunk)
      if (this.stderrBytes > this.options.maxStderrBytes) {
        this.failActiveAndReset(new PersistentTransportError(
          'Persistent AGY worker stderr exceeded its capture limit',
          'OUTPUT_LIMIT',
        ))
      }
    })
    child.once('error', error => {
      const code: PersistentTransportErrorCode = this.state === 'starting'
        ? 'WORKER_START_FAILED'
        : 'WORKER_CRASHED'
      const mapped = new PersistentTransportError(
        code === 'WORKER_START_FAILED'
          ? 'Persistent AGY worker could not be started'
          : 'Persistent AGY worker process failed',
        code,
        { cause: error },
      )
      this.rejectReady(mapped)
      if (this.active !== undefined) this.settleActiveError(mapped)
    })
    child.once('close', (exitCode, signal) => {
      this.closed = true
      this.clearIdleTimer()
      if (!this.readySettled) {
        this.rejectReady(new PersistentTransportError(
          'Persistent AGY worker exited before ready',
          'WORKER_START_FAILED',
        ))
      }
      if (this.active !== undefined) {
        this.settleActiveError(new PersistentTransportError(
          `Persistent AGY worker exited before request completion (${exitCode ?? 'signal'})`,
          'WORKER_CRASHED',
          { cause: signal === null ? undefined : new Error(signal) },
        ))
      }
      this.state = 'stopped'
      this.closeResolve?.()
      this.closeResolve = undefined
      this.notifyStopped()
    })
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk
    let newlineIndex = this.stdoutBuffer.indexOf('\n')
    while (newlineIndex >= 0) {
      const rawLine = this.stdoutBuffer.slice(0, newlineIndex)
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1)
      this.handleLine(rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine)
      newlineIndex = this.stdoutBuffer.indexOf('\n')
    }
  }

  private handleLine(line: string): void {
    let parsed: { event: string; raw: unknown }
    try {
      parsed = parseAgyOutputLine(line)
    } catch (error) {
      this.failActiveAndReset(errorFromUnknown(
        error,
        'PROTOCOL_ERROR',
        'Persistent AGY worker emitted an invalid frame',
      ))
      return
    }
    const event = parsed.event
    const raw = parsed.raw as Record<string, unknown>

    // init is the ready signal (emitted once at worker start)
    if (event === 'init') {
      const convId = typeof raw.conversation_id === 'string' ? raw.conversation_id : undefined
      if (convId !== undefined) this.conversationId = convId
      this.resolveReady()
      return
    }

    const active = this.active
    if (active === undefined) {
      // No active request: ignore stray step_update/result that belong to previous turn already settled
      // But if we get a result without active, treat as protocol error and reset
      if (event === 'result') {
        this.failActiveAndReset(new PersistentTransportError(
          'Persistent AGY worker emitted a result without an active request',
          'PROTOCOL_ERROR',
        ))
      }
      return
    }
    // Track output size
    active.outputBytes += byteLength(`${line}\n`)
    if (active.outputBytes > active.maxOutputBytes) {
      this.failActiveAndReset(new PersistentTransportError(
        'Persistent AGY worker response exceeded its capture limit',
        'OUTPUT_LIMIT',
      ))
      return
    }
    // Verify conversation_id correlation when present
    const resultConv = (raw.result as Record<string, unknown> | undefined)?.conversation_id
      ?? (raw.step_update as Record<string, unknown> | undefined)?.conversation_id
    if (typeof resultConv === 'string' && this.conversationId !== undefined && resultConv !== this.conversationId) {
      this.failActiveAndReset(new PersistentTransportError(
        'Persistent AGY worker conversation_id mismatch',
        'PROTOCOL_ERROR',
      ))
      return
    }
    if (event === 'step_update') {
      active.firstEventAt ??= Date.now()
      active.events.push(raw)
      try {
        active.onEvent?.(raw)
      } catch (error) {
        this.failActiveAndReset(new PersistentTransportError(
          'Persistent AGY worker event handler failed',
          'EVENT_HANDLER_FAILED',
          { cause: error instanceof Error ? error : new Error(String(error)) },
        ))
      }
      return
    }
    if (event === 'result') {
      const result = raw.result as Record<string, unknown> | undefined
      const status = typeof result?.status === 'string' ? result.status : undefined
      if (status !== 'SUCCESS') {
        const errMsg = typeof result?.error === 'string' ? result.error : 'AGY result status ' + status
        this.failActiveAndReset(new PersistentTransportError(
          'Persistent AGY worker returned error result: ' + errMsg.slice(0, 256),
          'WORKER_ERROR',
        ))
        return
      }
      active.firstEventAt ??= Date.now()
      active.events.push(raw)
      try {
        active.onEvent?.(raw)
      } catch (error) {
        this.failActiveAndReset(new PersistentTransportError(
          'Persistent AGY worker event handler failed',
          'EVENT_HANDLER_FAILED',
          { cause: error instanceof Error ? error : new Error(String(error)) },
        ))
        return
      }
      this.settleActiveSuccess()
      return
    }
    // Unknown event: treat as protocol error
    this.failActiveAndReset(new PersistentTransportError(
      'Persistent AGY worker emitted unknown event: ' + event,
      'PROTOCOL_ERROR',
    ))
  }

  private async sendRequest(active: ActiveRequest, text: string): Promise<void> {
    try {
      const frame = encodeAgyUserMessage(text, this.options.maxFrameBytes)
      await this.writeFrame(frame)
    } catch (error) {
      if (this.active !== active) return
      this.failActiveAndReset(errorFromUnknown(
        error,
        'PROTOCOL_ERROR',
        'Persistent AGY request could not be written',
      ))
    }
  }

  private async writeFrame(frame: string): Promise<void> {
    const stdin = this.child?.stdin
    if (stdin === undefined || !stdin.writable) {
      throw new PersistentTransportError('Persistent AGY worker stdin is closed', 'WORKER_STOPPED')
    }
    if (stdin.write(frame)) return
    await new Promise<void>((resolve, reject) => {
      const onDrain = (): void => {
        cleanup()
        resolve()
      }
      const onError = (error: Error): void => {
        cleanup()
        reject(error)
      }
      const cleanup = (): void => {
        stdin.removeListener('drain', onDrain)
        stdin.removeListener('error', onError)
      }
      stdin.once('drain', onDrain)
      stdin.once('error', onError)
    })
  }

  private settleActiveSuccess(): void {
    const active = this.active
    if (active === undefined) return
    this.active = undefined
    this.clearActive(active)
    this.state = 'idle'
    this.armIdleTimer()
    active.resolve({
      requestId: active.requestId,
      sessionId: active.sessionId,
      events: [...active.events],
      durationMs: Date.now() - active.startedAt,
      ...(active.firstEventAt === undefined ? {} : { firstEventMs: active.firstEventAt - active.startedAt }),
    })
  }

  private settleActiveError(error: unknown): void {
    const active = this.active
    if (active === undefined) return
    this.active = undefined
    this.clearActive(active)
    active.reject(error)
  }

  private clearActive(active: ActiveRequest): void {
    if (active.timer !== undefined) clearTimeout(active.timer)
    if (active.abortListener !== undefined) active.signal?.removeEventListener('abort', active.abortListener)
    active.abortListener = undefined
  }

  private failActiveAndReset(error: unknown): void {
    this.settleActiveError(error)
    void this.stop('reset')
  }

  private resolveReady(): void {
    if (this.readySettled) return
    this.readySettled = true
    this.readyResolve?.()
  }

  private rejectReady(error: unknown): void {
    if (this.readySettled) return
    this.readySettled = true
    this.readyReject?.(error)
  }

  private armIdleTimer(): void {
    this.clearIdleTimer()
    if (this.options.idleTtlMs === 0 || this.state !== 'idle') return
    this.idleTimer = setTimeout(() => { void this.stop('idle') }, this.options.idleTtlMs)
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }

  private notifyStopped(): void {
    if (this.notifiedStopped) return
    this.notifiedStopped = true
    this.onStopped(this)
  }
}

/**
 * Experimental worker-per-session transport. It is intentionally not wired
 * into AgyAdapter; callers must opt into this prototype directly.
 */
export class ExperimentalAgyTransport {
  private readonly options: NormalizedOptions
  private readonly workers = new Map<string, PersistentAgyWorker>()
  private disposed = false

  constructor(options: ExperimentalAgyTransportOptions) {
    this.options = normalizeOptions(options)
  }

  async request(input: PersistentTransportRequest): Promise<PersistentTransportResult> {
    if (this.disposed) {
      throw new PersistentTransportError('Persistent AGY transport is disposed', 'DISPOSED')
    }
    if (input.sessionId.trim().length === 0) {
      throw new RangeError('sessionId must not be empty')
    }
    let worker = this.workers.get(input.sessionId)
    if (worker?.getState() === 'stopped') {
      this.workers.delete(input.sessionId)
      worker = undefined
    }
    if (worker === undefined) {
      if (this.workers.size >= this.options.maxWorkers) {
        throw new PersistentTransportError(
          'Persistent AGY worker limit reached',
          'WORKER_LIMIT',
        )
      }
      worker = new PersistentAgyWorker(input.sessionId, this.options, stoppedWorker => {
        if (this.workers.get(input.sessionId) === stoppedWorker) this.workers.delete(input.sessionId)
      })
      this.workers.set(input.sessionId, worker)
    }
    try {
      return await worker.request(input)
    } catch (error) {
      if (worker.getState() === 'stopped') this.workers.delete(input.sessionId)
      throw error
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const workers = [...this.workers.values()]
    await Promise.all(workers.map(worker => worker.stop('dispose')))
    this.workers.clear()
  }

  getStats(): PersistentTransportStats {
    let startingWorkers = 0
    let idleWorkers = 0
    let busyWorkers = 0
    let stoppingWorkers = 0
    for (const worker of this.workers.values()) {
      switch (worker.getState()) {
        case 'starting': startingWorkers += 1; break
        case 'idle': idleWorkers += 1; break
        case 'busy': busyWorkers += 1; break
        case 'stopping': stoppingWorkers += 1; break
        case 'stopped': break
      }
    }
    return {
      totalWorkers: this.workers.size,
      startingWorkers,
      idleWorkers,
      busyWorkers,
      stoppingWorkers,
      maxWorkers: this.options.maxWorkers,
      disposed: this.disposed,
    }
  }
}
