import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { diagnoseProfile, runDoctor, runDoctorCli, formatDoctorHuman, formatDoctorHelp } from '../lib/doctor.js'

test('formatDoctorHelp returns CLI usage documentation', () => {
  const help = formatDoctorHelp()
  assert.match(help, /dsh-agy-provider \[doctor\] \[options\]/)
  assert.match(help, /--profile <name>/)
  assert.match(help, /--json/)
})

test('runDoctorCli handles --help and -v/--version flags', async () => {
  let stdoutOutput = ''
  let exitCode = await runDoctorCli(['--help'], text => { stdoutOutput += text })
  assert.equal(exitCode, 0)
  assert.match(stdoutOutput, /dsh-agy-provider/)

  stdoutOutput = ''
  exitCode = await runDoctorCli(['-v'], text => { stdoutOutput += text })
  assert.equal(exitCode, 0)
  assert.match(stdoutOutput, /\d+\.\d+\.\d+/)
})

test('diagnoseProfile reports missing DSH home and missing profile', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'dsh-doctor-test-'))
  try {
    const nonExistentHome = join(tempDir, 'non-existent-home')
    const resultMissingHome = await diagnoseProfile({
      profileName: 'web',
      dshHome: nonExistentHome,
    })
    assert.equal(resultMissingHome.dshHomePresent, false)
    assert.equal(resultMissingHome.issues.some(i => i.code === 'DSH_HOME_NOT_FOUND'), true)

    const homeWithNoProfile = join(tempDir, 'empty-home')
    await mkdir(homeWithNoProfile, { recursive: true })
    const resultMissingProfile = await diagnoseProfile({
      profileName: 'web',
      dshHome: homeWithNoProfile,
    })
    assert.equal(resultMissingProfile.dshHomePresent, true)
    assert.equal(resultMissingProfile.profilePresent, false)
    assert.equal(resultMissingProfile.issues.some(i => i.code === 'PROFILE_NOT_FOUND'), true)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('diagnoseProfile rejects path traversal and unsafe profile names without reading outside DSH profiles', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'dsh-doctor-profile-name-'))
  try {
    const result = await diagnoseProfile({
      profileName: '../outside',
      dshHome: tempDir,
    })
    assert.equal(result.name, '<invalid>')
    assert.equal(result.profilePresent, false)
    assert.equal(result.issues.some(i => i.code === 'PROFILE_NAME_INVALID'), true)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('diagnoseProfile detects package missing, bundle missing, disabled, and reject policy', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'dsh-doctor-profile-'))
  try {
    const dshHome = join(tempDir, 'dsh-home')
    const webProfileDir = join(dshHome, 'profiles', 'web')
    await mkdir(webProfileDir, { recursive: true })

    // 1. Profile package.json has no dsh-agy-provider
    await writeFile(join(webProfileDir, 'package.json'), JSON.stringify({ name: 'profile-web' }, null, 2))
    const resNoPkg = await diagnoseProfile({ profileName: 'web', dshHome })
    assert.equal(resNoPkg.packageInstalled, false)
    assert.equal(resNoPkg.issues.some(i => i.code === 'PROFILE_PACKAGE_MISSING'), true)

    // 2. Profile package.json has dependency but no bundle declaration
    await writeFile(join(webProfileDir, 'package.json'), JSON.stringify({
      name: 'profile-web',
      dependencies: { 'dsh-agy-provider': '0.5.0' },
      dsh: { profile: { bundles: [] } },
    }, null, 2))
    const resNoBundle = await diagnoseProfile({ profileName: 'web', dshHome })
    assert.equal(resNoBundle.packageInstalled, true)
    assert.equal(resNoBundle.bundleDeclared, false)
    assert.equal(resNoBundle.issues.some(i => i.code === 'PROFILE_BUNDLE_MISSING'), true)

    // 3. Profile package.json has dependency and bundle, but dump-config returns disabled
    await writeFile(join(webProfileDir, 'package.json'), JSON.stringify({
      name: 'profile-web',
      dependencies: { 'dsh-agy-provider': '0.5.0' },
      dsh: { profile: { bundles: ['dsh-agy-provider'] } },
    }, null, 2))
    const mockDisabledRunner = async () => ({
      exitCode: 0,
      timedOut: false,
      stdout: `# == dsh-agy-provider\n  enabled: false\n  toolPolicy: reject\n`,
      stderr: '',
    })
    const resDisabled = await diagnoseProfile({
      profileName: 'web',
      dshHome,
      dshBin: join(webProfileDir, 'mock-dsh.js'),
      runCommand: mockDisabledRunner,
    })
    assert.equal(resDisabled.bundleDeclared, true)
    assert.equal(resDisabled.bundleEnabled, false)
    assert.equal(resDisabled.issues.some(i => i.code === 'PROFILE_BUNDLE_DISABLED'), true)
    assert.equal(resDisabled.issues.some(i => i.code === 'PROFILE_TOOL_POLICY_REJECT'), true)

    // 4. Properly configured web profile
    const mockEnabledRunner = async () => ({
      exitCode: 0,
      timedOut: false,
      stdout: `# == dsh-agy-provider\n  enabled: true\n  toolPolicy: dsh-owned\n  provider: agy\n  model: gemini-3.1-pro-high\n`,
      stderr: '',
    })
    const resReady = await diagnoseProfile({
      profileName: 'web',
      dshHome,
      dshBin: join(webProfileDir, 'mock-dsh.js'),
      runCommand: mockEnabledRunner,
    })
    assert.equal(resReady.bundleDeclared, true)
    assert.equal(resReady.bundleEnabled, true)
    assert.equal(resReady.toolPolicy, 'dsh-owned')
    assert.equal(resReady.effectiveProvider, 'agy')
    assert.equal(resReady.effectiveModel, 'gemini-3.1-pro-high')
    assert.equal(resReady.issues.length, 0)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('diagnoseProfile resolves a Windows npm shim to the DSH JavaScript entry when available', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'dsh-doctor-shim-'))
  try {
    const dshHome = join(tempDir, 'dsh-home')
    const profileDir = join(dshHome, 'profiles', 'web')
    const shimPath = join(profileDir, 'node_modules', '.bin', 'dsh.cmd')
    const dshEntry = join(profileDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    await mkdir(join(profileDir, 'node_modules', '.bin'), { recursive: true })
    await mkdir(join(profileDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
    await writeFile(shimPath, '@echo off\n', 'utf8')
    await writeFile(dshEntry, '', 'utf8')
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({
      name: 'profile-web',
      dependencies: { 'dsh-agy-provider': '0.5.0' },
      dsh: { profile: { bundles: ['dsh-agy-provider'] } },
    }, null, 2))

    let observed
    const result = await diagnoseProfile({
      profileName: 'web',
      dshHome,
      dshBin: shimPath,
      runCommand: async (executable, args) => {
        observed = { executable, args: [...args] }
        return {
          exitCode: 0,
          timedOut: false,
          stdout: '# == dsh-agy-provider\n  enabled: true\n  toolPolicy: agy-owned\n',
          stderr: '',
        }
      },
    })

    assert.equal(result.bundleEnabled, true)
    assert.ok(observed)
    if (process.platform === 'win32') {
      assert.equal(observed.executable, process.execPath)
      assert.equal(observed.args[0], dshEntry)
    } else {
      assert.equal(observed.executable, shimPath)
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('runDoctor combines provider and profile diagnostics into unified report', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'dsh-doctor-unified-'))
  try {
    const dshHome = join(tempDir, 'dsh-home')
    const headlessProfileDir = join(dshHome, 'profiles', 'headless')
    await mkdir(headlessProfileDir, { recursive: true })
    await writeFile(join(headlessProfileDir, 'package.json'), JSON.stringify({
      name: 'profile-headless',
      dependencies: { 'dsh-agy-provider': '0.5.0' },
      dsh: { profile: { bundles: ['dsh-agy-provider'] } },
    }, null, 2))

    const doctorResult = await runDoctor({
      profile: 'headless',
      dshHome,
      runCommand: async req => {
        if (req.args[0] === '--version') {
          return { exitCode: 0, signal: null, termination: 'completed', stdoutLines: ['1.1.14'], stderr: '', durationMs: 1 }
        }
        if (req.args[0] === 'agents') {
          return { exitCode: 0, signal: null, termination: 'completed', stdoutLines: ['deepseek-proxy'], stderr: '', durationMs: 1 }
        }
        if (req.args[0] === 'models') {
          return { exitCode: 0, signal: null, termination: 'completed', stdoutLines: ['gemini-3.1-pro-high\tGemini Pro'], stderr: '', durationMs: 1 }
        }
        return { exitCode: 0, signal: null, termination: 'completed', stdoutLines: [], stderr: '', durationMs: 1 }
      },
    })

    assert.equal(doctorResult.schemaVersion, 2)
    assert.equal(doctorResult.quotaUsed, false)
    assert.equal(doctorResult.profile?.name, 'headless')
    assert.equal(doctorResult.profile?.packageInstalled, true)
    assert.equal(doctorResult.profile?.bundleDeclared, true)

    const humanFormatted = formatDoctorHuman(doctorResult)
    assert.match(humanFormatted, /dsh-agy-provider doctor/)
    assert.match(humanFormatted, /profile \[headless\]/)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('doctor v3 reports effective DSH bridge capabilities without exposing workspace paths', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'dsh-doctor-effective-'))
  try {
    const dshHome = join(tempDir, 'dsh-home')
    const profileDir = join(dshHome, 'profiles', 'workspace')
    const workspaceRoot = join(tempDir, 'workspace-root')
    await mkdir(profileDir, { recursive: true })
    await mkdir(workspaceRoot, { recursive: true })
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({
      name: 'profile-workspace',
      dependencies: { 'dsh-agy-provider': '0.5.0' },
      dsh: { profile: { bundles: ['dsh-agy-provider'] } },
    }, null, 2))

    const result = await diagnoseProfile({
      profileName: 'workspace',
      dshHome,
      dshBin: join(profileDir, 'mock-dsh.js'),
      runCommand: async () => ({
        exitCode: 0,
        timedOut: false,
        stderr: '',
        stdout: `# == dsh-agy-provider
  enabled: true
  toolPolicy: dsh-owned
  provider: agy
  model: gemini-3.7-flash-low
  agent: dsh-agy-read-only
  agentPreset: read-only
  sessionMode: full
  workspaceRoot: ${workspaceRoot}
  imageInput: off
  retryPolicy:
    maxRetries: 0
    retryableCodes: [RATE_LIMIT, SERVER, TRANSPORT]
  purposeRoutes:
    compaction:
      model: gemini-3.7-flash-low
      agent: dsh-agy-tool-free
      reasoningEffort: low
`,
      }),
    })

    assert.equal(result.profileSchemaVersion, 4)
    assert.equal(result.effective.dumpStatus, 'ok')
    assert.equal(result.effective.agent, 'dsh-agy-read-only')
    assert.equal(result.effective.agentPreset, 'read-only')
    assert.equal(result.effective.sessionMode, 'full')
    assert.equal(result.effective.retryPolicy?.maxRetries, 0)
    assert.deepEqual(result.effective.retryPolicy?.retryableCodes, ['RATE_LIMIT', 'SERVER', 'TRANSPORT'])
    assert.equal(result.effective.purposeRoutes.compaction?.complete, true)
    assert.equal(result.effective.workspaceRootStatus, 'configured')
    assert.equal(result.effective.dshContext.session.state, 'not-probed')
    assert.equal(result.effective.dshContext.workspace.configured, true)
    assert.equal(result.effective.bridgeCapability.owner, 'dsh')
    assert.equal(result.effective.bridgeCapability.agent, 'dsh-agy-tool-free')
    assert.equal(result.effective.bridgeCapability.schemaCapability, 'prompt-contract-v1')
    assert.equal(result.effective.bridgeCapability.internalTools, 'empty')
    assert.equal(result.effective.agentCapability.frontmatterValid, true)
    assert.equal(result.effective.agentCapability.viewFile, true)
    assert.equal(result.effective.agentCapability.writeTools, false)
    assert.deepEqual(result.effective.modelCapability.inputModalities, ['text'])
    assert.equal(result.effective.modelCapability.imageBridge, 'off')
    assert.deepEqual(result.repairSuggestions, [])
    assert.equal(JSON.stringify(result).includes(workspaceRoot), false)
    assert.equal(result.issues.length, 0)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('doctor v3 emits stable dump failure codes and read-only repair suggestions', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'dsh-doctor-dump-failure-'))
  try {
    const dshHome = join(tempDir, 'dsh-home')
    const profileDir = join(dshHome, 'profiles', 'web')
    await mkdir(profileDir, { recursive: true })
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({
      name: 'profile-web',
      dependencies: { 'dsh-agy-provider': '0.5.0' },
      dsh: { profile: { bundles: ['dsh-agy-provider'] } },
    }, null, 2))

    const timeoutResult = await diagnoseProfile({
      profileName: 'web',
      dshHome,
      dshBin: 'mock-dsh',
      runCommand: async () => ({ exitCode: null, timedOut: true, stdout: '', stderr: 'secret path must not surface' }),
    })
    assert.equal(timeoutResult.effective.dumpStatus, 'timeout')
    assert.equal(timeoutResult.issues.some(issue => issue.code === 'PROFILE_DUMP_TIMEOUT'), true)
    assert.equal(timeoutResult.issues.some(issue => issue.message.includes('secret')), false)
    assert.equal(timeoutResult.repairSuggestions.some(value => value.includes('--dump-config')), true)

    const nonzeroResult = await diagnoseProfile({
      profileName: 'web',
      dshHome,
      dshBin: 'mock-dsh',
      runCommand: async () => ({ exitCode: 7, timedOut: false, stdout: '', stderr: 'private stderr' }),
    })
    assert.equal(nonzeroResult.effective.dumpStatus, 'nonzero')
    assert.equal(nonzeroResult.issues.some(issue => issue.code === 'PROFILE_DUMP_NONZERO'), true)

    const parseResult = await diagnoseProfile({
      profileName: 'web',
      dshHome,
      dshBin: 'mock-dsh',
      runCommand: async () => ({ exitCode: 0, timedOut: false, stdout: 'not a dsh config', stderr: '' }),
    })
    assert.equal(parseResult.effective.dumpStatus, 'parse-error')
    assert.equal(parseResult.issues.some(issue => issue.code === 'PROFILE_DUMP_PARSE_FAILED'), true)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('doctor v3 flags unsafe effective Agent combinations without modifying the profile', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'dsh-doctor-effective-unsafe-'))
  try {
    const dshHome = join(tempDir, 'dsh-home')
    const profileDir = join(dshHome, 'profiles', 'unsafe')
    await mkdir(profileDir, { recursive: true })
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({
      name: 'profile-unsafe',
      dependencies: { 'dsh-agy-provider': '0.5.0' },
      dsh: { profile: { bundles: ['dsh-agy-provider'] } },
    }, null, 2))

    const result = await diagnoseProfile({
      profileName: 'unsafe',
      dshHome,
      dshBin: 'mock-dsh',
      runCommand: async () => ({
        exitCode: 0,
        timedOut: false,
        stderr: '',
        stdout: `# == dsh-agy-provider
  enabled: true
  toolPolicy: agy-owned
  provider: agy
  model: gemini-3.7-flash-low
  agent: dsh-agy-workspace-write
  agentPreset: workspace-write
  imageInput: experimental
  purposeRoutes:
    compaction:
      model: gemini-3.7-flash-low
`,
      }),
    })

    assert.equal(result.effective.agentCapability.writeTools, true)
    assert.equal(result.effective.workspaceRootStatus, 'unknown')
    assert.equal(result.issues.some(issue => issue.code === 'PROFILE_WORKSPACE_REQUIRED'), true)
    assert.equal(result.issues.some(issue => issue.code === 'PROFILE_IMAGE_AGENT_UNSUPPORTED'), false)
    assert.equal(result.issues.some(issue => issue.code === 'PROFILE_PURPOSE_ROUTE_INCOMPLETE'), true)
    assert.equal(result.repairSuggestions.some(value => value.includes('workspaceRoot')), true)
    assert.equal(result.repairSuggestions.some(value => value.includes('purposeRoutes.compaction')), true)

    const imageOnlyResult = await diagnoseProfile({
      profileName: 'unsafe',
      dshHome,
      dshBin: 'mock-dsh',
      runCommand: async () => ({
        exitCode: 0,
        timedOut: false,
        stderr: '',
        stdout: `# == dsh-agy-provider
  enabled: true
  provider: agy
  model: gemini-3.7-flash-low
  agent: dsh-agy-tool-free
  agentPreset: tool-free
  imageInput: experimental
`,
      }),
    })
    assert.equal(imageOnlyResult.effective.agentCapability.viewFile, false)
    assert.equal(imageOnlyResult.issues.some(issue => issue.code === 'PROFILE_IMAGE_AGENT_UNSUPPORTED'), true)
    assert.equal(imageOnlyResult.repairSuggestions.some(value => value.includes('agents install read-only')), true)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})