import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { redactText } from './agy/redact.js'
import {
  getAgentPreset,
  listAgentPresets,
  readAgentPresetTemplate,
  type AgentPreset,
} from './agent-presets.js'
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
const AGENT_WRITE_TOOLS = new Set([
  'multi_replace_file_content',
  'replace_file_content',
  'write_to_file',
])

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

export type ProfileDumpStatus = 'not-run' | 'ok' | 'unavailable' | 'timeout' | 'nonzero' | 'parse-error'

export interface EffectivePurposeRoute {
  configured: boolean
  complete: boolean | null
  model: string | null
  agent: string | null
  reasoningEffort: string | null
}

export interface EffectiveDshContext {
  source: 'profile-dump'
  session: {
    state: 'not-probed'
    required: boolean
  }
  workspace: {
    state: 'not-probed'
    configured: boolean
  }
  permission: {
    state: 'not-probed'
    preset: null
  }
  approval: {
    state: 'not-probed'
    policy: null
  }
  services: {
    sessions: 'not-probed'
    workspaceRegistry: 'not-probed'
    sandboxPolicy: 'not-probed'
    permissionPresets: 'not-probed'
    approval: 'not-probed'
  }
}

export interface EffectiveBridgeCapability {
  owner: 'none' | 'agy' | 'dsh' | 'unknown'
  enabled: boolean | null
  agent: string | null
  internalTools: 'empty' | 'present' | 'unknown'
  schemaCapability: 'unsupported' | 'agy-owned' | 'prompt-contract-v1' | 'unknown'
  legacyConfig: {
    agyOwned: boolean
    workspaceRootConfigured: boolean
  }
}

export interface EffectiveProfileConfig {
  dumpStatus: ProfileDumpStatus
  provider: string | null
  model: string | null
  agent: string | null
  agentPreset: string | null
  sessionMode: string | null
  retryPolicy: {
    maxRetries: number | null
    retryableCodes: readonly string[]
  } | null
  purposeRoutes: {
    compaction: EffectivePurposeRoute | null
    sessionTitle: EffectivePurposeRoute | null
  }
  workspaceRootStatus: 'configured' | 'missing' | 'not-directory' | 'unknown'
  workspaceSource: 'dsh-session-cwd' | 'config-legacy' | 'unknown'
  visibleModels: { raw: string | null; count: number | null; filtered: boolean }
  modelEffortSplit: { baseModel: string | null; suffixDetected: boolean; normalized: boolean }
  imageInput: string | null
  modelCapability: {
    inputModalities: readonly ['text']
    imageBridge: 'off' | 'experimental' | 'unknown'
  }
  agentCapability: {
    knownPreset: boolean | null
    frontmatterValid: boolean | null
    tools: readonly string[]
    viewFile: boolean | null
    writeTools: boolean | null
    commandExecutionPolicy: string | null
    mcpServersEmpty: boolean | null
    subagent: boolean | null
  }
  dshContext: EffectiveDshContext
  bridgeCapability: EffectiveBridgeCapability
}

export interface ProfileDiagnosticResult {
  profileSchemaVersion: 4
  name: string
  dshHomePresent: boolean
  profilePresent: boolean
  packageInstalled: boolean
  bundleDeclared: boolean
  bundleEnabled: boolean | null
  toolPolicy: ToolPolicy | string | null
  effectiveProvider: string | null
  effectiveModel: string | null
  effective: EffectiveProfileConfig
  repairSuggestions: readonly string[]
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

interface ParsedDumpConfig {
  recognized: boolean
  malformed: boolean
  values: Readonly<Record<string, string>>
}

function stripDumpValue(value: string): string {
  const withoutComment = value.replace(/\s+#.*$/, '').trim()
  if (withoutComment.length >= 2) {
    const first = withoutComment[0]
    const last = withoutComment.at(-1)
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return withoutComment.slice(1, -1)
    }
  }
  return withoutComment
}

/** Parse only the provider bundle section; this is intentionally not a general YAML parser. */
function parseDumpConfig(stdout: string): ParsedDumpConfig {
  const values: Record<string, string> = {}
  let recognized = false
  let malformed = false
  let inBundleSection = false
  const stack: Array<{ indent: number; key: string }> = []

  for (const line of stdout.split(/\r?\n/)) {
    if (/^\s*#\s*==\s*dsh-agy-provider\b/i.test(line)
      || /^\s*-\s*id:\s*dsh-agy-provider\b/i.test(line)
      || /^\s*id:\s*dsh-agy-provider\b/i.test(line)) {
      recognized = true
      inBundleSection = true
      stack.length = 0
      continue
    }
    if (inBundleSection && /^\s*#\s*==\s+/.test(line)) {
      inBundleSection = false
      stack.length = 0
      continue
    }
    if (!inBundleSection || line.trim().length === 0 || line.trim().startsWith('#')) continue

    const match = /^(\s*)([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/.exec(line)
    if (/^\s*-\s+/.test(line)) continue
    if (match === null || match[1] === undefined || match[2] === undefined) {
      malformed = true
      continue
    }

    const indent = match[1].replace(/\t/g, '  ').length
    while (stack.length > 0 && (stack.at(-1)?.indent ?? -1) >= indent) stack.pop()
    const path = [...stack.map(entry => entry.key), match[2]].join('.')
    const rawValue = match[3]?.trim() ?? ''
    values[path] = stripDumpValue(rawValue)
    if (rawValue.length === 0) stack.push({ indent, key: match[2] })
  }

  return { recognized, malformed, values }
}

function normalizeConfigValues(values: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const normalized: Record<string, string> = { ...values }
  for (const [key, value] of Object.entries(values)) {
    if (key.startsWith('config.')) {
      const shortKey = key.slice('config.'.length)
      if (normalized[shortKey] === undefined) normalized[shortKey] = value
    }
  }
  return normalized
}

function valueOf(values: Readonly<Record<string, string>>, key: string): string | null {
  const value = values[key]
  return value === undefined || value.length === 0 ? null : value
}

function booleanValue(value: string | null): boolean | null {
  if (value === null) return null
  if (value.toLowerCase() === 'true') return true
  if (value.toLowerCase() === 'false') return false
  return null
}

function numberValue(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function listValue(value: string | null): readonly string[] {
  if (value === null) return []
  const normalized = value.trim().replace(/^\[/, '').replace(/\]$/, '').trim()
  if (normalized.length === 0) return []
  return normalized.split(',').map(item => stripDumpValue(item.trim())).filter(Boolean)
}

function workspaceStatus(value: string | null): EffectiveProfileConfig['workspaceRootStatus'] {
  if (value === null || value.trim().length === 0) return value === null ? 'unknown' : 'missing'
  try {
    return statSync(value).isDirectory() ? 'configured' : 'not-directory'
  } catch {
    return 'missing'
  }
}

function routeFromDump(
  values: Readonly<Record<string, string>>,
  purpose: 'compaction' | 'sessionTitle',
): EffectivePurposeRoute | null {
  const prefix = `purposeRoutes.${purpose}.`
  const configured = Object.keys(values).some(key => key.startsWith(prefix))
  if (!configured) return null
  const model = valueOf(values, `${prefix}model`)
  const agent = valueOf(values, `${prefix}agent`)
  const reasoningEffort = valueOf(values, `${prefix}reasoningEffort`)
  return {
    configured: true,
    complete: model !== null && agent !== null && reasoningEffort !== null,
    model,
    agent,
    reasoningEffort,
  }
}

function emptyEffective(dumpStatus: ProfileDumpStatus): EffectiveProfileConfig {
  return {
    dumpStatus,
    provider: null,
    model: null,
    agent: null,
    agentPreset: null,
    sessionMode: null,
    retryPolicy: null,
    purposeRoutes: { compaction: null, sessionTitle: null },
    workspaceRootStatus: 'unknown',
    workspaceSource: 'unknown',
    visibleModels: { raw: null, count: null, filtered: false },
    modelEffortSplit: { baseModel: null, suffixDetected: false, normalized: false },
    imageInput: null,
    modelCapability: { inputModalities: ['text'], imageBridge: 'unknown' },
    agentCapability: {
      knownPreset: null,
      frontmatterValid: null,
      tools: [],
      viewFile: null,
      writeTools: null,
      commandExecutionPolicy: null,
      mcpServersEmpty: null,
      subagent: null,
    },
    dshContext: {
      source: 'profile-dump',
      session: { state: 'not-probed', required: false },
      workspace: { state: 'not-probed', configured: false },
      permission: { state: 'not-probed', preset: null },
      approval: { state: 'not-probed', policy: null },
      services: {
        sessions: 'not-probed',
        workspaceRegistry: 'not-probed',
        sandboxPolicy: 'not-probed',
        permissionPresets: 'not-probed',
        approval: 'not-probed',
      },
    },
    bridgeCapability: {
      owner: 'unknown',
      enabled: null,
      agent: null,
      internalTools: 'unknown',
      schemaCapability: 'unknown',
      legacyConfig: { agyOwned: false, workspaceRootConfigured: false },
    },
  }
}

function bridgeCapabilityFromConfig(
  toolPolicy: string | null,
  bundleEnabled: boolean | null,
  configuredAgent: string | null,
  agentCapability: EffectiveProfileConfig['agentCapability'],
  workspaceRootStatus: EffectiveProfileConfig['workspaceRootStatus'],
): EffectiveBridgeCapability {
  const workspaceRootConfigured = workspaceRootStatus === 'configured'
  if (toolPolicy === 'dsh-owned') {
    return {
      owner: 'dsh',
      enabled: bundleEnabled,
      agent: 'dsh-agy-tool-free',
      internalTools: 'empty',
      schemaCapability: 'prompt-contract-v1',
      legacyConfig: { agyOwned: false, workspaceRootConfigured },
    }
  }
  if (toolPolicy === 'agy-owned') {
    const internalTools = agentCapability.frontmatterValid === true
      && agentCapability.commandExecutionPolicy === 'off'
      && agentCapability.mcpServersEmpty === true
      && agentCapability.subagent === false
      ? 'empty'
      : agentCapability.frontmatterValid === false ? 'present' : 'unknown'
    return {
      owner: 'agy',
      enabled: bundleEnabled,
      agent: configuredAgent,
      internalTools,
      schemaCapability: 'agy-owned',
      legacyConfig: { agyOwned: true, workspaceRootConfigured },
    }
  }
  if (toolPolicy === 'reject') {
    return {
      owner: 'none',
      enabled: bundleEnabled,
      agent: configuredAgent,
      internalTools: 'unknown',
      schemaCapability: 'unsupported',
      legacyConfig: { agyOwned: false, workspaceRootConfigured },
    }
  }
  return {
    owner: 'unknown',
    enabled: bundleEnabled,
    agent: configuredAgent,
    internalTools: 'unknown',
    schemaCapability: 'unknown',
    legacyConfig: { agyOwned: false, workspaceRootConfigured },
  }
}

function effectiveFromDump(
  parsed: ParsedDumpConfig,
  dumpStatus: ProfileDumpStatus,
): EffectiveProfileConfig {
  const values = normalizeConfigValues(parsed.values)
  const imageInput = valueOf(values, 'imageInput')
  const retryMax = valueOf(values, 'retryPolicy.maxRetries')
  const retryCodes = valueOf(values, 'retryPolicy.retryableCodes')
  const toolPolicy = valueOf(values, 'toolPolicy')
  const bundleEnabled = booleanValue(valueOf(values, 'enabled'))
  const workspaceRootStatus = workspaceStatus(valueOf(values, 'workspaceRoot'))
  const workspaceSource = toolPolicy === 'dsh-owned' ? 'dsh-session-cwd' : workspaceRootStatus === 'configured' ? 'config-legacy' : 'unknown'
  const rawVisible = valueOf(values, 'visibleModels')
  const visibleCount = rawVisible === null ? null : (() => { try { const v = JSON.parse(rawVisible); return Array.isArray(v) ? v.length : null } catch { return rawVisible.length > 0 ? 1 : 0 } })()
  const rawModel = valueOf(values, 'model')
  const suffixDetected = rawModel !== null && /-(?:low|medium|high)$/i.test(rawModel)
  const baseModel = rawModel !== null ? rawModel.replace(/-(?:low|medium|high)$/i, '') : null
  const configuredAgent = valueOf(values, 'agent')
  return {
    dumpStatus,
    provider: valueOf(values, 'provider'),
    model: valueOf(values, 'model'),
    agent: valueOf(values, 'agent'),
    agentPreset: valueOf(values, 'agentPreset'),
    sessionMode: valueOf(values, 'sessionMode'),
    retryPolicy: retryMax === null && retryCodes === null
      ? null
      : { maxRetries: numberValue(retryMax), retryableCodes: listValue(retryCodes) },
    purposeRoutes: {
      compaction: routeFromDump(values, 'compaction'),
      sessionTitle: routeFromDump(values, 'sessionTitle'),
    },
    workspaceRootStatus,
    workspaceSource,
    visibleModels: { raw: rawVisible, count: visibleCount, filtered: visibleCount !== null && visibleCount > 0 },
    modelEffortSplit: { baseModel, suffixDetected, normalized: suffixDetected ? baseModel !== rawModel : false },
    imageInput,
    modelCapability: {
      inputModalities: ['text'],
      imageBridge: imageInput === 'off' ? 'off' : imageInput === 'experimental' ? 'experimental' : 'unknown',
    },
    agentCapability: emptyEffective(dumpStatus).agentCapability,
    dshContext: {
      source: 'profile-dump',
      session: { state: 'not-probed', required: toolPolicy === 'dsh-owned' },
      workspace: { state: 'not-probed', configured: workspaceRootStatus === 'configured' },
      permission: { state: 'not-probed', preset: null },
      approval: { state: 'not-probed', policy: null },
      services: {
        sessions: 'not-probed',
        workspaceRegistry: 'not-probed',
        sandboxPolicy: 'not-probed',
        permissionPresets: 'not-probed',
        approval: 'not-probed',
      },
    },
    bridgeCapability: bridgeCapabilityFromConfig(
      toolPolicy,
      bundleEnabled,
      configuredAgent,
      emptyEffective(dumpStatus).agentCapability,
      workspaceRootStatus,
    ),
  }
}

interface ParsedAgentFrontmatter {
  name: string | null
  tools: readonly string[] | null
  commandExecutionPolicy: string | null
  mcpServersEmpty: boolean | null
  subagent: boolean | null
}

function parseAgentFrontmatter(source: string): ParsedAgentFrontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)
  if (match === null || match[1] === undefined) {
    return { name: null, tools: null, commandExecutionPolicy: null, mcpServersEmpty: null, subagent: null }
  }
  let name: string | null = null
  let tools: string[] | null = null
  let commandExecutionPolicy: string | null = null
  let mcpServersEmpty: boolean | null = null
  let subagent: boolean | null = null
  let collectingTools = false

  for (const line of match[1].split(/\r?\n/)) {
    const listItem = /^\s*-\s*(.+?)\s*$/.exec(line)
    if (collectingTools && listItem?.[1] !== undefined) {
      tools ??= []
      tools.push(stripDumpValue(listItem[1]))
      continue
    }
    const field = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/.exec(line)
    if (field === null || field[1] === undefined) continue
    collectingTools = field[1] === 'tools' && (field[2] ?? '').trim().length === 0
    const rawValue = stripDumpValue(field[2]?.trim() ?? '')
    if (field[1] === 'name') name = rawValue || null
    if (field[1] === 'tools' && !collectingTools) tools = [...listValue(rawValue)]
    if (field[1] === 'commandExecutionPolicy') commandExecutionPolicy = rawValue || null
    if (field[1] === 'mcpServers') mcpServersEmpty = rawValue === '[]'
    if (field[1] === 'subagent') subagent = booleanValue(rawValue)
  }

  return { name, tools, commandExecutionPolicy, mcpServersEmpty, subagent }
}

function presetForAgent(agent: string | null, agentPreset: string | null): AgentPreset | undefined {
  return getAgentPreset(agentPreset) ?? listAgentPresets().find(preset => preset.agentName === agent)
}

async function inspectAgent(
  agent: string | null,
  agentPreset: string | null,
): Promise<{
  capability: EffectiveProfileConfig['agentCapability']
  issue?: DiagnosticIssue
  suggestion?: string
}> {
  const preset = presetForAgent(agent, agentPreset)
  if (preset === undefined) {
    return {
      capability: {
        knownPreset: agent === null ? null : false,
        frontmatterValid: agent === null ? null : null,
        tools: [],
        viewFile: agent === null ? null : false,
        writeTools: agent === null ? null : false,
        commandExecutionPolicy: null,
        mcpServersEmpty: null,
        subagent: null,
      },
      ...(agent === null ? {} : {
        suggestion: `Install or inspect the selected Agent explicitly; bundled options: ${listAgentPresets().map(item => item.id).join(', ')}`,
      }),
    }
  }

  try {
    const frontmatter = parseAgentFrontmatter(await readAgentPresetTemplate(preset))
    const actualTools = frontmatter.tools ?? []
    const toolsMatch = actualTools.length === preset.tools.length
      && actualTools.every((tool, index) => tool === preset.tools[index])
    const valid = frontmatter.name === preset.agentName
      && toolsMatch
      && frontmatter.commandExecutionPolicy === 'off'
      && frontmatter.mcpServersEmpty === true
      && frontmatter.subagent === false
    const capability = {
      knownPreset: true,
      frontmatterValid: valid,
      tools: actualTools,
      viewFile: actualTools.includes('view_file'),
      writeTools: actualTools.some(tool => AGENT_WRITE_TOOLS.has(tool)),
      commandExecutionPolicy: frontmatter.commandExecutionPolicy,
      mcpServersEmpty: frontmatter.mcpServersEmpty,
      subagent: frontmatter.subagent,
    } satisfies EffectiveProfileConfig['agentCapability']
    return valid
      ? { capability }
      : {
        capability,
        issue: {
          component: 'profile',
          code: 'PROFILE_AGENT_FRONTMATTER_INVALID',
          message: `Bundled Agent ${preset.agentName} does not match its declared tool and execution policy`,
        },
        suggestion: `Reinstall the bundled Agent with: npx dsh-agy-provider agents install ${preset.id} --apply`,
      }
  } catch {
    return {
      capability: {
        knownPreset: true,
        frontmatterValid: false,
        tools: [],
        viewFile: preset.tools.includes('view_file'),
        writeTools: preset.tools.some(tool => AGENT_WRITE_TOOLS.has(tool)),
        commandExecutionPolicy: null,
        mcpServersEmpty: null,
        subagent: null,
      },
      issue: {
        component: 'profile',
        code: 'PROFILE_AGENT_FRONTMATTER_UNREADABLE',
        message: `Could not read the bundled Agent template for ${preset.agentName}`,
      },
      suggestion: `Reinstall the bundled Agent with: npx dsh-agy-provider agents install ${preset.id} --apply`,
    }
  }
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
      profileSchemaVersion: 4,
      name: '<invalid>',
      dshHomePresent,
      profilePresent: false,
      packageInstalled: false,
      bundleDeclared: false,
      bundleEnabled: null,
      toolPolicy: null,
      effectiveProvider: null,
      effectiveModel: null,
      effective: emptyEffective('not-run'),
      repairSuggestions: [],
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
  let effective = emptyEffective('not-run')
  const repairSuggestions: string[] = []

  const addSuggestion = (suggestion: string): void => {
    if (!repairSuggestions.includes(suggestion)) repairSuggestions.push(suggestion)
  }

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

    // Inspect effective dump-config. Failure is part of the diagnostic result;
    // it must not silently turn into a false "unknown but healthy" profile.
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

    let dumpStatus: ProfileDumpStatus = 'not-run'
    if (dshEntry !== undefined) {
      try {
        const invocation = resolveDshInvocation(dshEntry)
        const args = [...invocation.prefixArgs, '--profile', profileName, '--dump-config']
        const dumpResult = await runCmd(invocation.executable, args, {
          timeoutMs: options.timeoutMs ?? 10_000,
          cwd: profileDir,
          env: { ...process.env, DSH_HOME: dshHome },
        })
        if (dumpResult.timedOut) {
          dumpStatus = 'timeout'
          issues.push({
            component: 'profile',
            code: 'PROFILE_DUMP_TIMEOUT',
            message: `DSH --dump-config timed out for profile "${profileName}"`,
          })
          addSuggestion(`Retry the read-only check: npx @deepseek-ai/dsh --profile ${profileName} --dump-config`)
        } else if (dumpResult.exitCode !== 0) {
          dumpStatus = 'nonzero'
          issues.push({
            component: 'profile',
            code: 'PROFILE_DUMP_NONZERO',
            message: `DSH --dump-config exited unsuccessfully for profile "${profileName}"`,
          })
          addSuggestion(`Run the read-only check directly: npx @deepseek-ai/dsh --profile ${profileName} --dump-config`)
        } else {
          const parsed = parseDumpConfig(dumpResult.stdout)
          if (!parsed.recognized || parsed.malformed) {
            dumpStatus = 'parse-error'
            issues.push({
              component: 'profile',
              code: 'PROFILE_DUMP_PARSE_FAILED',
              message: `DSH --dump-config did not contain a valid dsh-agy-provider section for profile "${profileName}"`,
            })
            addSuggestion(`Inspect the read-only dump format: npx @deepseek-ai/dsh --profile ${profileName} --dump-config`)
          } else {
            dumpStatus = 'ok'
            effective = effectiveFromDump(parsed, dumpStatus)
            const configValues = normalizeConfigValues(parsed.values)
            bundleEnabled = booleanValue(valueOf(configValues, 'enabled'))
            toolPolicy = valueOf(configValues, 'toolPolicy')
            effectiveProvider = effective.provider
            effectiveModel = effective.model

            const agentInspection = await inspectAgent(effective.agent, effective.agentPreset)
            effective = {
              ...effective,
              agentCapability: agentInspection.capability,
              bridgeCapability: bridgeCapabilityFromConfig(
                toolPolicy,
                bundleEnabled,
                effective.agent,
                agentInspection.capability,
                effective.workspaceRootStatus,
              ),
            }
            if (agentInspection.issue !== undefined) issues.push(agentInspection.issue)
            if (agentInspection.suggestion !== undefined) addSuggestion(agentInspection.suggestion)

            if (toolPolicy === 'agy-owned') {
              issues.push({
                component: 'profile',
                code: 'PROFILE_TOOL_POLICY_DEPRECATED',
                message: 'toolPolicy "agy-owned" is a legacy compatibility mode; DSH-owned execution is recommended and the profile was not changed',
              })
              addSuggestion('Set toolPolicy: dsh-owned after confirming the DSH permission and approval services are available')
            }
            if (toolPolicy === 'dsh-owned' && effective.bridgeCapability.internalTools === 'present') {
              issues.push({
                component: 'profile',
                code: 'DSH_BRIDGE_AGENT_INTERNAL_TOOLS',
                message: 'The DSH-owned bridge Agent exposes internal AGY tools; the bridge requires the bundled tool-free Agent',
              })
              addSuggestion('Use the bundled dsh-agy-tool-free Agent for toolPolicy: dsh-owned')
            }
            if (toolPolicy === 'reject' && bundleEnabled === true) {
              issues.push({
                component: 'profile',
                code: 'DSH_SCHEMA_UNSUPPORTED',
                message: 'The active profile rejects DSH tool schemas; tool bridge capability is unavailable until toolPolicy is explicitly selected',
              })
            }

            // 0.9.0: dsh-owned uses DSH session cwd, no workspaceRoot required; only warn for legacy agy-owned
            if (toolPolicy === 'dsh-owned' && effective.workspaceRootStatus === 'configured') {
              issues.push({
                component: 'profile',
                code: 'DEPRECATED_WORKSPACE_ROOT',
                message: 'workspaceRoot is deprecated for toolPolicy dsh-owned; DSH session workspace is used automatically',
              })
              addSuggestion('Remove workspaceRoot from profile; open the project folder in DSH and rely on session workspace')
            }
            if (effective.modelEffortSplit.suffixDetected) {
              issues.push({
                component: 'profile',
                code: 'DEPRECATED_MODEL_EFFORT_SUFFIX',
                message: `Model id "${effective.model}" contains -low/-medium/-high suffix; use base model "${effective.modelEffortSplit.baseModel}" and select reasoningEffort separately`,
              })
              addSuggestion('Set model to ' + effective.modelEffortSplit.baseModel + ' and choose reasoningEffort low/medium/high via DSH')
            }
            if (effective.agentCapability.writeTools === true
              && effective.workspaceRootStatus !== 'configured'
              && toolPolicy !== 'dsh-owned') {
              issues.push({
                component: 'profile',
                code: 'PROFILE_WORKSPACE_REQUIRED',
                message: 'The selected Agent can write files but no existing workspace directory is configured',
              })
              addSuggestion('Set workspaceRoot to an existing project directory before enabling workspace-write')
            }
            if (effective.imageInput === 'experimental' && effective.agentCapability.viewFile !== true) {
              issues.push({
                component: 'profile',
                code: 'PROFILE_IMAGE_AGENT_UNSUPPORTED',
                message: 'Experimental image input requires a verified Agent with the view_file tool',
              })
              addSuggestion('Use agentPreset: read-only or workspace-write and install it with: npx dsh-agy-provider agents install read-only --apply')
            }
            for (const purpose of ['compaction', 'sessionTitle'] as const) {
              const route = effective.purposeRoutes[purpose]
              if (route?.complete === false) {
                issues.push({
                  component: 'profile',
                  code: 'PROFILE_PURPOSE_ROUTE_INCOMPLETE',
                  message: `Purpose route "${purpose}" is missing model, agent, or reasoningEffort`,
                })
                addSuggestion(`Complete or remove purposeRoutes.${purpose} in the profile configuration`)
              }
            }
            if (effective.retryPolicy !== null
              && (effective.retryPolicy.maxRetries === null || effective.retryPolicy.maxRetries > 2)) {
              issues.push({
                component: 'profile',
                code: 'PROFILE_RETRY_POLICY_INVALID',
                message: 'retryPolicy.maxRetries must be an integer from 0 through 2',
              })
              addSuggestion('Set retryPolicy.maxRetries to 0, 1, or 2 in the profile configuration')
            }
          }
        }
      } catch {
        dumpStatus = 'unavailable'
        issues.push({
          component: 'profile',
          code: 'PROFILE_DUMP_UNAVAILABLE',
          message: `Could not execute DSH --dump-config for profile "${profileName}"`,
        })
        addSuggestion(`Verify the DSH executable and retry: npx @deepseek-ai/dsh --profile ${profileName} --dump-config`)
      }
    }

    if (dumpStatus !== 'ok') effective = emptyEffective(dumpStatus)

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
        message: `Profile "${profileName}" carries tool schemas by default, but toolPolicy is "reject". Set toolPolicy: dsh-owned to let DSH execute tools, or agy-owned for legacy AGY-owned execution`,
      })
    }
  }

  return {
    profileSchemaVersion: 4,
    name: profileName,
    dshHomePresent,
    profilePresent,
    packageInstalled,
    bundleDeclared,
    bundleEnabled,
    toolPolicy,
    effectiveProvider,
    effectiveModel,
    effective,
    repairSuggestions,
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
    lines.push(
      `effective: dump=${p.effective.dumpStatus}; provider=${p.effective.provider ?? 'unknown'}; model=${p.effective.model ?? 'unknown'}; agent=${p.effective.agent ?? 'unknown'}; sessionMode=${p.effective.sessionMode ?? 'unknown'}; imageInput=${p.effective.imageInput ?? 'unknown'}; inputModalities=${p.effective.modelCapability.inputModalities.join(',')}`,
    )
    lines.push(
      `agentCapability: preset=${p.effective.agentCapability.knownPreset ?? 'unknown'}; frontmatter=${p.effective.agentCapability.frontmatterValid ?? 'unknown'}; view_file=${p.effective.agentCapability.viewFile ?? 'unknown'}; writeTools=${p.effective.agentCapability.writeTools ?? 'unknown'}; workspace=${p.effective.workspaceRootStatus}`,
    )
    lines.push(
      `dshContext: session=${p.effective.dshContext.session.state}; workspace=${p.effective.dshContext.workspace.configured ? 'configured' : 'not-configured'}; permission=${p.effective.dshContext.permission.state}; approval=${p.effective.dshContext.approval.state}`,
    )
    lines.push(
      `bridge: owner=${p.effective.bridgeCapability.owner}; agent=${p.effective.bridgeCapability.agent ?? 'unknown'}; schema=${p.effective.bridgeCapability.schemaCapability}; internalTools=${p.effective.bridgeCapability.internalTools}`,
    )
    if (p.repairSuggestions.length > 0) {
      lines.push('repair suggestions:')
      for (const suggestion of p.repairSuggestions) lines.push(`- ${suggestion}`)
    }
  }

  lines.push(
    `provider: ${result.configuration.provider}; agent=${result.configuration.agent}; defaultModel=${result.configuration.defaultModel}; toolPolicy=${result.configuration.toolPolicy}; transport=${(result.configuration as any).transport ?? 'one-shot'}`,
  )
  lines.push(`transport: persistentIdleTtlMs=${(result.configuration as any).persistentIdleTtlMs ?? 30000}; readyTimeout=${(result.configuration as any).persistentReadyTimeoutMs ?? 10000}; fallback=${(result.configuration as any).persistentFallback ?? 'before-accept'}`)
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

Quota-free diagnostic CLI v3 for dsh-agy-provider and DSH profiles.

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