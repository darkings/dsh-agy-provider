import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  describeAgentPresets,
  installAgentPreset,
  readAgentPresetTemplate,
  runAgentsCli,
} from '../lib/index.js'

test('bundled Agent presets expose separated tool capabilities', () => {
  const presets = describeAgentPresets()
  assert.deepEqual(presets.map(preset => preset.id), ['tool-free', 'read-only', 'workspace-write'])
  assert.deepEqual(presets[0]?.tools, [])
  assert.deepEqual(presets[1]?.tools, ['find_by_name', 'grep_search', 'view_file', 'list_dir'])
  assert.deepEqual(presets[2]?.tools, [
    'find_by_name',
    'grep_search',
    'view_file',
    'list_dir',
    'multi_replace_file_content',
    'replace_file_content',
    'write_to_file',
  ])
  assert.equal(presets[2]?.writeAccess, true)
  assert.equal(presets.some(preset => preset.tools.includes('run_command')), false)
})

test('Agent template preview does not create files and apply is idempotent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-agent-preview-'))
  try {
    const preview = await installAgentPreset({ preset: 'read-only', directory })
    assert.equal(preview.applied, false)
    assert.equal(preview.action, 'create')
    await assert.rejects(readFile(join(directory, 'dsh-agy-read-only.md')))

    const applied = await installAgentPreset({ preset: 'read-only', directory, apply: true })
    assert.equal(applied.applied, true)
    assert.equal(applied.action, 'create')
    assert.equal(await readFile(applied.targetPath, 'utf8'), await readAgentPresetTemplate('read-only'))

    const unchanged = await installAgentPreset({ preset: 'read-only', directory, apply: true })
    assert.equal(unchanged.action, 'unchanged')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('Agent installer rejects conflicts by default and preserves an explicit backup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-agent-conflict-'))
  const target = join(directory, 'dsh-agy-workspace-write.md')
  try {
    await writeFile(target, 'user-owned agent\n', 'utf8')
    const preview = await installAgentPreset({ preset: 'workspace-write', directory })
    assert.equal(preview.action, 'conflict')
    await assert.rejects(
      installAgentPreset({ preset: 'workspace-write', directory, apply: true }),
      error => error.code === 'AGENT_TARGET_EXISTS',
    )

    const applied = await installAgentPreset({ preset: 'workspace-write', directory, apply: true, backup: true })
    assert.equal(applied.action, 'backup-and-create')
    assert.ok(applied.backupPath)
    assert.equal(await readFile(applied.backupPath, 'utf8'), 'user-owned agent\n')
    assert.equal(await readFile(target, 'utf8'), await readAgentPresetTemplate('workspace-write'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('Agent CLI exposes quota-free list and preview JSON', async () => {
  let stdout = ''
  let stderr = ''
  const listExit = await runAgentsCli(['agents', 'list', '--json'], text => { stdout += text }, text => { stderr += text })
  assert.equal(listExit, 0)
  assert.equal(stderr, '')
  assert.equal(JSON.parse(stdout).quotaUsed, false)
  assert.equal(JSON.parse(stdout).presets.length, 3)

  const directory = await mkdtemp(join(tmpdir(), 'dsh-agent-cli-'))
  try {
    stdout = ''
    const previewExit = await runAgentsCli([
      'agents', 'install', 'tool-free', '--dir', directory, '--json',
    ], text => { stdout += text }, text => { stderr += text })
    assert.equal(previewExit, 0)
    const result = JSON.parse(stdout)
    assert.equal(result.quotaUsed, false)
    assert.equal(result.applied, false)
    assert.equal(result.action, 'create')
    assert.deepEqual(await readdir(directory), [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
