import z from '@deepseek-ai/schemastery'

export interface Config {
  /** Keep the bundle inert until explicitly enabled. */
  enabled?: boolean
  /** DSH provider route owned by this plugin. */
  provider?: string
  /** AGY model passed to the CLI when a request does not override it. */
  model?: string
  /** AGY agent profile, for example `deepseek-proxy`. */
  agent?: string
  /** Explicit AGY executable path; empty means discover from environment/PATH. */
  agyPath?: string
  /** Hard upper bound for one AGY child process. */
  timeoutMs?: number
  /** Deterministic response used only by the M1 mock route. */
  response?: string
  /** Optional delay used only by the M1 mock route. */
  delayMs?: number
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  provider: z.string().default('agy'),
  model: z.string().default('gemini-3.1-pro-high'),
  agent: z.string().default('deepseek-proxy'),
  agyPath: z.string().default(''),
  timeoutMs: z.number().min(1).max(3_600_000).default(120_000),
  response: z.string().default('AGY mock provider is ready.'),
  delayMs: z.number().min(0).max(60_000).default(0),
})
