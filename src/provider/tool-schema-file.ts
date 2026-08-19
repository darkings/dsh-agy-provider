import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StructuredToolProtocol } from './tool-protocol.js'

export interface StagedToolSchema {
  readonly path: string
  readonly cleanup: () => Promise<void>
}

/**
 * Stage one bounded schema outside the user workspace. The returned path is
 * intended only for AGY argv; callers must invoke cleanup on every outcome.
 */
export async function stageToolSchema(protocol: StructuredToolProtocol): Promise<StagedToolSchema> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-agy-tool-schema-'))
  const path = join(directory, 'schema.json')
  let cleaned = false
  const cleanup = async (): Promise<void> => {
    if (cleaned) return
    cleaned = true
    await rm(directory, { recursive: true, force: true })
  }
  try {
    await writeFile(path, protocol.schemaJson, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    return { path, cleanup }
  } catch (error) {
    await cleanup()
    throw error
  }
}
