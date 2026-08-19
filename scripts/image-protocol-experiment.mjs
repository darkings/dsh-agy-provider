import { AgyAdapter } from '../lib/provider/agy.js'
import { deflateSync } from 'node:zlib'

if (process.env.AGY_IMAGE_EXPERIMENT !== 'ALLOW') {
  console.error('Image experiment is disabled. Set AGY_IMAGE_EXPERIMENT=ALLOW to spend one AGY request.')
  process.exit(2)
}

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii')
  const body = Buffer.concat([typeBytes, data])
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(body), 0)
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  return Buffer.concat([length, body, checksum])
}

function solidRedPng() {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(2, 0)
  header.writeUInt32BE(2, 4)
  header[8] = 8
  header[9] = 2
  const pixels = Buffer.from([
    0, 255, 0, 0, 255, 0, 0,
    0, 255, 0, 0, 255, 0, 0,
  ])
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

const model = process.env.AGY_IMAGE_MODEL?.trim() || 'gemini-3.7-flash-low'
const agentPreset = process.env.AGY_IMAGE_AGENT_PRESET?.trim() || 'read-only'
const agent = agentPreset === 'read-only'
  ? 'dsh-agy-read-only'
  : agentPreset === 'workspace-write' ? 'dsh-agy-workspace-write' : agentPreset
const data = solidRedPng()
const ref = {
  attachmentId: 'dsh-agy-image-experiment',
  mediaType: 'image/png',
  bytes: data.byteLength,
  width: 2,
  height: 2,
}
const adapter = new AgyAdapter({
  model,
  agentPreset,
  imageInput: 'experimental',
  workspaceRoot: process.cwd(),
  toolPolicy: 'agy-owned',
  timeoutMs: 120_000,
}, {
  attachmentStore: {
    readImage: async requested => ({ ref: requested, data: new Uint8Array(data) }),
  },
})

const chunks = []
try {
  for await (const chunk of adapter.stream({
    provider: 'agy-image-experiment',
    model,
    system: 'You are testing an image bridge. Inspect the supplied image with your available tools. Do not infer image pixels from this instruction. What color is pixel (0,0)? Answer with one color word and a short reason.',
    messages: [{ role: 'user', content: [{ type: 'image', attachment: ref }] }],
  })) {
    chunks.push(chunk)
  }
  const response = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
  const safeResponse = response
    .replaceAll(process.cwd(), '<workspace>')
    .replaceAll(/C:\\Users\\[^\s]+/gi, '<local-path>')
    .slice(0, 500)
  console.log(JSON.stringify({
    quotaUsed: true,
    ok: true,
    model,
    agent,
    imageBridge: 'attachment-store-to-staged-file',
    responseLength: response.length,
    pixelAnswerDetected: /\bred\b|\b255\b/i.test(response),
    responsePreview: safeResponse,
  }, null, 2))
} catch (error) {
  console.log(JSON.stringify({
    quotaUsed: true,
    ok: false,
    model,
    agent,
    code: error?.code ?? 'AGY_IMAGE_EXPERIMENT_FAILED',
    message: String(error?.message ?? error).slice(0, 500),
  }, null, 2))
  process.exitCode = 1
}
