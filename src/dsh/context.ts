import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, parse } from 'node:path'
import {
  DSH_APPROVAL_UNAVAILABLE_CODE,
  DSH_CONTEXT_UNAVAILABLE_CODE,
  DSH_PERMISSION_UNAVAILABLE_CODE,
  DSH_SANDBOX_UNAVAILABLE_CODE,
  DSH_SESSION_INVALID_CODE,
  DSH_SESSION_REQUIRED_CODE,
  DSH_SESSION_UNAVAILABLE_CODE,
  DSH_SESSION_UNKNOWN_CODE,
  DSH_WORKSPACE_MISMATCH_CODE,
  DSH_WORKSPACE_UNAVAILABLE_CODE,
} from '../provider/error-codes.js'

/** Minimal Cordis reflection seam; no DSH runtime package is required at compile time. */
export interface DshContextLookup {
  get(name: string): unknown
}

/** Read-only shape of the DSH Session surface used by the Provider boundary. */
export interface DshSessionLike {
  readonly id?: string
  readonly header?: {
    readonly id?: string
    readonly cwd?: string
  }
  readonly events?: readonly unknown[]
}

export interface DshSessionStoreLike {
  get(id: string): DshSessionLike | undefined
}

export interface DshWorkspaceLike {
  readonly path?: string
  readonly sessionIds?: readonly string[]
  status?(): Promise<'ok' | 'missing-dir' | string>
}

export interface DshWorkspaceRegistryLike {
  resolveByPath(path: string): Promise<DshWorkspaceLike | undefined>
}

export interface DshSandboxPolicyLike {
  resolve(request: { session: DshSessionLike }): {
    readonly mode?: string
    readonly workspaceRoot?: string
  }
}

export interface DshPermissionPresetServiceLike {
  current(events: readonly unknown[]): unknown
}

export interface DshApprovalServiceLike {
  readonly config?: { readonly policy?: unknown }
  overrideOf(session: DshSessionLike): unknown
}

export interface DshContextServices {
  readonly sessions?: DshSessionStoreLike
  readonly workspaceRegistry?: DshWorkspaceRegistryLike
  readonly sandboxPolicy?: DshSandboxPolicyLike
  readonly permissionPresets?: DshPermissionPresetServiceLike
  readonly approval?: DshApprovalServiceLike
}

export type DshContextState = 'text-only' | 'ready'
export type DshSessionState = 'not-required' | 'trusted'
export type DshWorkspaceState = 'not-required' | 'trusted'
export type DshSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export type DshApprovalPolicy = 'ask' | 'never'
export type DshPermissionPreset = DshSandboxMode | 'unknown'
export type DshServiceAvailability = 'available' | 'missing'

export interface DshContextDiagnostic {
  readonly schemaVersion: 1
  readonly requested: boolean
  readonly toolSchemaCount: number
  readonly services: {
    readonly sessions: DshServiceAvailability
    readonly workspaceRegistry: DshServiceAvailability
    readonly sandboxPolicy: DshServiceAvailability
    readonly permissionPresets: DshServiceAvailability
    readonly approval: DshServiceAvailability
  }
  readonly session: {
    readonly state: 'not-required' | 'required' | 'available' | 'unknown' | 'invalid' | 'unavailable'
    readonly idPresent: boolean
  }
  readonly workspace: {
    readonly state: 'not-required' | 'trusted' | 'mismatch' | 'unavailable' | 'invalid'
  }
  readonly sandbox: {
    readonly state: 'not-required' | 'available' | 'unavailable'
    readonly mode: DshSandboxMode | null
  }
  readonly permission: {
    readonly state: 'not-required' | 'available' | 'unavailable'
    readonly preset: DshPermissionPreset | null
  }
  readonly approval: {
    readonly state: 'not-required' | 'available' | 'unavailable'
    readonly policy: DshApprovalPolicy | null
  }
  readonly issueCodes: readonly string[]
}

/**
 * Request-scoped, immutable capability metadata. Deliberately contains no cwd,
 * workspace path, prompt, tool arguments, or message content.
 */
export interface DshContextSnapshot {
  readonly state: DshContextState
  readonly sessionState: DshSessionState
  readonly workspaceState: DshWorkspaceState
  readonly sandboxMode?: DshSandboxMode
  readonly permissionPreset?: string
  readonly approvalPolicy?: DshApprovalPolicy
  readonly toolSchemaCount: number
}

export type DshContextErrorCode =
  | typeof DSH_APPROVAL_UNAVAILABLE_CODE
  | typeof DSH_CONTEXT_UNAVAILABLE_CODE
  | typeof DSH_PERMISSION_UNAVAILABLE_CODE
  | typeof DSH_SANDBOX_UNAVAILABLE_CODE
  | typeof DSH_SESSION_INVALID_CODE
  | typeof DSH_SESSION_REQUIRED_CODE
  | typeof DSH_SESSION_UNAVAILABLE_CODE
  | typeof DSH_SESSION_UNKNOWN_CODE
  | typeof DSH_WORKSPACE_MISMATCH_CODE
  | typeof DSH_WORKSPACE_UNAVAILABLE_CODE

const ERROR_MESSAGES: Readonly<Record<DshContextErrorCode, string>> = {
  [DSH_APPROVAL_UNAVAILABLE_CODE]: 'DSH approval service is unavailable',
  [DSH_CONTEXT_UNAVAILABLE_CODE]: 'DSH capability context is unavailable',
  [DSH_PERMISSION_UNAVAILABLE_CODE]: 'DSH permission preset service is unavailable',
  [DSH_SANDBOX_UNAVAILABLE_CODE]: 'DSH sandbox policy is unavailable',
  [DSH_SESSION_INVALID_CODE]: 'DSH session metadata is invalid',
  [DSH_SESSION_REQUIRED_CODE]: 'DSH sessionId is required when DSH tools are enabled',
  [DSH_SESSION_UNAVAILABLE_CODE]: 'DSH session service is unavailable',
  [DSH_SESSION_UNKNOWN_CODE]: 'DSH session was not found',
  [DSH_WORKSPACE_MISMATCH_CODE]: 'DSH session workspace is not trusted',
  [DSH_WORKSPACE_UNAVAILABLE_CODE]: 'DSH workspace service is unavailable',
}

/** Stable, path-redacted error at the DSH capability boundary. */
export class DshContextError extends Error {
  readonly code: DshContextErrorCode

  constructor(code: DshContextErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'DshContextError'
    this.code = code
  }
}

function service<T>(context: DshContextLookup | undefined, name: string): T | undefined {
  if (context === undefined) return undefined
  try {
    return context.get(name) as T | undefined
  } catch {
    return undefined
  }
}

/** Read optional DSH services through Cordis reflection, never direct properties. */
export function readDshContextServices(context: DshContextLookup | undefined): DshContextServices {
  const sessions = service<DshSessionStoreLike>(context, 'sessions')
  const workspaceRegistry = service<DshWorkspaceRegistryLike>(context, 'workspaceRegistry')
  const sandboxPolicy = service<DshSandboxPolicyLike>(context, 'sandboxPolicy')
  const permissionPresets = service<DshPermissionPresetServiceLike>(context, 'permissionPresets')
  const approval = service<DshApprovalServiceLike>(context, 'approval')
  return {
    ...(sessions === undefined ? {} : { sessions }),
    ...(workspaceRegistry === undefined ? {} : { workspaceRegistry }),
    ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }),
    ...(permissionPresets === undefined ? {} : { permissionPresets }),
    ...(approval === undefined ? {} : { approval }),
  }
}

function snapshot(
  values: Omit<DshContextSnapshot, 'sandboxMode' | 'permissionPreset' | 'approvalPolicy'> & {
    sandboxMode?: DshSandboxMode
    permissionPreset?: string
    approvalPolicy?: DshApprovalPolicy
  },
): DshContextSnapshot {
  return Object.freeze({
    state: values.state,
    sessionState: values.sessionState,
    workspaceState: values.workspaceState,
    ...(values.sandboxMode === undefined ? {} : { sandboxMode: values.sandboxMode }),
    ...(values.permissionPreset === undefined ? {} : { permissionPreset: values.permissionPreset }),
    ...(values.approvalPolicy === undefined ? {} : { approvalPolicy: values.approvalPolicy }),
    toolSchemaCount: values.toolSchemaCount,
  })
}

async function canonicalDirectory(value: string): Promise<string> {
  if (!isAbsolute(value)) throw new Error('not absolute')
  const canonical = await realpath(value)
  const info = await stat(canonical)
  if (!info.isDirectory() || canonical === parse(canonical).root) throw new Error('not a usable directory')
  return canonical
}

function toolCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return 0
  return Math.trunc(value)
}

function validSandboxMode(value: unknown): value is DshSandboxMode {
  return value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access'
}

function validApprovalPolicy(value: unknown): value is DshApprovalPolicy {
  return value === 'ask' || value === 'never'
}

function safePermissionPreset(value: string | undefined): DshPermissionPreset | null {
  if (value === undefined) return null
  if (validSandboxMode(value)) return value
  return 'unknown'
}

function serviceAvailability(value: unknown): DshServiceAvailability {
  return value === undefined ? 'missing' : 'available'
}

function emptyContextDiagnostic(
  services: DshContextServices,
  count: number,
): DshContextDiagnostic {
  const requested = count > 0
  return {
    schemaVersion: 1,
    requested,
    toolSchemaCount: count,
    services: {
      sessions: serviceAvailability(services.sessions),
      workspaceRegistry: serviceAvailability(services.workspaceRegistry),
      sandboxPolicy: serviceAvailability(services.sandboxPolicy),
      permissionPresets: serviceAvailability(services.permissionPresets),
      approval: serviceAvailability(services.approval),
    },
    session: { state: requested ? 'unavailable' : 'not-required', idPresent: false },
    workspace: { state: requested ? 'unavailable' : 'not-required' },
    sandbox: { state: requested ? 'unavailable' : 'not-required', mode: null },
    permission: { state: requested ? 'unavailable' : 'not-required', preset: null },
    approval: { state: requested ? 'unavailable' : 'not-required', policy: null },
    issueCodes: [],
  }
}

function diagnosticForContextError(
  base: DshContextDiagnostic,
  code: DshContextErrorCode,
  idPresent: boolean,
): DshContextDiagnostic {
  const next = {
    ...base,
    session: { ...base.session, idPresent },
    issueCodes: [code],
  }
  switch (code) {
    case DSH_SESSION_REQUIRED_CODE:
      return { ...next, session: { state: 'required', idPresent: false } }
    case DSH_SESSION_UNKNOWN_CODE:
      return { ...next, session: { state: 'unknown', idPresent } }
    case DSH_SESSION_INVALID_CODE:
      return { ...next, session: { state: 'invalid', idPresent } }
    case DSH_SESSION_UNAVAILABLE_CODE:
      return { ...next, session: { state: 'unavailable', idPresent } }
    case DSH_WORKSPACE_MISMATCH_CODE:
      return { ...next, session: { state: 'available', idPresent }, workspace: { state: 'mismatch' } }
    case DSH_WORKSPACE_UNAVAILABLE_CODE:
      return { ...next, session: { state: 'available', idPresent }, workspace: { state: 'unavailable' } }
    case DSH_SANDBOX_UNAVAILABLE_CODE:
      return {
        ...next,
        session: { state: 'available', idPresent },
        workspace: { state: 'trusted' },
        sandbox: { state: 'unavailable', mode: null },
      }
    case DSH_PERMISSION_UNAVAILABLE_CODE:
      return {
        ...next,
        session: { state: 'available', idPresent },
        workspace: { state: 'trusted' },
        sandbox: { state: 'available', mode: null },
        permission: { state: 'unavailable', preset: null },
      }
    case DSH_APPROVAL_UNAVAILABLE_CODE:
      return {
        ...next,
        session: { state: 'available', idPresent },
        workspace: { state: 'trusted' },
        sandbox: { state: 'available', mode: null },
        permission: { state: 'available', preset: null },
        approval: { state: 'unavailable', policy: null },
      }
    default:
      return next
  }
}

/**
 * Probe only the DSH capability services needed by a tool request. The report
 * contains labels and allowlisted modes only; it never includes session IDs,
 * cwd/workspace paths, events, prompts, arguments, or service error text.
 */
export async function diagnoseDshContext(
  context: DshContextLookup | undefined,
  options: { readonly sessionId?: string; readonly toolSchemaCount?: number },
): Promise<DshContextDiagnostic> {
  const count = toolCount(options.toolSchemaCount)
  const services = readDshContextServices(context)
  const base = emptyContextDiagnostic(services, count)
  if (count === 0) return base

  const sessionId = options.sessionId?.trim()
  if (sessionId === undefined || sessionId.length === 0) {
    return diagnosticForContextError(base, DSH_SESSION_REQUIRED_CODE, false)
  }

  try {
    const snapshotValue = await resolveDshContext(context, {
      sessionId,
      toolSchemaCount: count,
    })
    return {
      ...base,
      session: { state: 'available', idPresent: true },
      workspace: { state: 'trusted' },
      sandbox: { state: 'available', mode: snapshotValue.sandboxMode ?? null },
      permission: {
        state: 'available',
        preset: safePermissionPreset(snapshotValue.permissionPreset),
      },
      approval: { state: 'available', policy: snapshotValue.approvalPolicy ?? null },
      issueCodes: [],
    }
  } catch (error) {
    const code = error instanceof DshContextError ? error.code : DSH_CONTEXT_UNAVAILABLE_CODE
    return diagnosticForContextError(base, code, true)
  }
}

function sessionIdOf(session: DshSessionLike, requested: string): string | undefined {
  const sessionId = session.id ?? session.header?.id
  return sessionId === undefined || sessionId === requested ? requested : undefined
}

/**
 * Resolve the DSH-owned capability context without changing any DSH state.
 * Text-only calls intentionally remain usable without the optional services;
 * calls carrying tool schemas require every trust boundary and fail closed.
 */
export async function resolveDshContext(
  context: DshContextLookup | undefined,
  options: { readonly sessionId?: string; readonly toolSchemaCount?: number },
): Promise<DshContextSnapshot> {
  const count = toolCount(options.toolSchemaCount)
  if (count === 0) {
    return snapshot({
      state: 'text-only',
      sessionState: 'not-required',
      workspaceState: 'not-required',
      toolSchemaCount: 0,
    })
  }

  const requestedSessionId = options.sessionId?.trim()
  if (requestedSessionId === undefined || requestedSessionId.length === 0) {
    throw new DshContextError(DSH_SESSION_REQUIRED_CODE)
  }

  const services = readDshContextServices(context)
  if (services.sessions === undefined) throw new DshContextError(DSH_SESSION_UNAVAILABLE_CODE)

  let session: DshSessionLike | undefined
  try {
    session = services.sessions.get(requestedSessionId)
  } catch {
    throw new DshContextError(DSH_SESSION_UNAVAILABLE_CODE)
  }
  if (session === undefined) throw new DshContextError(DSH_SESSION_UNKNOWN_CODE)
  if (sessionIdOf(session, requestedSessionId) === undefined) {
    throw new DshContextError(DSH_SESSION_INVALID_CODE)
  }

  const cwd = session.header?.cwd
  if (typeof cwd !== 'string' || cwd.trim().length === 0) {
    throw new DshContextError(DSH_SESSION_INVALID_CODE)
  }
  let canonicalCwd: string
  try {
    canonicalCwd = await canonicalDirectory(cwd)
  } catch {
    throw new DshContextError(DSH_SESSION_INVALID_CODE)
  }

  const workspaceRegistry = services.workspaceRegistry
  if (workspaceRegistry === undefined) throw new DshContextError(DSH_WORKSPACE_UNAVAILABLE_CODE)
  let workspace: DshWorkspaceLike | undefined
  try {
    workspace = await workspaceRegistry.resolveByPath(canonicalCwd)
  } catch {
    throw new DshContextError(DSH_WORKSPACE_UNAVAILABLE_CODE)
  }
  if (workspace === undefined || typeof workspace.path !== 'string') {
    throw new DshContextError(DSH_WORKSPACE_MISMATCH_CODE)
  }
  let canonicalWorkspacePath: string
  try {
    canonicalWorkspacePath = await canonicalDirectory(workspace.path)
  } catch {
    throw new DshContextError(DSH_WORKSPACE_MISMATCH_CODE)
  }
  if (canonicalWorkspacePath !== canonicalCwd
    || !Array.isArray(workspace.sessionIds)
    || !workspace.sessionIds.includes(requestedSessionId)) {
    throw new DshContextError(DSH_WORKSPACE_MISMATCH_CODE)
  }
  if (workspace.status !== undefined) {
    let status: string
    try {
      status = await workspace.status()
    } catch {
      throw new DshContextError(DSH_WORKSPACE_MISMATCH_CODE)
    }
    if (status !== 'ok') throw new DshContextError(DSH_WORKSPACE_MISMATCH_CODE)
  }

  const sandboxPolicy = services.sandboxPolicy
  if (sandboxPolicy === undefined) throw new DshContextError(DSH_SANDBOX_UNAVAILABLE_CODE)
  let policy: { readonly mode?: string; readonly workspaceRoot?: string }
  try {
    policy = sandboxPolicy.resolve({ session })
  } catch {
    throw new DshContextError(DSH_SANDBOX_UNAVAILABLE_CODE)
  }
  if (!validSandboxMode(policy.mode) || typeof policy.workspaceRoot !== 'string') {
    throw new DshContextError(DSH_SANDBOX_UNAVAILABLE_CODE)
  }
  let canonicalPolicyRoot: string
  try {
    canonicalPolicyRoot = await canonicalDirectory(policy.workspaceRoot)
  } catch {
    throw new DshContextError(DSH_SANDBOX_UNAVAILABLE_CODE)
  }
  if (canonicalPolicyRoot !== canonicalCwd) throw new DshContextError(DSH_WORKSPACE_MISMATCH_CODE)

  const permissionPresets = services.permissionPresets
  if (permissionPresets === undefined) throw new DshContextError(DSH_PERMISSION_UNAVAILABLE_CODE)
  const events = session.events
  if (!Array.isArray(events)) throw new DshContextError(DSH_PERMISSION_UNAVAILABLE_CODE)
  let permissionPreset: unknown
  try {
    permissionPreset = permissionPresets.current(events)
  } catch {
    throw new DshContextError(DSH_PERMISSION_UNAVAILABLE_CODE)
  }
  if (typeof permissionPreset !== 'string' || permissionPreset.trim().length === 0) {
    throw new DshContextError(DSH_PERMISSION_UNAVAILABLE_CODE)
  }

  const approval = services.approval
  if (approval === undefined) throw new DshContextError(DSH_APPROVAL_UNAVAILABLE_CODE)
  let approvalPolicy: unknown
  try {
    const override = approval.overrideOf(session)
    approvalPolicy = override ?? approval.config?.policy ?? 'ask'
  } catch {
    throw new DshContextError(DSH_APPROVAL_UNAVAILABLE_CODE)
  }
  if (!validApprovalPolicy(approvalPolicy)) throw new DshContextError(DSH_APPROVAL_UNAVAILABLE_CODE)

  return snapshot({
    state: 'ready',
    sessionState: 'trusted',
    workspaceState: 'trusted',
    sandboxMode: policy.mode,
    permissionPreset,
    approvalPolicy,
    toolSchemaCount: count,
  })
}
