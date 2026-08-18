import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { configuredModels, type Config, type ModelConfig } from './config.js'

const DEFAULT_PROVIDER = 'agy-mock'
const DEFAULT_MOCK_MODEL = 'agy-mock-model'
const DEFAULT_RESPONSE = 'AGY mock provider is ready.'

function abortError(): LlmError {
  return new LlmError('AGY mock request aborted by caller', 'ABORTED')
}

function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms === 0) return Promise.resolve()
  if (signal?.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export class MockAdapter extends LlmAdapter {
  private readonly model: string
  private readonly models: readonly ModelConfig[]
  private readonly response: string
  private readonly delayMs: number

  constructor(config: Config = {}) {
    super()
    this.model = config.model ?? DEFAULT_MOCK_MODEL
    this.models = configuredModels({ ...config, model: config.model ?? DEFAULT_MOCK_MODEL })
    this.response = config.response ?? DEFAULT_RESPONSE
    this.delayMs = config.delayMs ?? 0
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'AGY (Mock)' }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.models.map(model => ({
      provider,
      id: model.id,
      name: model.name ?? 'AGY Mock Model',
      description: model.description ?? 'DSH Provider contract probe; does not consume AGY quota.',
      inputModalities: ['text'] as const,
    })))
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const configured = this.models.find(entry => entry.id === model)
    return Promise.resolve({
      provider,
      id: model,
      name: configured?.name ?? model,
      ...(configured?.description === undefined ? {} : { description: configured.description }),
      inputModalities: ['text'] as const,
      context: { contextWindow: configured?.contextWindow ?? 128_000 },
    })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.signal?.aborted) throw abortError()
    const text = this.response
    yield { type: 'block-start', index: 0, blockType: 'text' }
    await wait(this.delayMs, options.signal)
    if (options.signal?.aborted) throw abortError()
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 0, outputTokens: text.length } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
