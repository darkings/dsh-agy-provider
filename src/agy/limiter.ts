export type AgyQueueErrorCode = 'QUEUE_FULL' | 'QUEUE_TIMEOUT' | 'ABORTED'

export class AgyQueueError extends Error {
  constructor(
    message: string,
    readonly code: AgyQueueErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'AgyQueueError'
  }
}

export interface AgyConcurrencyOptions {
  maxConcurrent: number
  maxQueue: number
  queueTimeoutMs: number
}

export interface AgyConcurrencyStats extends AgyConcurrencyOptions {
  active: number
  queued: number
}

type Release = () => void

interface QueueEntry {
  readonly resolve: (release: Release) => void
  readonly reject: (error: unknown) => void
  readonly signal: AbortSignal | undefined
  readonly onAbort: () => void
  timer: ReturnType<typeof setTimeout> | undefined
  settled: boolean
}

function validateInteger(name: string, value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

/** FIFO limiter for AGY child processes, with bounded queue and cancellation. */
export class AgyConcurrencyLimiter {
  private readonly maxConcurrent: number
  private readonly maxQueue: number
  private readonly queueTimeoutMs: number
  private active = 0
  private readonly queue: QueueEntry[] = []

  constructor(options: AgyConcurrencyOptions) {
    this.maxConcurrent = validateInteger('maxConcurrent', options.maxConcurrent, 1, 64)
    this.maxQueue = validateInteger('maxQueue', options.maxQueue, 0, 256)
    this.queueTimeoutMs = validateInteger('queueTimeoutMs', options.queueTimeoutMs, 0, 3_600_000)
  }

  getStats(): AgyConcurrencyStats {
    return {
      active: this.active,
      queued: this.queue.length,
      maxConcurrent: this.maxConcurrent,
      maxQueue: this.maxQueue,
      queueTimeoutMs: this.queueTimeoutMs,
    }
  }

  acquire(signal?: AbortSignal): Promise<Release> {
    if (signal?.aborted) {
      return Promise.reject(new AgyQueueError('AGY request aborted while waiting for a process slot', 'ABORTED'))
    }
    if (this.active < this.maxConcurrent) {
      this.active += 1
      return Promise.resolve(this.createRelease())
    }
    if (this.queue.length >= this.maxQueue) {
      return Promise.reject(new AgyQueueError('AGY process queue is full', 'QUEUE_FULL'))
    }

    return new Promise<Release>((resolve, reject) => {
      const entry: QueueEntry = {
        resolve,
        reject,
        signal,
        onAbort: () => this.rejectEntry(entry, new AgyQueueError(
          'AGY request aborted while waiting for a process slot',
          'ABORTED',
        )),
        timer: undefined,
        settled: false,
      }
      if (this.queueTimeoutMs > 0) {
        entry.timer = setTimeout(() => this.rejectEntry(entry, new AgyQueueError(
          'AGY request exceeded the process queue timeout',
          'QUEUE_TIMEOUT',
        )), this.queueTimeoutMs)
      }
      signal?.addEventListener('abort', entry.onAbort, { once: true })
      this.queue.push(entry)
      this.drain()
    })
  }

  private createRelease(): Release {
    let released = false
    return () => {
      if (released) return
      released = true
      this.active -= 1
      this.drain()
    }
  }

  private rejectEntry(entry: QueueEntry, error: unknown): void {
    if (entry.settled) return
    const index = this.queue.indexOf(entry)
    if (index >= 0) this.queue.splice(index, 1)
    entry.settled = true
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    entry.signal?.removeEventListener('abort', entry.onAbort)
    entry.reject(error)
  }

  private resolveEntry(entry: QueueEntry): void {
    if (entry.settled) return
    entry.settled = true
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    entry.signal?.removeEventListener('abort', entry.onAbort)
    this.active += 1
    entry.resolve(this.createRelease())
  }

  private drain(): void {
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      const entry = this.queue.shift()
      if (entry === undefined) return
      if (entry.settled) continue
      if (entry.signal?.aborted) {
        this.rejectEntry(entry, new AgyQueueError(
          'AGY request aborted while waiting for a process slot',
          'ABORTED',
        ))
        continue
      }
      this.resolveEntry(entry)
    }
  }
}
