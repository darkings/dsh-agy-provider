import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'

export type AgyPromptErrorCode = 'EMPTY_PROMPT' | 'UNSUPPORTED_CONTENT'

export class AgyPromptError extends Error {
  constructor(message: string, readonly code: AgyPromptErrorCode) {
    super(message)
    this.name = 'AgyPromptError'
  }
}

function blockText(block: ContentBlock, messageIndex: number, blockIndex: number): string {
  switch (block.type) {
    case 'text':
      return block.text
    case 'reasoning':
      return `[reasoning]\n${block.text}`
    default:
      throw new AgyPromptError(
        `AGY text MVP does not support content block ${block.type} at message ${messageIndex}, block ${blockIndex}`,
        'UNSUPPORTED_CONTENT',
      )
  }
}

function messageText(message: Message, messageIndex: number): string {
  return message.content
    .map((block, blockIndex) => blockText(block, messageIndex, blockIndex))
    .join('\n')
}

function roleLabel(message: Message): string {
  return message.role.toUpperCase()
}

/** Serialize the DSH request into a deterministic, text-only AGY prompt. */
export function serializeAgyPrompt(options: Pick<GenerateOptions, 'messages' | 'system'>): string {
  const sections: string[] = []
  if (options.system !== undefined && options.system.length > 0) {
    sections.push(`=== SYSTEM ===\n${options.system}`)
  }

  options.messages.forEach((message, messageIndex) => {
    sections.push(`=== ${roleLabel(message)} ===\n${messageText(message, messageIndex)}`)
  })

  if (sections.length === 0) {
    throw new AgyPromptError('AGY text MVP requires a non-empty system or message prompt', 'EMPTY_PROMPT')
  }
  return sections.join('\n\n')
}

/**
 * Serialize only the messages added after the previous assistant turn.
 * AGY already owns the earlier turns when `--conversation` is used; sending
 * the complete DSH history again would duplicate context and spend quota.
 */
export function serializeAgyTurnPrompt(
  options: Pick<GenerateOptions, 'messages'>,
): string {
  let lastAssistant = -1
  options.messages.forEach((message, index) => {
    if (message.role === 'assistant') lastAssistant = index
  })
  const messages = options.messages.slice(lastAssistant + 1)
  return serializeAgyPrompt({ messages })
}
