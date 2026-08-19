import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AttachmentStore,
  ImageAttachmentRef,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { serializeAgyPrompt, serializeAgyTurnPrompt } from './serialize.js'

export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export const DEFAULT_IMAGE_MAX_BYTES = 8 * 1024 * 1024
export const DEFAULT_IMAGE_MAX_COUNT = 4
export type AgyImageMediaType = typeof IMAGE_MEDIA_TYPES[number]

export type AgyImageBridgeErrorCode =
  | 'IMAGE_ATTACHMENT_UNAVAILABLE'
  | 'IMAGE_AGENT_UNSUPPORTED'
  | 'IMAGE_READ_FAILED'
  | 'IMAGE_UNSUPPORTED_MEDIA_TYPE'
  | 'IMAGE_SIZE_LIMIT'
  | 'IMAGE_STAGING_FAILED'

export class AgyImageBridgeError extends Error {
  constructor(message: string, readonly code: AgyImageBridgeErrorCode, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AgyImageBridgeError'
  }
}

export type AgyImageAttachmentStore = Pick<AttachmentStore, 'readImage'>

export interface PreparedAgyPrompts {
  fullPrompt: string
  /** Precomputed only when image placeholders are present; text-only keeps the old lazy path. */
  turnPrompt: string | undefined
  imageDirectory: string | undefined
  cleanup: () => Promise<void>
}

interface StagedImage {
  path: string
  mediaType: AgyImageMediaType
  width: number
  height: number
}

export interface ImageBridgeOptions {
  enabled: boolean
  /** Only a bundled preset with a verified view_file whitelist may read staged images. */
  agentCanViewFile: boolean
  attachmentStore: AgyImageAttachmentStore | undefined
  signal?: AbortSignal
  maxBytes?: number
  maxCount?: number
}

const EXTENSIONS: Record<AgyImageMediaType, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
}

function imageRefsOf(content: readonly ContentBlock[], output: ImageAttachmentRef[] = []): ImageAttachmentRef[] {
  for (const block of content) {
    if (block.type === 'image') output.push(block.attachment)
    else if (block.type === 'tool-result') imageRefsOf(block.content, output)
  }
  return output
}

function imageKey(ref: ImageAttachmentRef): string {
  return String(ref.attachmentId)
}

function mediaTypeOf(value: string): value is AgyImageMediaType {
  return (IMAGE_MEDIA_TYPES as readonly string[]).includes(value)
}

function placeholderFor(image: StagedImage): string {
  return `[IMAGE_ATTACHMENT file=${image.path} media_type=${image.mediaType} width=${image.width} height=${image.height}]`
}

function replaceImageBlocks(content: readonly ContentBlock[], images: ReadonlyMap<string, StagedImage>): ContentBlock[] {
  return content.map(block => {
    if (block.type === 'image') {
      const image = images.get(imageKey(block.attachment))
      if (image === undefined) {
        throw new AgyImageBridgeError('Image attachment was not staged', 'IMAGE_STAGING_FAILED')
      }
      return { type: 'text', text: placeholderFor(image) }
    }
    if (block.type === 'tool-result') {
      return { ...block, content: replaceImageBlocks(block.content, images) }
    }
    return block
  })
}

function replaceMessageImages(messages: readonly Message[], images: ReadonlyMap<string, StagedImage>): Message[] {
  return messages.map(message => ({
    ...message,
    content: replaceImageBlocks(message.content, images),
  }))
}

function validateStoredImage(
  requested: ImageAttachmentRef,
  stored: StoredImageAttachment,
  totalBytes: number,
  maxBytes: number,
): { mediaType: AgyImageMediaType; nextTotalBytes: number } {
  const ref = stored.ref
  if (String(ref.attachmentId) !== String(requested.attachmentId)) {
    throw new AgyImageBridgeError('Attachment store returned a different image reference', 'IMAGE_READ_FAILED')
  }
  if (!mediaTypeOf(ref.mediaType)) {
    throw new AgyImageBridgeError(
      `Unsupported image media type: ${ref.mediaType}`,
      'IMAGE_UNSUPPORTED_MEDIA_TYPE',
    )
  }
  if (stored.data.byteLength !== ref.bytes || ref.bytes !== requested.bytes) {
    throw new AgyImageBridgeError('Image attachment byte length failed verification', 'IMAGE_READ_FAILED')
  }
  const nextTotalBytes = totalBytes + stored.data.byteLength
  if (nextTotalBytes > maxBytes) {
    throw new AgyImageBridgeError(
      `Image attachments exceed the ${maxBytes}-byte staging limit`,
      'IMAGE_SIZE_LIMIT',
    )
  }
  return { mediaType: ref.mediaType, nextTotalBytes }
}

async function stageImages(
  refs: readonly ImageAttachmentRef[],
  options: ImageBridgeOptions,
): Promise<{ directory: string; images: ReadonlyMap<string, StagedImage>; cleanup: () => Promise<void> }> {
  const store = options.attachmentStore
  if (store === undefined) {
    throw new AgyImageBridgeError(
      'Image input requires an available DSH AttachmentStore; configure text-only mode or install the attachment service',
      'IMAGE_ATTACHMENT_UNAVAILABLE',
    )
  }
  const maxBytes = options.maxBytes ?? DEFAULT_IMAGE_MAX_BYTES
  const maxCount = options.maxCount ?? DEFAULT_IMAGE_MAX_COUNT
  const uniqueRefs = [...new Map(refs.map(ref => [imageKey(ref), ref])).values()]
  if (uniqueRefs.length > maxCount) {
    throw new AgyImageBridgeError(
      `Agy image bridge accepts at most ${maxCount} images per request`,
      'IMAGE_SIZE_LIMIT',
    )
  }

  let directory: string | undefined
  try {
    directory = await mkdtemp(join(tmpdir(), 'dsh-agy-image-'))
    const images = new Map<string, StagedImage>()
    let totalBytes = 0
    for (const [index, ref] of uniqueRefs.entries()) {
      let stored: StoredImageAttachment
      try {
        stored = await store.readImage(ref, options.signal)
      } catch (error) {
        if (error instanceof AgyImageBridgeError) throw error
        throw new AgyImageBridgeError('AttachmentStore could not read the image', 'IMAGE_READ_FAILED', { cause: error })
      }
      const validation = validateStoredImage(ref, stored, totalBytes, maxBytes)
      totalBytes = validation.nextTotalBytes
      const path = join(directory, `image-${index}-${randomUUID()}${EXTENSIONS[validation.mediaType]}`)
      await writeFile(path, stored.data, { flag: 'wx', mode: 0o600 })
      images.set(imageKey(ref), {
        path,
        mediaType: validation.mediaType,
        width: stored.ref.width,
        height: stored.ref.height,
      })
    }

    let cleaned = false
    const cleanup = async (): Promise<void> => {
      if (cleaned || directory === undefined) return
      cleaned = true
      await rm(directory, { recursive: true, force: true })
    }
    return { directory, images, cleanup }
  } catch (error) {
    if (directory !== undefined) await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    if (error instanceof AgyImageBridgeError) throw error
    throw new AgyImageBridgeError(
      `Could not stage image attachments: ${error instanceof Error ? error.message : String(error)}`,
      'IMAGE_STAGING_FAILED',
      { cause: error },
    )
  }
}

/**
 * Prepare text prompts for the experimental file bridge. The default path
 * intentionally delegates to the existing serializer and remains text-only.
 */
export async function prepareAgyPrompts(
  options: Pick<GenerateOptions, 'messages' | 'system'>,
  bridgeOptions: ImageBridgeOptions,
): Promise<PreparedAgyPrompts> {
  const refs = imageRefsOf(options.messages.flatMap(message => message.content))
  if (refs.length === 0) {
    return {
      fullPrompt: serializeAgyPrompt(options),
      turnPrompt: undefined,
      imageDirectory: undefined,
      cleanup: async () => undefined,
    }
  }
  if (!bridgeOptions.enabled) {
    return {
      fullPrompt: serializeAgyPrompt(options),
      turnPrompt: undefined,
      imageDirectory: undefined,
      cleanup: async () => undefined,
    }
  }
  if (!bridgeOptions.agentCanViewFile) {
    throw new AgyImageBridgeError(
      'Experimental image input requires the read-only or workspace-write Agent preset with view_file',
      'IMAGE_AGENT_UNSUPPORTED',
    )
  }

  const staged = await stageImages(refs, bridgeOptions)
  try {
    const messages = replaceMessageImages(options.messages, staged.images)
    return {
      fullPrompt: serializeAgyPrompt({
        ...(options.system === undefined ? {} : { system: options.system }),
        messages,
      }),
      turnPrompt: serializeAgyTurnPrompt({ messages }),
      imageDirectory: staged.directory,
      cleanup: staged.cleanup,
    }
  } catch (error) {
    await staged.cleanup()
    throw error
  }
}
