/**
 * The vendored plugin's actual behaviour: which requests get the header, and with what value.
 *
 * The installer is tested elsewhere; this is the part that decides whether the gateway sees a
 * header at all. `globalThis.fetch` is never patched here — `wrapFetch` is exercised directly,
 * so a test failure cannot leak into another test's network calls.
 *
 * @module dsh-upgrade/tests/plugin
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_HEADER,
  normalizeConfig,
  runInSession,
  withSession,
  wrapFetch,
} from '../plugins/opencode-session/lib/index.js'

/** A fetch that records the request and answers 204. */
function recordingFetch(): { calls: { url: string, init?: RequestInit }[], fetch: typeof fetch } {
  const calls: { url: string, init?: RequestInit }[] = []
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, ...init === undefined ? {} : { init } })
    return new Response(null, { status: 204 })
  }) as typeof fetch
  return { calls, fetch: fake }
}

/** Read one request header from a recorded call. */
function headerOf(call: { init?: RequestInit } | undefined, name: string): string | null {
  const headers = new Headers(call?.init?.headers)
  return headers.get(name)
}

test('the header is sent only inside a session and only to a matching URL', async () => {
  const recorded = recordingFetch()
  const patched = wrapFetch(recorded.fetch)
  const url = 'https://opencode.ai/zen/v1/chat/completions'

  await runInSession('session-1', async () => { await patched(url, { headers: { authorization: 'Bearer x' } }) })
  assert.equal(headerOf(recorded.calls[0], DEFAULT_HEADER), 'session-1')
  assert.equal(headerOf(recorded.calls[0], 'authorization'), 'Bearer x', 'existing headers survive')

  await patched(url, {})
  assert.equal(headerOf(recorded.calls[1], DEFAULT_HEADER), null, 'no session, no header')

  await runInSession('session-2', async () => { await patched('https://api.deepseek.com/v1/chat/completions', {}) })
  assert.equal(headerOf(recorded.calls[2], DEFAULT_HEADER), null, 'another provider is untouched')

  await runInSession('session-3', async () => { await patched('https://OPENCODE.AI/zen', {}) })
  assert.equal(headerOf(recorded.calls[3], DEFAULT_HEADER), 'session-3', 'the marker match ignores case')
})

test('a custom header and marker replace the defaults', async () => {
  const recorded = recordingFetch()
  const patched = wrapFetch(recorded.fetch, { header: 'x-custom', markers: ['gateway.example'] })
  await runInSession('session-9', async () => { await patched('https://gateway.example/v1', {}) })
  assert.equal(headerOf(recorded.calls[0], 'x-custom'), 'session-9')
  assert.equal(headerOf(recorded.calls[0], DEFAULT_HEADER), null)

  await runInSession('session-9', async () => { await patched('https://opencode.ai/v1', {}) })
  assert.equal(headerOf(recorded.calls[1], 'x-custom'), null, 'the default marker no longer matches')
})

test('a Request keeps its own headers', async () => {
  const recorded = recordingFetch()
  const patched = wrapFetch(recorded.fetch)
  const request = new Request('https://opencode.ai/v1/models', { headers: { 'x-api-key': 'k' } })
  await runInSession('session-4', async () => { await patched(request) })
  assert.equal(headerOf(recorded.calls[0], DEFAULT_HEADER), 'session-4')
  assert.equal(headerOf(recorded.calls[0], 'x-api-key'), 'k')
})

test('normalizeConfig applies the gateway defaults and rejects what it cannot honour', () => {
  assert.deepEqual(normalizeConfig(undefined), { header: 'x-opencode-session', markers: ['opencode.ai'] })
  assert.deepEqual(normalizeConfig({ header: ' x-h ', urlMarkers: ['Gateway.EXAMPLE'] }), {
    header: 'x-h',
    markers: ['gateway.example'],
  })
  assert.throws(() => normalizeConfig({ header: 'bad\nheader' }), /must be one non-empty line/)
  assert.throws(() => normalizeConfig({ header: '' }), /must be one non-empty line/)
  assert.throws(() => normalizeConfig({ urlMarkers: [] }), /non-empty array/)
  assert.throws(() => normalizeConfig({ urlMarkers: [''] }), /non-empty string/)
  assert.throws(() => normalizeConfig({ urlMarkers: 'opencode.ai' }), /non-empty array/)
})

test('withSession carries the id through next/return/throw', async () => {
  const seen: (string | undefined)[] = []
  const inner = (async function* generate() {
    seen.push(undefined)
    yield 1
    yield 2
  })()
  const wrapped = withSession(inner, 'abc')
  const iterator = wrapped[Symbol.asyncIterator]()
  assert.deepEqual(await iterator.next(), { done: false, value: 1 })
  assert.equal(typeof iterator.return, 'function')

  // Every step runs under the session id, which is what the fetch patch reads.
  await runInSession('abc', async () => {
    const second = await iterator.next()
    assert.deepEqual(second, { done: false, value: 2 })
  })
})
