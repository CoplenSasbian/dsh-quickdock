'use strict';

/**
 * Dock process configuration: command-line flags, environment variables and the
 * inline JSON payload `--quickdock-config`. The Host passes the same values
 * through DSH_QUICKDOCK_* variables; explicit flags win over the environment.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Parse `--key value` / `--key=value` / `--flag` arguments. */
function argumentMap(argv) {
  const result = Object.create(null);
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const equal = item.indexOf('=');
    const key = item.slice(2, equal < 0 ? undefined : equal);
    if (equal >= 0) result[key] = item.slice(equal + 1);
    else if (argv[index + 1] && !argv[index + 1].startsWith('--')) result[key] = argv[++index];
    else result[key] = true;
  }
  return result;
}

/** First value found among argument names, then environment names. */
function first(args, env, names, envNames) {
  for (const name of names) if (args[name] !== undefined) return args[name];
  for (const name of envNames || []) if (env[name]) return env[name];
  return undefined;
}

/** Positive safe integer or the fallback. */
function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

/**
 * Resolve the configuration.
 * @param {string[]} argv process arguments (without the script path).
 * @param {NodeJS.ProcessEnv} env process environment.
 * @returns {object} normalized configuration.
 * @throws {Error} when the page URL or host PID is missing, or the URL is not loopback.
 */
function parseConfig(argv, env) {
  const args = argumentMap(argv || []);
  const environment = env || process.env;
  let inline = {};
  const rawConfig = first(args, environment, ['quickdock-config', 'config'], ['DSH_QUICKDOCK_CONFIG']);
  if (typeof rawConfig === 'string') {
    const text = rawConfig.trim().startsWith('{')
      ? rawConfig
      : fs.readFileSync(path.resolve(rawConfig), 'utf8');
    inline = JSON.parse(text);
    if (!inline || typeof inline !== 'object' || Array.isArray(inline)) throw new Error('QuickDock config must be an object');
  }

  const token = first(args, environment, ['quickdock-token', 'token'], ['DSH_QUICKDOCK_TOKEN']);
  const port = first(args, environment, ['quickdock-port', 'port'], ['DSH_QUICKDOCK_PORT']);
  let url = first(args, environment, ['quickdock-url', 'url'], ['DSH_QUICKDOCK_URL']) || inline.url;
  if (!url && port && token) url = 'http://127.0.0.1:' + positiveInteger(port, 0) + '/quickdock?t=' + encodeURIComponent(token);
  if (!url) throw new Error('Missing QuickDock URL (--quickdock-url or DSH_QUICKDOCK_URL)');
  const parsed = new URL(url);
  // The dock only ever loads the Host's loopback page.
  if (!['http:', 'https:'].includes(parsed.protocol) || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname)) {
    throw new Error('QuickDock only loads a loopback HTTP URL');
  }
  if (token && !parsed.searchParams.has('t')) parsed.searchParams.set('t', token);

  const hostPid = positiveInteger(first(args, environment, ['quickdock-host-pid', 'host-pid', 'hostPid'], ['DSH_QUICKDOCK_HOST_PID']), 0);
  if (!hostPid) throw new Error('Missing valid host PID (--quickdock-host-pid or DSH_QUICKDOCK_HOST_PID)');

  return {
    url: parsed.href,
    hostPid,
    statePath: first(args, environment, ['quickdock-state', 'state'], ['DSH_QUICKDOCK_STATE']) || inline.statePath,
    width: positiveInteger(inline.width, 480),
    // Input window: fixed height, input UI only.
    inputHeight: positiveInteger(inline.inputHeight, 172),
    // Run window: fixed height, attached above or below the input window.
    displayHeight: positiveInteger(inline.displayHeight, 520),
    margin: Number.isFinite(inline.margin) ? inline.margin : 16,
    focusOnSummon: inline.focusOnSummon === true,
    rememberGeometry: inline.rememberGeometry !== false,
    // Closing the window ends the process in on-demand mode; resident mode hides it.
    exitOnClose: inline.exitOnClose !== false,
    saveDelayMs: positiveInteger(inline.saveDelayMs, 300),
    hostPollMs: positiveInteger(inline.hostPollMs, 2000),
    hitPollMs: positiveInteger(inline.hitPollMs, 60),
    showFallbackMs: positiveInteger(inline.showFallbackMs, 400),
  };
}

/** Default state file location (user data outside the plugin directory). */
function defaultStatePath(app, env) {
  if (env.LOCALAPPDATA) return path.join(env.LOCALAPPDATA, 'dsh-quickdock', 'window.json');
  return path.join(app.getPath('userData'), 'window.json');
}

module.exports = { argumentMap, defaultStatePath, parseConfig, positiveInteger };
