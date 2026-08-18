export interface SessionRecord {
  readonly sessionId: string
  readonly conversationId: string
  readonly updatedAt: number
}

export interface SessionStore {
  get(sessionId: string): SessionRecord | undefined
  set(sessionId: string, conversationId: string): SessionRecord
  delete(sessionId: string): boolean
  clear(): void
}

/** In-memory mapping; losing it on plugin restart falls back to full DSH history. */
export class InMemorySessionStore implements SessionStore {
  private readonly records = new Map<string, SessionRecord>()

  get(sessionId: string): SessionRecord | undefined {
    const record = this.records.get(sessionId)
    return record === undefined ? undefined : { ...record }
  }

  set(sessionId: string, conversationId: string): SessionRecord {
    const record: SessionRecord = {
      sessionId,
      conversationId,
      updatedAt: Date.now(),
    }
    this.records.set(sessionId, record)
    return { ...record }
  }

  delete(sessionId: string): boolean {
    return this.records.delete(sessionId)
  }

  clear(): void {
    this.records.clear()
  }
}

/** Serialize calls for one Session while allowing different Sessions to run concurrently. */
export class SessionRegistry implements SessionStore {
  private readonly store: SessionStore
  private readonly locks = new Map<string, Promise<void>>()

  constructor(store: SessionStore = new InMemorySessionStore()) {
    this.store = store
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.store.get(sessionId)
  }

  set(sessionId: string, conversationId: string): SessionRecord {
    return this.store.set(sessionId, conversationId)
  }

  delete(sessionId: string): boolean {
    return this.store.delete(sessionId)
  }

  clear(): void {
    this.store.clear()
  }

  async acquire(sessionId: string): Promise<() => void> {
    const previous = this.locks.get(sessionId) ?? Promise.resolve()
    let releaseCurrent!: () => void
    const current = new Promise<void>(resolve => { releaseCurrent = resolve })
    const tail = previous.then(() => current)
    this.locks.set(sessionId, tail)
    await previous

    let released = false
    return () => {
      if (released) return
      released = true
      releaseCurrent()
      if (this.locks.get(sessionId) === tail) this.locks.delete(sessionId)
    }
  }
}
