import {
  AgentInstallError,
  describeAgentPresets,
  installAgentPreset,
} from './agent-installer.js'
import { AGENT_PRESET_IDS } from './agent-presets.js'

function optionValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) return undefined
  return value
}

export function formatAgentsHelp(): string {
  return `Usage: dsh-agy-provider agents <command> [options]

Quota-free Agent template management. Preview is the default; no files are changed without --apply.

Commands:
  list                    List bundled Agent presets
  install <preset>        Preview or install one preset

Options:
  --dir <path>            Agent directory (default: $AGY_AGENT_DIR or ~/.gemini/config/agents)
  --apply                 Write the template; omitted means preview only
  --backup                Move an existing file aside before --apply
  --json                  Output structured JSON
  -h, --help              Show help information

Presets: ${AGENT_PRESET_IDS.join(', ')}

Examples:
  npx dsh-agy-provider agents list
  npx dsh-agy-provider agents install read-only --dir .gemini/config/agents
  npx dsh-agy-provider agents install workspace-write --apply --backup
`
}

function formatInstallResult(result: Awaited<ReturnType<typeof installAgentPreset>>): string {
  const mode = result.applied ? 'applied' : 'preview'
  const lines = [
    `mode: ${mode}`,
    `preset: ${result.preset}`,
    `agent: ${result.agentName}`,
    `target: ${result.targetPath}`,
    `action: ${result.action}`,
  ]
  if (result.backupPath !== undefined) lines.push(`backup: ${result.backupPath}`)
  if (!result.applied && result.action === 'create') lines.push('next: rerun with --apply to write the file')
  if (!result.applied && result.action === 'conflict') lines.push('next: rerun with --apply --backup to preserve and replace the file')
  return lines.join('\n')
}

export async function runAgentsCli(
  argv: readonly string[],
  stdout: (text: string) => void = text => process.stdout.write(text),
  stderr: (text: string) => void = text => process.stderr.write(text),
): Promise<number> {
  const args = [...argv]
  if (args[0] === 'agents' || args[0] === 'agent') args.shift()
  if (args.includes('-h') || args.includes('--help')) {
    stdout(`${formatAgentsHelp()}\n`)
    return 0
  }

  const command = args.shift() ?? 'list'
  const jsonOutput = args.includes('--json')
  if (command === 'list') {
    const entries = describeAgentPresets()
    if (jsonOutput) stdout(`${JSON.stringify({ quotaUsed: false, presets: entries }, null, 2)}\n`)
    else {
      stdout(`${entries.map(entry => `${entry.id}: ${entry.agentName} [${entry.tools.join(', ') || 'no tools'}]`).join('\n')}\n`)
    }
    return 0
  }

  if (command !== 'install') {
    stderr(`Unknown agents command: ${command}. Use --help for usage.\n`)
    return 2
  }

  const preset = args.shift()
  if (preset === undefined) {
    stderr(`Missing Agent preset. Expected one of: ${AGENT_PRESET_IDS.join(', ')}\n`)
    return 2
  }

  try {
    const directory = optionValue(args, '--dir')
    const result = await installAgentPreset({
      preset,
      ...(directory === undefined ? {} : { directory }),
      apply: args.includes('--apply'),
      backup: args.includes('--backup'),
    })
    if (jsonOutput) stdout(`${JSON.stringify({ quotaUsed: false, ...result }, null, 2)}\n`)
    else stdout(`${formatInstallResult(result)}\n`)
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (jsonOutput) {
      stdout(`${JSON.stringify({ quotaUsed: false, ok: false, error: {
        code: error instanceof AgentInstallError ? error.code : 'AGENT_INSTALL_FAILED',
        message,
      } }, null, 2)}\n`)
    } else stderr(`Error installing Agent template: ${message}\n`)
    return 1
  }
}
