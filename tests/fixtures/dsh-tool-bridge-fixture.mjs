import { writeFile } from 'node:fs/promises'

export const name = 'dsh-agy-provider-tool-bridge-fixture'
export const inject = ['tools', 'sessions']

export function apply(ctx) {
  const markerPath = process.env.DSH_FIXTURE_MARKER?.trim()
  const sessions = ctx.get('sessions')

  // Headless rc.7 does not mount the Web workspace registry. This disposable
  // fixture supplies only the read-only lookup required by the Provider's
  // trust boundary; it never creates or mutates workspace records.
  if (ctx.get('workspaceRegistry') === undefined) {
    ctx.provide('workspaceRegistry', {
      async resolveByPath(path) {
        const sessionIds = typeof sessions?.list === 'function'
          ? sessions.list()
            .filter(session => session.header?.cwd === path)
            .map(session => String(session.id))
          : []
        return {
          path,
          sessionIds,
          async status() {
            return 'ok'
          },
        }
      },
    })
  }

  ctx.tools.register({
    name: 'fixture_probe',
    description: 'Run a disposable no-side-effect bridge probe. DSH executes it; AGY never executes it.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['value'],
      properties: {
        value: { type: 'string', enum: ['bridge'] },
      },
    },
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
            required: ['type', 'text'],
            properties: {
              type: { type: 'string', const: 'text' },
              text: { type: 'string' },
            },
        },
      },
      render: (_args, value) => value,
    },
    async execute(args) {
      if (markerPath !== undefined) {
        await writeFile(markerPath, JSON.stringify({ value: args.value, executedBy: 'dsh-tool-runtime' }), 'utf8')
      }
      return [{ type: 'text', text: 'FIXTURE_PROBE_EXECUTED' }]
    },
  })
}
