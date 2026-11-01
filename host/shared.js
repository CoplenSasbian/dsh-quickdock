/**
 * The one Host object both entry points share.
 *
 * DSH loads plugins by module specifier, so `dsh-quickdock/service` and
 * `dsh-quickdock/dock` are two entries in the plugin list but one module graph:
 * the service creates the Host, the dock entry attaches its window component to
 * it. A module-level handle is what keeps that simple - no second Host, no second
 * token, no second SSE hub.
 */

let host = null

/** @returns {object|null} the running Host, or null. */
export function getHost() {
  return host
}

/**
 * Remember the running Host.
 * @param {object|null} value host instance, or null to clear.
 */
export function setHost(value) {
  host = value || null
}
