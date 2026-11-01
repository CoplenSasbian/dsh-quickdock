'use strict';

/**
 * The bundle patch must mount the package row.
 *
 * DSH builds the Web page's client-module roster from the rows a bundle declares,
 * and it resolves the client bundle (the header Dock button) from the row whose
 * name is the package name. An empty patch is therefore not "no extra rows": it
 * mounts nothing at all, the Host API included, and the button silently vanishes.
 *
 * This test pins the row, the client manifest, and the id the module registers
 * under, so the three have to stay in agreement.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const patch = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8')

/**
 * Read the row ids and names out of the bundle patch without a YAML dependency.
 * @param {string} text patch source.
 * @returns {Array<{id?: string, name?: string}>} rows in declaration order.
 */
function rows(text) {
  const found = []
  let current = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '')
    if (!line.trim()) continue
    const id = /^\s*-\s*id:\s*['"]?([^'"\s#]+)/.exec(line)
    if (id) {
      current = { id: id[1] }
      found.push(current)
      continue
    }
    const name = /^\s*name:\s*['"]?([^'"\s#]+)/.exec(line)
    if (name) {
      if (!current) {
        current = {}
        found.push(current)
      }
      current.name = name[1]
    }
  }
  return found
}

const declared = rows(patch)

test('bundle patch: mounts the row named after the package', () => {
  assert.ok(declared.length > 0, 'an empty patch mounts nothing: no Host API and no client bundle')
  const row = declared.find((entry) => entry.id === pkg.name)
  assert.ok(row, `no row with id ${pkg.name}`)
  // The roster resolves the client bundle from the row whose name is the package.
  assert.strictEqual(row.name, pkg.name, 'the row name is the package specifier')
})

test('client manifest: the web page can resolve and load the bundle', () => {
  assert.ok(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch, 'the package is a bundle')
  assert.strictEqual(pkg.dsh.client.platform, 'web', 'the button lives in the Web page')
  assert.ok(pkg.dsh.client.inject.includes('slots'), 'reading ctx.slots requires the slots service')
  assert.strictEqual(pkg.exports['./client'], './client.js', 'the bundle resolves to client.js')
  assert.ok(fs.existsSync(path.join(ROOT, 'client.js')), 'the artifact the manifest points at exists')
  const bundle = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8')
  assert.ok(
    bundle.includes(`id: "${pkg.name}"`),
    'the module registers under the package id, which is the id the row resolves'
  )
})
