import { performance } from 'node:perf_hooks'
import { AgyConcurrencyLimiter } from '../lib/agy/limiter.js'
import { AgyStreamParser } from '../lib/agy/parser.js'
import { serializeAgyPrompt } from '../lib/provider/serialize.js'

const parserIterations = 20_000
const serializeIterations = 5_000
const limiterIterations = 5_000
const eventLine = `${JSON.stringify({
  event: 'step_update',
  step_update: { text_delta: 'ok', usage: { totalTokens: 2 } },
})}\n`
const promptOptions = {
  system: 'benchmark system',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'benchmark message' }] }],
}

const parser = new AgyStreamParser()
let parsedEvents = 0
let startedAt = performance.now()
for (let index = 0; index < parserIterations; index += 1) {
  parsedEvents += parser.push(eventLine).length
}
parsedEvents += parser.end().length
const parserMs = performance.now() - startedAt

startedAt = performance.now()
let promptLength = 0
for (let index = 0; index < serializeIterations; index += 1) {
  promptLength += serializeAgyPrompt(promptOptions).length
}
const serializeMs = performance.now() - startedAt

const limiter = new AgyConcurrencyLimiter({ maxConcurrent: 1, maxQueue: 0, queueTimeoutMs: 0 })
startedAt = performance.now()
for (let index = 0; index < limiterIterations; index += 1) {
  const release = await limiter.acquire()
  release()
}
const limiterMs = performance.now() - startedAt

console.log(JSON.stringify({
  node: process.version,
  platform: process.platform,
  parser: {
    iterations: parserIterations,
    parsedEvents,
    milliseconds: Number(parserMs.toFixed(3)),
    eventsPerSecond: Math.round(parserIterations / (parserMs / 1_000)),
  },
  serializer: {
    iterations: serializeIterations,
    totalPromptCharacters: promptLength,
    milliseconds: Number(serializeMs.toFixed(3)),
  },
  limiter: {
    iterations: limiterIterations,
    milliseconds: Number(limiterMs.toFixed(3)),
  },
}, null, 2))
