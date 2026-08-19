import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AgyAdapter } from '../lib/provider/agy.js'
import { diagnoseDshContext, DshContextError, resolveDshContext } from '../lib/dsh/context.js'

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

test('resolveDshContext preserves the DSH-selected permission and approval mode', async () => {
  const cwd = await realpath(process.cwd())
  for (const selection of [
    { mode: 'read-only', preset: 'read-only', approval: 'ask' },
    { mode: 'workspace-write', preset: 'workspace-write', approval: 'ask' },
    { mode: 'danger-full-access', preset: 'danger-full-access', approval: 'never' },
  ]) {
    const session = {
      id: `session-${selection.preset}`,
      header: { id: `session-${selection.preset}`, cwd },
      events: [],
    }
    const snapshot = await resolveDshContext(lookup({
      sessions: { get: id => id === session.id ? session : undefined },
      workspaceRegistry: {
        resolveByPath: async path => ({
          path,
          sessionIds: [session.id],
          status: async () => 'ok',
        }),
      },
      sandboxPolicy: { resolve: () => ({ mode: selection.mode, workspaceRoot: cwd }) },
      permissionPresets: { current: () => selection.preset },
      approval: { config: { policy: selection.approval }, overrideOf: () => undefined },
    }), { sessionId: session.id, toolSchemaCount: 1 })

    assert.deepEqual({
      sandboxMode: snapshot.sandboxMode,
      permissionPreset: snapshot.permissionPreset,
      approvalPolicy: snapshot.approvalPolicy,
    }, {
      sandboxMode: selection.mode,
      permissionPreset: selection.preset,
      approvalPolicy: selection.approval,
    })
  }
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

test('diagnoseDshContext returns only allowlisted capability labels', async () => {
  const { context, cwd } = await trustedContext()
  const report = await diagnoseDshContext(context, { sessionId: 'session-1', toolSchemaCount: 2 })

  assert.equal(report.schemaVersion, 1)
  assert.equal(report.session.state, 'available')
  assert.equal(report.session.idPresent, true)
  assert.equal(report.workspace.state, 'trusted')
  assert.equal(report.sandbox.mode, 'workspace-write')
  assert.equal(report.permission.preset, 'workspace-write')
  assert.equal(report.approval.policy, 'ask')
  assert.deepEqual(report.issueCodes, [])
  assert.equal(JSON.stringify(report).includes(cwd), false)
  assert.equal(JSON.stringify(report).includes('session-1'), false)
})

test('diagnoseDshContext classifies missing services and unknown sessions without paths', async () => {
  const unknown = await diagnoseDshContext(lookup({
    sessions: { get: () => undefined },
  }), { sessionId: 'missing-session', toolSchemaCount: 1 })
  assert.equal(unknown.session.state, 'unknown')
  assert.deepEqual(unknown.issueCodes, ['DSH_SESSION_UNKNOWN'])

  const unavailable = await diagnoseDshContext(lookup({}), {
    sessionId: 'session-1',
    toolSchemaCount: 1,
  })
  assert.equal(unavailable.session.state, 'unavailable')
  assert.deepEqual(unavailable.issueCodes, ['DSH_SESSION_UNAVAILABLE'])
  assert.equal(JSON.stringify(unavailable).includes('session-1'), false)

  const required = await diagnoseDshContext(undefined, { toolSchemaCount: 1 })
  assert.equal(required.session.state, 'required')
  assert.deepEqual(required.issueCodes, ['DSH_SESSION_REQUIRED'])
})

test('resolveDshContext canonicalizes symlinked workspace and sandbox roots', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-context-symlink-'))
  try {
    const realWorkspace = join(root, 'real-workspace')
    const linkedWorkspace = join(root, 'linked-workspace')
    await mkdir(realWorkspace, { recursive: true })
    try {
      await symlink(realWorkspace, linkedWorkspace, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      if (process.platform === 'win32' && error?.code === 'EPERM') {
        t.skip('symlink/junction creation is unavailable in this Windows runner')
        return
      }
      throw error
    }

    const session = {
      id: 'session-symlink',
      header: { id: 'session-symlink', cwd: linkedWorkspace },
      events: [],
    }
    const context = lookup({
      sessions: { get: () => session },
      workspaceRegistry: {
        resolveByPath: async path => ({ path, sessionIds: [session.id], status: async () => 'ok' }),
      },
      sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: realWorkspace }) },
      permissionPresets: { current: () => 'workspace-write' },
      approval: { config: { policy: 'ask' }, overrideOf: () => undefined },
    })

    const snapshot = await resolveDshContext(context, { sessionId: session.id, toolSchemaCount: 1 })
    assert.equal(snapshot.workspaceState, 'trusted')
    assert.equal(snapshot.sandboxMode, 'workspace-write')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
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
