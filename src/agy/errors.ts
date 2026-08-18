import { CONTEXT_WINDOW_EXCEEDED_CODE, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import { redactText } from './redact.js'

/** Stable provider-neutral codes emitted after classifying AGY text/status details. */
export type AgyClassifiedErrorCode =
  | typeof CONTEXT_WINDOW_EXCEEDED_CODE
  | typeof QUOTA_EXCEEDED_CODE
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'MODEL_NOT_FOUND'
  | 'AGY_AGENT_MISSING'
  | 'AGY_STATUS'
  | 'AGY_EXIT'

/**
 * Classify observed AGY status/stderr/error-event detail. This is deliberately
 * conservative: unknown text keeps the caller-supplied fallback code.
 */
export function classifyAgyFailure(detail: string, fallback: string): string {
  const value = detail.trim().slice(0, 2_048)
  if (value.length === 0) return fallback
  if (/(?:context(?:\s+window)?|prompt|input).{0,48}(?:too\s+(?:long|large)|exceed|maximum|limit)|(?:maximum|limit).{0,48}(?:context|prompt|input)/i.test(value)) {
    return CONTEXT_WINDOW_EXCEEDED_CODE
  }
  if (/(?:quota|credit|balance|billing|budget|usage\s+limit|limit\s+(?:exceeded|reached))/i.test(value)) {
    return QUOTA_EXCEEDED_CODE
  }
  if (/(?:rate\s*limit|too\s+many\s+requests|throttl|\b429\b)/i.test(value)) return 'RATE_LIMIT'
  if (/(?:model|deployment).{0,48}(?:not\s+found|unknown|invalid|unavailable|does\s+not\s+exist)|no\s+such\s+model/i.test(value)) {
    return 'MODEL_NOT_FOUND'
  }
  if (/(?:agent|profile).{0,48}(?:not\s+found|unknown|missing|invalid)/i.test(value)) return 'AGY_AGENT_MISSING'
  if (/(?:unauthori[sz]ed|not\s+authenticated|authentication|login|sign[\s-]+in|invalid\s+credential|expired\s+token|invalid\s+token|access\s+denied|forbidden)/i.test(value)) {
    return 'AUTH'
  }
  return fallback
}

/** Keep user-facing failure text bounded and redacted; structured logs use only the code. */
export function safeAgyFailureMessage(prefix: string, detail: string | undefined): string {
  const safeDetail = detail === undefined ? '' : redactText(detail.trim(), 512)
  return safeDetail.length === 0 ? prefix : `${prefix}: ${safeDetail}`
}
