import type { ToolSchema } from '@deepseek-ai/dsh-llm'

/** Upper bounds for the provider-side structured tool protocol. */
export const TOOL_PROTOCOL_LIMITS = Object.freeze({
  maxTools: 32,
  maxToolNameLength: 128,
  maxDescriptionLength: 4_096,
  maxSchemaDepth: 10,
  maxSchemaBytes: 64 * 1024,
  maxArgumentsBytes: 64 * 1024,
  maxMessageLength: 64 * 1024,
})

export const TOOL_PROTOCOL_SCHEMA_INVALID_CODE = 'TOOL_PROTOCOL_SCHEMA_INVALID' as const
export const TOOL_PROTOCOL_SCHEMA_LIMIT_CODE = 'TOOL_PROTOCOL_SCHEMA_LIMIT' as const
export const TOOL_PROTOCOL_RESPONSE_INVALID_CODE = 'TOOL_PROTOCOL_RESPONSE_INVALID' as const
export const TOOL_PROTOCOL_UNKNOWN_TOOL_CODE = 'TOOL_PROTOCOL_UNKNOWN_TOOL' as const
export const TOOL_PROTOCOL_ARGUMENTS_INVALID_CODE = 'TOOL_PROTOCOL_ARGUMENTS_INVALID' as const
export const TOOL_PROTOCOL_RESPONSE_LIMIT_CODE = 'TOOL_PROTOCOL_RESPONSE_LIMIT' as const

export type ToolProtocolErrorCode =
  | typeof TOOL_PROTOCOL_ARGUMENTS_INVALID_CODE
  | typeof TOOL_PROTOCOL_RESPONSE_INVALID_CODE
  | typeof TOOL_PROTOCOL_RESPONSE_LIMIT_CODE
  | typeof TOOL_PROTOCOL_SCHEMA_INVALID_CODE
  | typeof TOOL_PROTOCOL_SCHEMA_LIMIT_CODE
  | typeof TOOL_PROTOCOL_UNKNOWN_TOOL_CODE

/** Stable error that never embeds raw prompts, arguments, schemas, or paths. */
export class ToolProtocolError extends Error {
  readonly code: ToolProtocolErrorCode

  constructor(code: ToolProtocolErrorCode, detail?: string) {
    const prefix: Record<ToolProtocolErrorCode, string> = {
      [TOOL_PROTOCOL_ARGUMENTS_INVALID_CODE]: 'DSH tool arguments do not match the declared schema',
      [TOOL_PROTOCOL_RESPONSE_INVALID_CODE]: 'AGY structured response is invalid',
      [TOOL_PROTOCOL_RESPONSE_LIMIT_CODE]: 'AGY structured response exceeds the bounded limit',
      [TOOL_PROTOCOL_SCHEMA_INVALID_CODE]: 'DSH tool schema is invalid or uses an unsupported keyword',
      [TOOL_PROTOCOL_SCHEMA_LIMIT_CODE]: 'DSH tool schema exceeds the bounded protocol limit',
      [TOOL_PROTOCOL_UNKNOWN_TOOL_CODE]: 'AGY requested a tool outside the DSH allowlist',
    }
    super(detail === undefined ? prefix[code] : `${prefix[code]} (${detail})`)
    this.name = 'ToolProtocolError'
    this.code = code
  }
}

export type StructuredEnvelope =
  | {
      readonly kind: 'message'
      readonly content: string
    }
  | {
      readonly kind: 'tool_call'
      readonly name: string
      readonly arguments: Record<string, unknown>
    }

export interface StructuredToolProtocol {
  readonly schema: Record<string, unknown>
  readonly schemaJson: string
  readonly tools: readonly ToolSchema[]
}

type JsonRecord = Record<string, unknown>

const SAFE_TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
const SAFE_TYPES = new Set(['array', 'boolean', 'integer', 'null', 'number', 'object', 'string'])
const SUPPORTED_SCHEMA_KEYS = new Set([
  'additionalProperties',
  'allOf',
  'anyOf',
  'const',
  'default',
  'description',
  'enum',
  'exclusiveMaximum',
  'exclusiveMinimum',
  'format',
  'items',
  'maxItems',
  'maxLength',
  'maximum',
  'minItems',
  'minLength',
  'minimum',
  'multipleOf',
  'not',
  'oneOf',
  'pattern',
  'properties',
  'required',
  'title',
  'type',
  'uniqueItems',
])

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value as JsonRecord)) deepFreeze(child)
  return value
}

function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8')
  } catch {
    throw new ToolProtocolError(TOOL_PROTOCOL_SCHEMA_INVALID_CODE, 'schema is not lossless JSON')
  }
}

function requireBoundedInteger(value: unknown, label: string, maximum: number): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new ToolProtocolError(TOOL_PROTOCOL_SCHEMA_INVALID_CODE, `${label} is out of range`)
  }
  return value as number
}

function cloneJson(value: unknown, code: ToolProtocolErrorCode): unknown {
  try {
    return structuredClone(value)
  } catch {
    throw new ToolProtocolError(code, 'value is not lossless JSON')
  }
}

function schemaArray(value: unknown, depth: number, path: string): unknown[] {
  if (!Array.isArray(value) || value.length > 128) {
    throw new ToolProtocolError(TOOL_PROTOCOL_SCHEMA_INVALID_CODE, `${path} must be a bounded array`)
  }
  return value.map((entry, index) => sanitizeSchema(entry, depth + 1, `${path}[${index}]`))
}

function sanitizeSchema(value: unknown, depth: number, path: string): JsonRecord {
  if (!isRecord(value)) {
    throw new ToolProtocolError(TOOL_PROTOCOL_SCHEMA_INVALID_CODE, `${path} must be an object`)
  }
  if (depth > TOOL_PROTOCOL_LIMITS.maxSchemaDepth) {
    throw new ToolProtocolError(TOOL_PROTOCOL_SCHEMA_LIMIT_CODE, 'schema depth')
  }

  const output: JsonRecord = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!SUPPORTED_SCHEMA_KEYS.has(key)) {
      throw new ToolProtocolError(TOOL_PROTOCOL_SCHEMA_INVALID_CODE, `unsupported keyword ${key}`)
    }
    switch (key) {
      case 'type': {
        if (typeof entry === 'string') {
          if (!SAFE_TYPES.has(entry)) throw new ToolProtocolError(TOOL_PROTOCOL_SCHEMA_INVALID_CODE, 'type')
          output[key] = entry
        } else if (Array.isArray(entry) && entry.length > 0 && entry.length <= SAFE_TYPES.size
          && entry.every(type => typeof type === 'string' && SAFE_TYPES.has(type))) {
          output[key] = [...entry]
        } else {
          throw new ToolProtocolError(TOOL_PROTOCOL_SCHEMA_INVALID_CODE, 'type')
        }
        break
      }
      case 'properties': {
        if (!isRecord(entry) || Object.keys(entry).length > 128) {
          throw new ToolProtocolError(TOOL_PROTOCOL_SCHEMA_INVALID_CODE, 'properties')
        }
        const properties: JsonRecord = {}
        for (const [property, propertySchema] of Object.entries(entry)) {
          if (property.length === 0 || property.length > 128) {
            throw new ToolProtocolError(TOOL_PROTOCOL_SCHEMA_INVALID_CODE, 'property name')
          }
          properties[property] = sanitizeSchema(propertySchema, depth + 1, `${path}.${property}`)
        }
        output[key] = properties
        break
      }
      case 'required': {
        if (!Array.isArray(entry) || entry.length > 128 || entry.some(item => typeof item !== 'string')) {
          throw new ToolProtocolError(TOOL_PROTOCOL_SCHEMA_INVALID_CODE, 'required')
        }
        output[key] = [...new Set(entry)]
        break
      }
      case 'additionalProperties': {
        if (typeof entry === 'boolean') output[key] = entry
        else output[key] = sanitizeSchema(entry, depth + 1, `${path}.additionalProperties`)
        break
      }
      case 'items':
      case 'not': {
        output[key] = sanitizeSchema(entry, depth + 1, `${path}.${key}`)
        break
      }
      case 'oneOf':
      case 'anyOf':
      case 'allOf': {
        output[key] = schemaArray(entry, depth, `${path}.${key}`)
        break
      }
      case 'enum': {
        if (!Array.isArray(entry) || entry.length === 0 || entry.length > 128) {
          throw new ToolProtocolError(TOOL_PROTOCOL_SCHEMA_INVALID_CODE, 'enum')
        }
        output[key] = entry.map(item => cloneJson(item, TOOL_PROTOCOL_SCHEMA_INVALID_CODE))
        break
      }
      case 'const':
      case 'default': {
        output[key] = cloneJson(entry, TOOL_PROTOCOL_SCHEMA_INVALID_CODE)
        break
      }
      case 'description':
      case 'format':
      case 'pattern':
      case 'title': {
        if (typeof entry !== 'string' || entry.length > TOOL_PROTOCOL_LIMITS.maxDescriptionLength) {
          throw new ToolProtocolError(TOOL_PROTOCOL_SCHEMA_INVALID_CODE, key)
        }
        if (key === 'pattern') {
          try {
            new RegExp(entry)
          } catch {
            throw new ToolProtocolError(TOOL_PROTOCOL_SCHEMA_INVALID_CODE, 'pattern')
          }
        }
        output[key] = entry
        break
      }
      default: {
        const number = requireBoundedInteger(entry, key, Number.MAX_SAFE_INTEGER)
        if (number !== undefined) output[key] = number
        else if (typeof entry === 'number' && Number.isFinite(entry)) output[key] = entry
        else if (typeof entry === 'boolean' && key === 'uniqueItems') output[key] = entry
        else throw new ToolProtocolError(TOOL_PROTOCOL_SCHEMA_INVALID_CODE, key)
      }
    }
  }
  return output
}

function validateToolDefinition(tool: ToolSchema, index: number): { name: string; description: string; parameters: JsonRecord } {
  if (!isRecord(tool)) throw new ToolProtocolError(TOOL_PROTOCOL_SCHEMA_INVALID_CODE, `tool ${index}`)
  const name = tool.name
  const description = tool.description
  if (typeof name !== 'string' || name.length === 0 || name.length > TOOL_PROTOCOL_LIMITS.maxToolNameLength || !SAFE_TOOL_NAME.test(name)) {
    throw new ToolProtocolError(TOOL_PROTOCOL_SCHEMA_INVALID_CODE, `tool ${index} name`)
  }
  if (typeof description !== 'string' || description.length > TOOL_PROTOCOL_LIMITS.maxDescriptionLength) {
    throw new ToolProtocolError(TOOL_PROTOCOL_SCHEMA_INVALID_CODE, `tool ${name} description`)
  }
  const parameters = sanitizeSchema(tool.parameters, 0, `tool ${name}.parameters`)
  if (parameters.type !== 'object') {
    throw new ToolProtocolError(TOOL_PROTOCOL_SCHEMA_INVALID_CODE, `tool ${name}.parameters.type`)
  }
  return { name, description, parameters }
}

function envelopeSchema(tools: readonly { name: string; parameters: JsonRecord }[]): JsonRecord {
  const message: JsonRecord = {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'content'],
    properties: {
      kind: { enum: ['message'] },
      content: { type: 'string', maxLength: TOOL_PROTOCOL_LIMITS.maxMessageLength },
    },
  }
  const branches: JsonRecord[] = [message]
  for (const tool of tools) {
    branches.push({
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'name', 'arguments'],
      properties: {
        kind: { enum: ['tool_call'] },
        name: { enum: [tool.name] },
        arguments: tool.parameters,
      },
    })
  }
  return { oneOf: branches }
}

/** Convert DSH tool schemas into one strict, bounded AGY final-result schema. */
export function createStructuredToolProtocol(tools: readonly ToolSchema[]): StructuredToolProtocol {
  if (!Array.isArray(tools) || tools.length > TOOL_PROTOCOL_LIMITS.maxTools) {
    throw new ToolProtocolError(TOOL_PROTOCOL_SCHEMA_LIMIT_CODE, 'tool count')
  }
  const names = new Set<string>()
  const normalized: ToolSchema[] = []
  const definitions: Array<{ name: string; parameters: JsonRecord }> = []
  for (const [index, tool] of tools.entries()) {
    const validated = validateToolDefinition(tool, index)
    if (names.has(validated.name)) {
      throw new ToolProtocolError(TOOL_PROTOCOL_SCHEMA_INVALID_CODE, 'duplicate tool name')
    }
    names.add(validated.name)
    normalized.push({
      name: validated.name,
      description: validated.description,
      parameters: validated.parameters,
    })
    definitions.push({ name: validated.name, parameters: validated.parameters })
  }
  const schema = envelopeSchema(definitions)
  const schemaJson = JSON.stringify(schema)
  if (Buffer.byteLength(schemaJson, 'utf8') > TOOL_PROTOCOL_LIMITS.maxSchemaBytes) {
    throw new ToolProtocolError(TOOL_PROTOCOL_SCHEMA_LIMIT_CODE, 'schema bytes')
  }
  return deepFreeze({
    schema,
    schemaJson,
    tools: normalized,
  })
}

function valuesEqual(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'object': return isRecord(value)
    case 'array': return Array.isArray(value)
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return typeof value === 'number' && Number.isSafeInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    default: return false
  }
}

function matchesSchema(value: unknown, schema: JsonRecord): boolean {
  const type = schema.type
  if (typeof type === 'string' && !matchesType(value, type)) return false
  if (Array.isArray(type) && !type.some(item => typeof item === 'string' && matchesType(value, item))) return false
  if (Array.isArray(schema.enum) && !schema.enum.some(item => valuesEqual(value, item))) return false
  if (Object.hasOwn(schema, 'const') && !valuesEqual(value, schema.const)) return false
  if (Array.isArray(schema.oneOf) && schema.oneOf.filter(item => isRecord(item) && matchesSchema(value, item)).length !== 1) return false
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some(item => isRecord(item) && matchesSchema(value, item))) return false
  if (Array.isArray(schema.allOf) && !schema.allOf.every(item => isRecord(item) && matchesSchema(value, item))) return false
  if (isRecord(schema.not) && matchesSchema(value, schema.not)) return false

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) return false
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) return false
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) return false
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) return false
    if (typeof schema.maximum === 'number' && value > schema.maximum) return false
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) return false
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) return false
    if (typeof schema.multipleOf === 'number' && schema.multipleOf !== 0 && value % schema.multipleOf !== 0) return false
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) return false
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return false
    if (schema.uniqueItems === true && new Set(value.map(item => JSON.stringify(item))).size !== value.length) return false
    if (isRecord(schema.items) && value.some(item => !matchesSchema(item, schema.items as JsonRecord))) return false
  }
  if (isRecord(value)) {
    if (Array.isArray(schema.required) && schema.required.some(key => typeof key !== 'string' || !Object.hasOwn(value, key))) return false
    const properties = isRecord(schema.properties) ? schema.properties : {}
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (Object.hasOwn(value, key) && isRecord(propertySchema) && !matchesSchema(value[key], propertySchema)) return false
    }
    const additional = schema.additionalProperties
    for (const key of Object.keys(value)) {
      if (Object.hasOwn(properties, key)) continue
      if (additional === false) return false
      if (isRecord(additional) && !matchesSchema(value[key], additional)) return false
    }
  }
  return true
}

function protocolTools(protocolOrTools: StructuredToolProtocol | readonly ToolSchema[]): readonly ToolSchema[] {
  if (Array.isArray(protocolOrTools)) return protocolOrTools as readonly ToolSchema[]
  return (protocolOrTools as StructuredToolProtocol).tools
}

/** Strictly parse and validate AGY's final structured response. */
export function parseStructuredEnvelope(
  raw: unknown,
  protocolOrTools: StructuredToolProtocol | readonly ToolSchema[],
): StructuredEnvelope {
  let value: unknown = raw
  if (typeof raw === 'string') {
    if (Buffer.byteLength(raw, 'utf8') > TOOL_PROTOCOL_LIMITS.maxArgumentsBytes + TOOL_PROTOCOL_LIMITS.maxMessageLength) {
      throw new ToolProtocolError(TOOL_PROTOCOL_RESPONSE_LIMIT_CODE)
    }
    try {
      value = JSON.parse(raw)
    } catch {
      throw new ToolProtocolError(TOOL_PROTOCOL_RESPONSE_INVALID_CODE, 'not JSON')
    }
  }
  if (!isRecord(value)) throw new ToolProtocolError(TOOL_PROTOCOL_RESPONSE_INVALID_CODE, 'envelope')
  const kind = value.kind
  const keys = Object.keys(value)
  if (kind === 'message') {
    if (keys.some(key => !['kind', 'content'].includes(key)) || typeof value.content !== 'string') {
      throw new ToolProtocolError(TOOL_PROTOCOL_RESPONSE_INVALID_CODE, 'message shape')
    }
    if (value.content.length > TOOL_PROTOCOL_LIMITS.maxMessageLength) {
      throw new ToolProtocolError(TOOL_PROTOCOL_RESPONSE_LIMIT_CODE, 'message length')
    }
    return Object.freeze({ kind: 'message', content: value.content })
  }
  if (kind !== 'tool_call') throw new ToolProtocolError(TOOL_PROTOCOL_RESPONSE_INVALID_CODE, 'kind')
  if (keys.some(key => !['kind', 'name', 'arguments'].includes(key))
    || typeof value.name !== 'string'
    || !isRecord(value.arguments)) {
    throw new ToolProtocolError(TOOL_PROTOCOL_RESPONSE_INVALID_CODE, 'tool_call shape')
  }
  const tools = protocolTools(protocolOrTools)
  const tool = tools.find(candidate => candidate.name === value.name)
  if (tool === undefined) throw new ToolProtocolError(TOOL_PROTOCOL_UNKNOWN_TOOL_CODE)
  const argumentBytes = jsonBytes(value.arguments)
  if (argumentBytes > TOOL_PROTOCOL_LIMITS.maxArgumentsBytes) {
    throw new ToolProtocolError(TOOL_PROTOCOL_RESPONSE_LIMIT_CODE, 'arguments bytes')
  }
  const parameters = sanitizeSchema(tool.parameters, 0, `tool ${tool.name}.parameters`)
  if (!matchesSchema(value.arguments, parameters)) {
    throw new ToolProtocolError(TOOL_PROTOCOL_ARGUMENTS_INVALID_CODE, 'schema mismatch')
  }
  return Object.freeze({
    kind: 'tool_call',
    name: tool.name,
    arguments: deepFreeze(structuredClone(value.arguments)),
  })
}

/** Accumulate fragmented AGY result text without accepting an early partial JSON value. */
export class StructuredResponseAccumulator {
  private text = ''

  append(fragment: string): void {
    if (typeof fragment !== 'string') throw new ToolProtocolError(TOOL_PROTOCOL_RESPONSE_INVALID_CODE, 'fragment')
    const next = this.text + fragment
    if (Buffer.byteLength(next, 'utf8') > TOOL_PROTOCOL_LIMITS.maxArgumentsBytes + TOOL_PROTOCOL_LIMITS.maxMessageLength) {
      throw new ToolProtocolError(TOOL_PROTOCOL_RESPONSE_LIMIT_CODE)
    }
    this.text = next
  }

  parse(protocolOrTools: StructuredToolProtocol | readonly ToolSchema[]): StructuredEnvelope {
    return parseStructuredEnvelope(this.text, protocolOrTools)
  }

  get length(): number {
    return this.text.length
  }
}
