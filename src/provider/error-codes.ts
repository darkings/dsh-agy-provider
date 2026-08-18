/** Stable codes used at the Provider boundary and in machine diagnostics. */
export const MODEL_DISCOVERY_FAILED_CODE = 'MODEL_DISCOVERY_FAILED' as const
export const MODEL_DISCOVERY_EMPTY_CODE = 'MODEL_DISCOVERY_EMPTY' as const
export const MODEL_DISCOVERY_TIMEOUT_CODE = 'MODEL_DISCOVERY_TIMEOUT' as const
export const MODEL_DISCOVERY_OUTPUT_LIMIT_CODE = 'MODEL_DISCOVERY_OUTPUT_LIMIT' as const
export const UNSUPPORTED_REASONING_EFFORT_CODE = 'UNSUPPORTED_REASONING_EFFORT' as const
export const UNSUPPORTED_TOOLS_CODE = 'UNSUPPORTED_TOOLS' as const
export const PERMISSION_REQUIRED_CODE = 'PERMISSION_REQUIRED' as const

export type ModelDiscoveryErrorCode =
  | typeof MODEL_DISCOVERY_FAILED_CODE
  | typeof MODEL_DISCOVERY_EMPTY_CODE
  | typeof MODEL_DISCOVERY_TIMEOUT_CODE
  | typeof MODEL_DISCOVERY_OUTPUT_LIMIT_CODE

const MODEL_DISCOVERY_ERROR_CODES: readonly ModelDiscoveryErrorCode[] = [
  MODEL_DISCOVERY_FAILED_CODE,
  MODEL_DISCOVERY_EMPTY_CODE,
  MODEL_DISCOVERY_TIMEOUT_CODE,
  MODEL_DISCOVERY_OUTPUT_LIMIT_CODE,
]

export function isModelDiscoveryErrorCode(value: unknown): value is ModelDiscoveryErrorCode {
  return typeof value === 'string' && MODEL_DISCOVERY_ERROR_CODES.includes(value as ModelDiscoveryErrorCode)
}
