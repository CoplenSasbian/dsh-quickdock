/**
 * Run every unit test in one Node process.
 *
 * node:test can also spawn one process per file, but that needs piped stdio,
 * which some sandboxed hosts deny (EPERM). Loading the test files in-process
 * keeps `npm test` runnable everywhere and still reports per-test results.
 */
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const testDir = join(here, '..', 'runtime', 'test')

const files = (await readdir(testDir))
  .filter((name) => name.endsWith('.test.js'))
  .sort()

if (!files.length) {
  console.error('no test files found in ' + testDir)
  process.exitCode = 1
} else {
  for (const file of files) {
    await import(pathToFileURL(join(testDir, file)).href)
  }
}
