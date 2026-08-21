export const name = 'dsh-agy-provider-web-local-provider-fixture'
export const inject = ['web']

export function apply(ctx) {
  if (ctx.web === undefined) throw new Error('WEB_RUNTIME_NOT_INJECTED')
  ctx.web.registerFetchProvider({
    id: 'fixture-local-fetch',
    available: () => true,
    async fetch(request, signal) {
      const response = await globalThis.fetch(request.url, { signal })
      const contentType = response.headers.get('content-type') ?? ''
      const content = await response.text()
      return {
        url: response.url,
        statusCode: response.status,
        body: {
          kind: contentType.includes('html') ? 'html' : 'text',
          content,
        },
        truncated: false,
      }
    },
  })
}
