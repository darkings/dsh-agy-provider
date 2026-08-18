import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const testsDirectory = fileURLToPath(new URL('../tests/', import.meta.url))
const files = (await readdir(testsDirectory, { withFileTypes: true }))
  .filter(entry => entry.isFile() && entry.name.endsWith('.test.mjs'))
  .map(entry => fileURLToPath(new URL(`../tests/${entry.name}`, import.meta.url)))
  .sort()

if (files.length === 0) {
  console.error('No test files found')
  process.exitCode = 1
} else {
  const child = spawn(process.execPath, ['--test', ...files], {
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
  })
  await new Promise(resolve => {
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      process.exitCode = value
      resolve()
    }
    child.once('error', () => finish(1))
    child.once('close', (code, signal) => finish(code ?? (signal === null ? 1 : 1)))
  })
}
