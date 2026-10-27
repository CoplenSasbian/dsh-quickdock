'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DEFAULTS } = require('./geometry');

function cleanState(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const state = {
    width: Number.isFinite(input.width) ? Math.round(input.width) : DEFAULTS.width,
    height: Number.isFinite(input.height) ? Math.round(input.height) : DEFAULTS.inputHeight,
    alwaysOnTop: typeof input.alwaysOnTop === 'boolean' ? input.alwaysOnTop : false,
  };
  for (const key of ['x', 'y']) {
    if (Number.isFinite(input[key])) state[key] = Math.round(input[key]);
  }
  if (typeof input.displayId === 'string' || typeof input.displayId === 'number') {
    state.displayId = input.displayId;
  }
  if (typeof input.workspaceId === 'string') state.workspaceId = input.workspaceId;
  return state;
}

class WindowStore {
  constructor(filePath, options) {
    const opts = options || {};
    this.filePath = filePath;
    this.delay = Number.isFinite(opts.delay) ? Math.max(0, opts.delay) : 300;
    this.fs = opts.fs || fs;
    this.state = cleanState(opts.initialState);
    this.timer = null;
    this.dirty = false;
    this.queue = Promise.resolve();
    this.sequence = 0;
  }

  static load(filePath, options) {
    const opts = options || {};
    const io = opts.fs || fs;
    let initialState;
    try {
      initialState = cleanState(JSON.parse(io.readFileSync(filePath, 'utf8')));
    } catch (error) {
      if (error.code !== 'ENOENT' && error instanceof SyntaxError) {
        // Corrupt state must not prevent the dock from starting.
        initialState = undefined;
      } else if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
        throw error;
      }
    }
    return new WindowStore(filePath, Object.assign({}, opts, { initialState }));
  }

  update(patch) {
    this.state = cleanState(Object.assign({}, this.state, patch));
    this.dirty = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch(() => {});
    }, this.delay);
    if (this.timer.unref) this.timer.unref();
    return this.state;
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return this.queue;
    this.dirty = false;
    const snapshot = JSON.stringify(this.state, null, 2) + '\n';
    this.queue = this.queue.catch(() => {}).then(() => this.atomicWrite(snapshot));
    return this.queue;
  }

  async atomicWrite(contents) {
    const directory = path.dirname(this.filePath);
    const temporary = path.join(
      directory,
      '.window-' + process.pid + '-' + Date.now() + '-' + (++this.sequence) + '.tmp',
    );
    await this.fs.promises.mkdir(directory, { recursive: true });
    try {
      await this.fs.promises.writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 });
      await this.fs.promises.rename(temporary, this.filePath);
    } catch (error) {
      await this.fs.promises.unlink(temporary).catch(() => {});
      throw error;
    }
  }

  close() {
    return this.flush();
  }
}

module.exports = { WindowStore, cleanState };
