import assert from 'node:assert/strict'
import test from 'node:test'
import { AgyPromptError, serializeAgyPrompt, serializeAgyTurnPrompt } from '../lib/provider/serialize.js'

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

test('serializeAgyTurnPrompt sends only messages after the previous assistant turn', () => {
  assert.equal(
    serializeAgyTurnPrompt({
      messages: [
        message('user', 'first'),
        message('assistant', 'first answer'),
        message('user', 'second'),
      ],
    }),
    '=== USER ===\nsecond',
  )
})

test('serializeAgyPrompt preserves DSH tool calls and tool results as text data', () => {
  const prompt = serializeAgyPrompt({
    messages: [
      {
        role: 'assistant',
        content: [{
          type: 'tool-call',
          id: 'call-1',
          name: 'read_file',
          arguments: '{"path":"fixture.txt"}',
        }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: 'call-1',
          content: [{ type: 'text', text: 'fixture contents' }],
        }],
      },
    ],
  })

  assert.match(prompt, /\[DSH TOOL CALL\]/)
  assert.match(prompt, /read_file/)
  assert.match(prompt, /\[DSH TOOL RESULT\]/)
  assert.match(prompt, /fixture contents/)
})
