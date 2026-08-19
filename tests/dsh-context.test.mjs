import assert from 'node:assert/strict'
import { realpath } from 'node:fs/promises'
import test from 'node:test'
import { AgyAdapter } from '../lib/provider/agy.js'
import { DshContextError, resolveDshContext } from '../lib/dsh/context.js'

function lookup(services) {
  return {
    get(name) {
      return services[name]
    },
  }
}

async function trustedContext() {
  const cwd = await realpath(process.cwd())
  const session = {
    id: 'session-1',
    header: { id: 'session-1', cwd },
    events: [],
  }
  return {
    cwd,
    session,
    context: lookup({
      sessions: { get: id => id === 'session-1' ? session : undefined },
      workspaceRegistry: {
        resolveByPath: async path => ({
          path,
          sessionIds: ['session-1'],
          status: async () => 'ok',
        }),
      },
      sandboxPolicy: {
        resolve: ({ session: observed }) => {
          assert.equal(observed, session)
          return { mode: 'workspace-write', workspaceRoot: cwd }
        },
      },
      permissionPresets: {
        current: events => {
          assert.equal(events, session.events)
          return 'workspace-write'
        },
      },
      approval: {
        config: { policy: 'ask' },
        overrideOf: observed => {
          assert.equal(observed, session)
          return undefined
        },
      },
    }),
  }
}

test('resolveDshContext keeps text-only requests independent of DSH capability services', async () => {
  const snapshot = await resolveDshContext(undefined, { toolSchemaCount: 0 })

  assert.deepEqual(snapshot, {
    state: 'text-only',
    sessionState: 'not-required',
    workspaceState: 'not-required',
    toolSchemaCount: 0,
  })
  assert.equal(Object.isFrozen(snapshot), true)
})

test('resolveDshContext requires a live session for DSH tools', async () => {
  await assert.rejects(
    () => resolveDshContext(undefined, { toolSchemaCount: 1 }),
    error => error instanceof DshContextError && error.code === 'DSH_SESSION_REQUIRED',
  )
})

test('resolveDshContext distinguishes an unknown session from a missing service', async () => {
  await assert.rejects(
    () => resolveDshContext(lookup({ sessions: { get: () => undefined } }), {
      sessionId: 'missing-session',
      toolSchemaCount: 1,
    }),
    error => error instanceof DshContextError && error.code === 'DSH_SESSION_UNKNOWN',
  )

  await assert.rejects(
    () => resolveDshContext(lookup({}), {
      sessionId: 'session-1',
      toolSchemaCount: 1,
    }),
    error => error instanceof DshContextError && error.code === 'DSH_SESSION_UNAVAILABLE',
  )
})

test('resolveDshContext fails closed for invalid session cwd without leaking the path', async () => {
  const secretPath = 'C:\\private\\provider-secret'
  const context = lookup({
    sessions: {
      get: () => ({ id: 'session-1', header: { id: 'session-1', cwd: secretPath }, events: [] }),
    },
  })

  await assert.rejects(
    () => resolveDshContext(context, { sessionId: 'session-1', toolSchemaCount: 1 }),
    error => error instanceof DshContextError
      && error.code === 'DSH_SESSION_INVALID'
      && !error.message.includes(secretPath),
  )
})

test('resolveDshContext returns an immutable redacted capability snapshot for a trusted session', async () => {
  const { context, cwd } = await trustedContext()
  const snapshot = await resolveDshContext(context, { sessionId: 'session-1', toolSchemaCount: 2 })

  assert.deepEqual(snapshot, {
    state: 'ready',
    sessionState: 'trusted',
    workspaceState: 'trusted',
    sandboxMode: 'workspace-write',
    permissionPreset: 'workspace-write',
    approvalPolicy: 'ask',
    toolSchemaCount: 2,
  })
  assert.equal(Object.isFrozen(snapshot), true)
  assert.equal(JSON.stringify(snapshot).includes(cwd), false)
})

test('resolveDshContext rejects a workspace that does not account for the session', async () => {
  const { context } = await trustedContext()
  const services = {
    get(name) {
      const service = context.get(name)
      if (name !== 'workspaceRegistry') return service
      return {
        resolveByPath: async path => ({ path, sessionIds: [] }),
      }
    },
  }

  await assert.rejects(
    () => resolveDshContext(services, { sessionId: 'session-1', toolSchemaCount: 1 }),
    error => error instanceof DshContextError && error.code === 'DSH_WORKSPACE_MISMATCH',
  )
})

test('AgyAdapter maps an untrusted dsh-owned tool request to a stable DSH error before spawning AGY', async () => {
  let spawned = false
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    toolPolicy: 'dsh-owned',
    modelDiscovery: 'off',
  }, {
    runAgyProcess: async () => {
      spawned = true
      throw new Error('must not spawn')
    },
  })

  await assert.rejects(
    async () => {
      for await (const _chunk of adapter.stream({
        provider: 'agy-test',
        model: 'gemini-test',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        tools: [{ name: 'read', description: 'read', parameters: {} }],
      })) {}
    },
    error => error.code === 'DSH_SESSION_REQUIRED',
  )
  assert.equal(spawned, false)
})
