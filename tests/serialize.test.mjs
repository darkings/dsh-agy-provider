import assert from 'node:assert/strict'
import test from 'node:test'
import { AgyPromptError, serializeAgyPrompt } from '../lib/provider/serialize.js'

const message = (role, text) => ({
  role,
  content: [{ type: 'text', text }],
})

test('serializeAgyPrompt is deterministic and preserves the DSH conversation order', () => {
  assert.equal(
    serializeAgyPrompt({
      system: 'Be concise.',
      messages: [message('user', 'first'), message('assistant', 'second')],
    }),
    '=== SYSTEM ===\nBe concise.\n\n=== USER ===\nfirst\n\n=== ASSISTANT ===\nsecond',
  )
})

test('serializeAgyPrompt rejects non-text content instead of silently dropping it', () => {
  assert.throws(
    () => serializeAgyPrompt({
      messages: [{ role: 'user', content: [{ type: 'image', attachment: {} }] }],
    }),
    error => error instanceof AgyPromptError && error.code === 'UNSUPPORTED_CONTENT',
  )
})
