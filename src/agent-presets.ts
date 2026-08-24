import { readFile } from 'node:fs/promises'

export const AGENT_PRESET_IDS = ['tool-free', 'image-view', 'read-only', 'workspace-write'] as const
export type AgentPresetId = typeof AGENT_PRESET_IDS[number]
export type AgentExecutionMode = 'plan' | 'accept-edits'

export interface AgentPreset {
  readonly id: AgentPresetId
  readonly agentName: string
  readonly fileName: string
  readonly description: string
  readonly tools: readonly string[]
  readonly writeAccess: boolean
  readonly mode: AgentExecutionMode | undefined
}

const PRESETS: Readonly<Record<AgentPresetId, AgentPreset>> = Object.freeze({
  'tool-free': Object.freeze({
    id: 'tool-free',
    agentName: 'dsh-agy-tool-free',
    fileName: 'dsh-agy-tool-free.md',
    description: 'Text-only reasoning with no AGY tools.',
    tools: Object.freeze([]),
    writeAccess: false,
    mode: undefined,
  }),
  'image-view': Object.freeze({
    id: 'image-view',
    agentName: 'dsh-agy-image-view',
    fileName: 'dsh-agy-image-view.md',
    description: 'Per-request image inspection with only view_file enabled.',
    tools: Object.freeze(['view_file']),
    writeAccess: false,
    mode: 'plan',
  }),
  'read-only': Object.freeze({
    id: 'read-only',
    agentName: 'dsh-agy-read-only',
    fileName: 'dsh-agy-read-only.md',
    description: 'Read-only workspace inspection and search.',
    tools: Object.freeze(['find_by_name', 'grep_search', 'view_file', 'list_dir']),
    writeAccess: false,
    mode: 'plan',
  }),
  'workspace-write': Object.freeze({
    id: 'workspace-write',
    agentName: 'dsh-agy-workspace-write',
    fileName: 'dsh-agy-workspace-write.md',
    description: 'Bounded file edits inside an explicitly configured workspace.',
    tools: Object.freeze([
      'find_by_name',
      'grep_search',
      'view_file',
      'list_dir',
      'multi_replace_file_content',
      'replace_file_content',
      'write_to_file',
    ]),
    writeAccess: true,
    mode: 'accept-edits',
  }),
})

export function listAgentPresets(): readonly AgentPreset[] {
  return AGENT_PRESET_IDS.map(id => PRESETS[id])
}

export function getAgentPreset(value: unknown): AgentPreset | undefined {
  if (typeof value !== 'string') return undefined
  return (AGENT_PRESET_IDS as readonly string[]).includes(value)
    ? PRESETS[value as AgentPresetId]
    : undefined
}

export function requireAgentPreset(value: string): AgentPreset {
  const preset = getAgentPreset(value)
  if (preset === undefined) {
    throw new TypeError(`Unknown Agent preset: ${value}. Expected one of: ${AGENT_PRESET_IDS.join(', ')}`)
  }
  return preset
}

/** Read a bundled template; the template file is included in the npm tarball. */
export async function readAgentPresetTemplate(value: AgentPresetId | AgentPreset): Promise<string> {
  const preset = typeof value === 'string' ? requireAgentPreset(value) : value
  return readFile(new URL(`../agents/${preset.fileName}`, import.meta.url), 'utf8')
}
