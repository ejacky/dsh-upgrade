/**
 * Types for the vendored plugin's entry point.
 *
 * The implementation is plain JavaScript so the profile can load it without a build step; these
 * declarations describe the surface this tool's tests import and nothing more.
 */

/** Row config, as `x-opencode-session: { ... }` in a profile patch. */
export interface Config {
  /** Request header to set; defaults to `x-opencode-session`. */
  readonly header?: string
  /** URL substrings (matched case-insensitively); defaults to `['opencode.ai']`. */
  readonly urlMarkers?: readonly string[]
}

/** Validated settings. */
export interface Settings {
  /** Header name. */
  readonly header: string
  /** Lower-cased URL markers. */
  readonly markers: readonly string[]
}

/** Row id. */
export declare const name: 'x-opencode-session'
/** Default header name. */
export declare const DEFAULT_HEADER: string
/** Default URL markers. */
export declare const DEFAULT_MARKERS: readonly string[]

/**
 * Validate the row's config.
 * @param config - the row's `config`, or `undefined`.
 * @returns the header and lower-cased markers.
 */
export declare function normalizeConfig(config: unknown): Settings

/**
 * Run a function inside a session context.
 * @param sessionId - the conversation id.
 * @param fn - the work to run.
 */
export declare function runInSession<T>(sessionId: string, fn: () => T): T

/**
 * Wrap a model stream so every step runs in the session context.
 * @param iterable - the downstream stream.
 * @param sessionId - the conversation id.
 */
export declare function withSession<T>(iterable: AsyncIterable<T>, sessionId: string): AsyncIterable<T>

/**
 * Build a fetch that adds the header for matching URLs inside a session.
 * @param realFetch - the fetch being wrapped.
 * @param options - header and marker overrides.
 */
export declare function wrapFetch(
  realFetch: typeof fetch,
  options?: { readonly header?: string, readonly markers?: readonly string[] },
): typeof fetch

/** Install the process-wide fetch patch. */
export declare function installFetchShim(): boolean

/** Restore the fetch that was replaced. */
export declare function restoreFetchShim(): boolean

/**
 * The `llm/stream` listener.
 * @param options - GenerateOptions, read for `sessionId`.
 * @param next - the downstream waterfall.
 */
export declare function llmStreamListener(
  options: { readonly sessionId?: string },
  next: () => AsyncIterable<unknown>,
): AsyncIterable<unknown>

/**
 * Plugin entry.
 * @param ctx - host plugin context.
 * @param config - the row's config.
 */
export declare function apply(
  ctx: {
    readonly logger?: { info?: (message: string) => void, warn?: (message: string) => void, debug?: (message: string) => void }
    effect: (body: () => () => void, label?: string) => void
    on: (event: string, listener: unknown, options?: { global?: boolean, prepend?: boolean }) => void
  },
  config?: Config,
): void
