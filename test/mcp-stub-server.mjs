/**
 * Minimal Streamable HTTP MCP server used to verify the workspace-mcp bridge.
 * Serves one tool (`echo`) on POST /mcp and answers JSON-RPC with JSON bodies.
 */
import { createServer } from 'node:http'

const TOOL = {
  name: 'echo',
  description: 'Echo the given text back.',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string', description: 'Text to echo' } },
    required: ['text'],
  },
}

let sessionCounter = 0

function reply(request) {
  const method = request.method ?? ''
  const params = request.params ?? {}
  if (method === 'initialize') {
    return {
      protocolVersion: params.protocolVersion ?? '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'workspace-mcp-test', version: '1.0.0' },
    }
  }
  if (method === 'ping') return {}
  if (method === 'tools/list') return { tools: [TOOL] }
  if (method === 'tools/call') {
    const text = String(params.arguments?.text ?? '')
    return { content: [{ type: 'text', text: `echo: ${text}` }] }
  }
  return undefined
}

const server = createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' }).end()
    return
  }
  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    let payload
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }))
      return
    }
    const messages = Array.isArray(payload) ? payload : [payload]
    const answers = []
    for (const message of messages) {
      if (message.id === undefined) continue
      const result = reply(message)
      answers.push(result === undefined
        ? { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } }
        : { jsonrpc: '2.0', id: message.id, result })
    }
    if (answers.length === 0) {
      res.writeHead(202).end()
      return
    }
    const headers = { 'content-type': 'application/json' }
    if (messages.some(message => message.method === 'initialize')) {
      sessionCounter += 1
      headers['mcp-session-id'] = `test-session-${sessionCounter}`
    }
    res.writeHead(200, headers).end(JSON.stringify(answers.length === 1 ? answers[0] : answers))
  })
})

server.listen(7311, '127.0.0.1', () => {
  console.log('test-mcp-server listening on http://127.0.0.1:7311/mcp')
})
