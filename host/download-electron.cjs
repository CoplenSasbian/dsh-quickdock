#!/usr/bin/env node
'use strict';

/**
 * Fetch and unpack an Electron build in a plain Node runtime.
 *
 * The Host process cannot load @electron/get (DSH's ESM loader shims it:
 * "require(...) is not a function"), but a child process can. This helper is
 * started with ELECTRON_RUN_AS_NODE so it uses Electron's bundled Node without any
 * of the host's module tricks.
 *
 * Usage: download-electron.cjs <version> <targetDir> <mirrorsJson>
 *
 * Prints one JSON object per line on stdout:
 *   {"received":n,"total":n}     while bytes arrive
 *   {"done":true,"ok":true}      when the folder is ready
 *   {"done":true,"ok":false,"error":"..."}
 */

const { rmSync } = require('node:fs');

async function main() {
  const [version, target, mirrorsJson] = process.argv.slice(2);
  if (!version || !target) {
    process.stdout.write(JSON.stringify({ done: true, ok: false, error: 'version and target required' }) + '\n');
    process.exit(2);
  }
  let mirrors = [''];
  try {
    const parsed = JSON.parse(mirrorsJson || '[]');
    if (Array.isArray(parsed) && parsed.length) mirrors = parsed;
  } catch (_) {
    /* keep the default mirror */
  }

  let download;
  let extract;
  try {
    const get = await import('@electron/get');
    const zip = await import('@electron-internal/extract-zip');
    download = get.download || (get.default && get.default.download);
    extract = zip.extract || (zip.default && zip.default.extract);
  } catch (error) {
    process.stdout.write(JSON.stringify({ done: true, ok: false, error: 'load failed: ' + String(error?.message || error) }) + '\n');
    process.exit(3);
  }
  if (typeof download !== 'function' || typeof extract !== 'function') {
    process.stdout.write(JSON.stringify({ done: true, ok: false, error: 'downloader exports missing' }) + '\n');
    process.exit(3);
  }

  const saved = {
    mirror: process.env.ELECTRON_MIRROR,
    npm: process.env.npm_config_electron_mirror,
    npmUpper: process.env.NPM_CONFIG_ELECTRON_MIRROR
  };
  let lastError = null;
  try {
    for (const mirror of mirrors) {
      delete process.env.npm_config_electron_mirror;
      delete process.env.NPM_CONFIG_ELECTRON_MIRROR;
      if (mirror) process.env.ELECTRON_MIRROR = mirror;
      else delete process.env.ELECTRON_MIRROR;
      try {
        const archive = await download(version, {
          ...(mirror ? { mirrorOptions: { mirror } } : {}),
          progressCallback: (progress) => {
            process.stdout.write(JSON.stringify({
              received: Number(progress?.received) || 0,
              total: Number(progress?.total) || 0,
              mirror: mirror || 'default'
            }) + '\n');
          }
        });
        // The caller keeps the old copy until this point: only now is it replaced.
        rmSync(target, { recursive: true, force: true });
        await extract(archive, { dir: target });
        process.stdout.write(JSON.stringify({ done: true, ok: true }) + '\n');
        return;
      } catch (error) {
        lastError = error;
        process.stdout.write(JSON.stringify({ mirror: mirror || 'default', failed: String(error?.message || error) }) + '\n');
      }
    }
    process.stdout.write(JSON.stringify({ done: true, ok: false, error: String(lastError?.message || lastError) }) + '\n');
    process.exitCode = 4;
  } finally {
    for (const [key, value] of [['ELECTRON_MIRROR', saved.mirror], ['npm_config_electron_mirror', saved.npm], ['NPM_CONFIG_ELECTRON_MIRROR', saved.npmUpper]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

main().catch((error) => {
  process.stdout.write(JSON.stringify({ done: true, ok: false, error: String(error?.message || error) }) + '\n');
  process.exit(5);
});
