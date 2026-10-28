/**
 * Test-only ESM resolve hook (needed only when node_modules is absent).
 *
 * Inside DSH the plugin resolves `@deepseek-ai/schemastery` through the profile
 * module router. A bare local checkout without `npm install` cannot, so this
 * hook borrows the copy installed in the DSH profile. When that fails it falls
 * back to Node's default resolver, which is the normal path in this repository.
 */
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Point QD_PROFILE_PACKAGE at another profile when the default one is not installed. */
const PROFILE = process.env.QD_PROFILE_PACKAGE
  || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', 'desktop', 'package.json')

let resolved
let failed = false

function target() {
  if (resolved !== undefined) return resolved
  try {
    const require = createRequire(PROFILE)
    const manifest = require.resolve('@deepseek-ai/schemastery/package.json')
    const pkg = require(manifest)
    const entry = pkg.exports?.['.']?.import || pkg.module || pkg.main
    resolved = pathToFileURL(require.resolve(manifest.replace('package.json', entry.replace('./', '')))).href
  } catch (error) {
    failed = true
    console.warn('[dev-harness] could not borrow schemastery from the DSH profile, using default resolution: ' + error.message)
    resolved = null
  }
  return resolved
}

export async function resolve(specifier, context, next) {
  if (specifier === '@deepseek-ai/schemastery') {
    const url = target()
    if (url) return { url, shortCircuit: true }
    void failed
  }
  return next(specifier, context)
}
