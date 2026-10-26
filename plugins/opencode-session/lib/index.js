/**
 * x-opencode-session — a vendored copy of `dsh-x-opencode-session` 0.1.0.
 *
 * Vendored (not depended on) so a green-zip install works offline and so the row's config can
 * be validated here instead of silently ignored. The behaviour is the upstream plugin's: a
 * model request whose URL contains `opencode.ai` carries the conversation's own session id in
 * the `x-opencode-session` header. Local changes are listed in NOTICE.
 *
 * The value is the id the agent loop already puts in every model request
 * (`options.sessionId`), so it is stable within a conversation, different between
 * conversations, and unchanged by a restart or a network drop. This plugin keeps no ids and
 * no map of its own.
 *
 * Two host-side layers, because the request is sent by the llm-pi-ai adapter through the
 * openai SDK inside this process:
 *  1. an `llm/stream` waterfall listener wraps each request's iteration in an
 *     AsyncLocalStorage context carrying its session id;
 *  2. a one-time `globalThis.fetch` patch (installed idempotently, restored on dispose) adds
 *     the header, but only when the URL matches a marker and a session id is in context.
 *     Side-channel requests (usage queries, model discovery, web tools) are untouched.
 *
 * The openai SDK reads the global fetch when it is constructed for each request, so the patch
 * covers it and survives a reload.
 *
 * @module dsh-x-opencode-session
 */
import { AsyncLocalStorage } from 'node:async_hooks'

/** Row id the profile patch targets. */
export const name = 'x-opencode-session'

/** Header name used when the row carries no config. */
export const DEFAULT_HEADER = 'x-opencode-session'

/** URL substrings used when the row carries no config. */
export const DEFAULT_MARKERS = ['opencode.ai']

/**
 * Validate the row's config, failing loud on a value the plugin cannot honour.
 *
 * The row is written by `dsh-upgrade opencode-session install`; a typo there would otherwise
 * turn into a silently missing header.
 * @param config - the row's `config`, or `undefined`.
 * @returns the header plus lower-cased URL markers.
 * @throws when a field has the wrong type or an empty value.
 */
export function normalizeConfig(config) {
  const header = config?.header ?? DEFAULT_HEADER
  if (typeof header !== 'string' || header.trim() === '' || /[\r\n]/.test(header)) {
    throw new Error(`${name}: "header" must be one non-empty line`)
  }
  const markers = config?.urlMarkers ?? DEFAULT_MARKERS
  if (!Array.isArray(markers) || markers.length === 0) {
    throw new Error(`${name}: "urlMarkers" must be a non-empty array`)
  }
  for (const marker of markers) {
    if (typeof marker !== 'string' || marker.trim() === '') {
      throw new Error(`${name}: every "urlMarkers" entry must be a non-empty string`)
    }
  }
  return { header: header.trim(), markers: markers.map(marker => marker.trim().toLowerCase()) }
}

/** One session context per model stream; written by the listener, read by the fetch patch. */
const sessionAls = new AsyncLocalStorage()

/** Logger captured at install time; silent when the host has none. */
let logSink = null
const log = (level, message) => {
  try {
    logSink?.[level]?.(message)
  } catch {
    // A broken logger must not break the request path.
  }
}

/** Process-wide fetch patch state. */
let installed = false
let originalFetch = null
let shimmedFetch = null
let settings = { header: DEFAULT_HEADER, markers: DEFAULT_MARKERS.map(marker => marker.toLowerCase()) }

/**
 * Run a function inside a session context.
 * @param sessionId - the conversation id.
 * @param fn - the work to run.
 * @returns whatever `fn` returns.
 */
export function runInSession(sessionId, fn) {
  return sessionAls.run(String(sessionId), fn)
}

/**
 * Wrap a model stream so every iteration runs in the session context.
 * @param iterable - the downstream `llm/stream` result.
 * @param sessionId - the conversation id from the request.
 * @returns an async iterable whose steps carry the session id.
 */
export function withSession(iterable, sessionId) {
  const id = String(sessionId)
  const inner = iterable[Symbol.asyncIterator]()
  const step = (method, value) => runInSession(id, () => {
    const fn = inner[method]
    return typeof fn === 'function' ? fn.call(inner, value) : Promise.resolve({ done: true })
  })
  return {
    next: () => step('next'),
    return: value => step('return', value),
    throw: error => step('throw', error),
    [Symbol.asyncIterator]() {
      return this
    },
  }
}

/**
 * The URL a fetch call targets, when it can be determined.
 * @param input - fetch's first argument.
 * @returns the URL string, or `undefined` when the input is not inspectable.
 */
function requestUrlOf(input) {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  if (input !== null && typeof input === 'object' && typeof input.url === 'string') return input.url
  return undefined
}

/**
 * Merge headers without dropping the ones a `Request` already carries.
 * @param input - fetch's first argument.
 * @param init - fetch's second argument.
 * @returns the merged headers and the init to pass on.
 */
function buildInit(input, init) {
  const merged = input !== null && typeof input === 'object' && input.headers instanceof Headers
    ? new Headers(input.headers)
    : new Headers(init?.headers)
  return { merged, effectiveInit: init === undefined ? { headers: merged } : { ...init, headers: merged } }
}

/**
 * Build the fetch patch. Pure, so the header decision can be tested without a server.
 * @param realFetch - the fetch being wrapped.
 * @param options - `header` and `markers`, defaulting to this gateway's values.
 * @returns a fetch that adds the header only for matching URLs inside a session.
 */
export function wrapFetch(realFetch, options = {}) {
  const header = options.header ?? DEFAULT_HEADER
  const markers = (options.markers ?? DEFAULT_MARKERS).map(marker => marker.toLowerCase())
  const passthrough = (...args) => realFetch(...args)
  return function opencodeSessionFetch(input, init) {
    const sessionId = sessionAls.getStore()
    if (sessionId === undefined) return passthrough(input, init)
    const url = requestUrlOf(input)
    if (url === undefined || !markers.some(marker => url.toLowerCase().includes(marker))) return passthrough(input, init)
    try {
      const { merged, effectiveInit } = buildInit(input, init)
      merged.set(header, sessionId)
      log('debug', `[${name}] ${header}: ${sessionId} -> ${url}`)
      return realFetch(input, effectiveInit)
    } catch (error) {
      log('warn', `[${name}] could not set ${header}: ${error?.message ?? error}`)
      return passthrough(input, init)
    }
  }
}

/**
 * Install the fetch patch once per process.
 * @returns whether this call installed it.
 */
export function installFetchShim() {
  if (installed) return false
  if (typeof globalThis.fetch !== 'function') {
    log('warn', `[${name}] no global fetch; the header cannot be added`)
    return false
  }
  originalFetch = globalThis.fetch
  shimmedFetch = wrapFetch(originalFetch, settings)
  globalThis.fetch = shimmedFetch
  installed = true
  log('info', `[${name}] ${settings.header} is sent on requests to ${settings.markers.join(', ')}`)
  return true
}

/**
 * Restore the fetch that was replaced, unless someone else replaced it since.
 * @returns whether this call restored it.
 */
export function restoreFetchShim() {
  if (!installed) return false
  if (globalThis.fetch === shimmedFetch) globalThis.fetch = originalFetch
  installed = false
  originalFetch = null
  shimmedFetch = null
  return true
}

/**
 * The `llm/stream` listener: wrap requests that carry a session id, pass the rest through.
 * @param options - GenerateOptions.
 * @param next - the downstream waterfall; must be called when this listener does not wrap.
 * @returns the stream to consume.
 */
export function llmStreamListener(options, next) {
  const sessionId = options?.sessionId
  if (sessionId === undefined || sessionId === '') return next()
  return withSession(next(), sessionId)
}

/**
 * Plugin entry.
 * @param ctx - host plugin context.
 * @param config - the row's config.
 */
export function apply(ctx, config) {
  settings = normalizeConfig(config)
  // The patch and the listener share the plugin's lifetime: unloading restores fetch.
  ctx.effect(() => {
    logSink = ctx.logger
    installFetchShim()
    return () => {
      restoreFetchShim()
      logSink = null
    }
  }, `${name}: fetch shim lifecycle`)

  ctx.on('llm/stream', llmStreamListener, { global: true, prepend: true })
}
