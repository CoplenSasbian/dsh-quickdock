'use strict';

/**
 * Line protocol between the Host half and the dock process.
 *
 * Only stdout framing and status writing live here. Unknown command types are
 * dropped so a Host/newer-dock mismatch cannot crash the renderer.
 */

const ALLOWED_TYPES = new Set(['show', 'attach', 'quit', 'ping']);
const MAX_LINE = 1024 * 1024;

class HostProtocol {
  /**
   * @param {NodeJS.ReadableStream} stream host stdin (or stdout in tests).
   * @param {(message: object) => void} onMessage accepted commands.
   * @param {(error: Error) => void} [onError] malformed frames and stream errors.
   */
  constructor(stream, onMessage, onError) {
    this.stream = stream;
    this.onMessage = onMessage;
    this.onError = onError || (() => {});
    this.buffer = '';
    this.handler = (chunk) => this.accept(chunk);
    if (stream && typeof stream.on === 'function') {
      stream.on('data', this.handler);
      stream.on('error', (error) => {
        // Piped stdio is unavailable in some Windows Electron configurations.
        if (error.code !== 'EPIPE' && error.code !== 'EOF') this.onError(error);
      });
    }
  }

  /** Consume a chunk, dispatching every complete `quickdock:` line. */
  accept(chunk) {
    this.buffer += chunk.toString();
    // Bound memory even if the peer never sends a newline.
    if (this.buffer.length > MAX_LINE) {
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

  /** Detach from the stream. */
  dispose() {
    if (this.stream && typeof this.stream.removeListener === 'function') {
      this.stream.removeListener('data', this.handler);
    }
    this.buffer = '';
  }
}

/**
 * Write one status line to the Host.
 * @returns {boolean} false when the pipe is gone (expected during shutdown).
 */
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
