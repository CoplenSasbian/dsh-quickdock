'use strict';

const ALLOWED_TYPES = new Set(['show', 'attach', 'quit', 'ping']);

class HostProtocol {
  constructor(stream, onMessage, onError) {
    this.stream = stream;
    this.onMessage = onMessage;
    this.onError = onError || (() => {});
    this.buffer = '';
    this.handler = (chunk) => this.accept(chunk);
    if (stream && typeof stream.on === 'function') {
      stream.on('data', this.handler);
      stream.on('error', (error) => {
        // Piped stdio is not available on every Windows Electron configuration.
        if (error.code !== 'EPIPE' && error.code !== 'EOF') this.onError(error);
      });
    }
  }

  accept(chunk) {
    this.buffer += chunk.toString();
    // Bound memory even if the input is not newline delimited.
    if (this.buffer.length > 1024 * 1024) {
      this.buffer = '';
      this.onError(new Error('Host protocol line exceeds 1 MiB'));
      return;
    }
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '').trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      if (!line.startsWith('quickdock:')) continue;
      try {
        const message = JSON.parse(line.slice('quickdock:'.length));
        if (!message || typeof message !== 'object' || Array.isArray(message) || !ALLOWED_TYPES.has(message.type)) continue;
        if (message.type === 'attach' && (typeof message.sessionId !== 'string' || !message.sessionId || message.sessionId.length > 512)) continue;
        this.onMessage(message);
      } catch (error) {
        this.onError(error);
      }
    }
  }

  dispose() {
    if (this.stream && typeof this.stream.removeListener === 'function') {
      this.stream.removeListener('data', this.handler);
    }
    this.buffer = '';
  }
}

function writeStatus(stream, type, details) {
  if (!stream || stream.destroyed || stream.writable === false) return false;
  try {
    stream.write('quickdock:' + JSON.stringify(Object.assign({ type }, details || {})) + '\n');
    return true;
  } catch (_) {
    // A dead host must not turn an expected EPIPE into an uncaught exception.
    return false;
  }
}

module.exports = { HostProtocol, writeStatus };
