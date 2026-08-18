import assert from 'node:assert/strict'
import test from 'node:test'
import { InMemorySessionStore, SessionRegistry } from '../lib/session/store.js'

test('InMemorySessionStore creates detached records and supports deletion', () => {
  const store = new InMemorySessionStore()
  const record = store.set('session-a', 'conversation-a')
  assert.equal(record.conversationId, 'conversation-a')
  assert.deepEqual(store.get('session-a')?.conversationId, 'conversation-a')
  assert.equal(store.delete('session-a'), true)
  assert.equal(store.get('session-a'), undefined)
  assert.equal(store.delete('session-a'), false)
})

test('SessionRegistry serializes one session but permits different sessions concurrently', async () => {
  const registry = new SessionRegistry()
  const events = []
  const first = await registry.acquire('same')
  const waiting = registry.acquire('same').then(release => {
    events.push('second-acquired')
    release()
  })
  const other = await registry.acquire('other')
  events.push('other-acquired')
  other()
  assert.deepEqual(events, ['other-acquired'])
  first()
  await waiting
  assert.deepEqual(events, ['other-acquired', 'second-acquired'])
})
