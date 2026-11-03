/** Small HTTP helpers shared by the page listener and the API. */

/**
 * Write a JSON response.
 * @param {import('node:http').ServerResponse} res response.
 * @param {number} status status code.
 * @param {unknown} body JSON-serializable body.
 */
export function sendJson(res, status, body) {
  const text = JSON.stringify(body === undefined ? null : body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text)
  })
  res.end(text)
}
