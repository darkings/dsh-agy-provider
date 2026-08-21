import process from 'node:process'

const TOOL_NAME = 'matrix_probe'

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function response(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function error(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

function handle(message) {
  if (message?.method === 'notifications/initialized' || message?.id === undefined) return
  if (message.method === 'initialize') {
    response(message.id, {
      protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'dsh-agy-provider-matrix', version: '0.1.0' },
    })
    return
  }
  if (message.method === 'tools/list') {
    response(message.id, {
      tools: [{
        name: TOOL_NAME,
        description: 'Return a deterministic local MCP fixture result.',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string', enum: ['mcp'] } },
          required: ['value'],
          additionalProperties: false,
        },
      }],
    })
    return
  }
  if (message.method === 'tools/call') {
    if (message.params?.name !== TOOL_NAME || message.params?.arguments?.value !== 'mcp') {
      error(message.id, -32602, 'invalid matrix_probe arguments')
      return
    }
    response(message.id, {
      content: [{ type: 'text', text: 'MCP_STDIO_MATRIX_SUCCESS' }],
      isError: false,
    })
    return
  }
  error(message.id, -32601, `unsupported MCP method: ${String(message.method)}`)
}

let pending = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  pending += chunk
  while (true) {
    const newline = pending.indexOf('\n')
    if (newline < 0) break
    const line = pending.slice(0, newline).replace(/\r$/, '')
    pending = pending.slice(newline + 1)
    if (line.length === 0) continue
    try {
      handle(JSON.parse(line))
    } catch {
      // Keep stdout a valid MCP channel; malformed client input is ignored.
    }
  }
})
