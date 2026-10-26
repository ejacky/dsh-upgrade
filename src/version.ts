/**
 * Reads the tool's own version metadata, shipped as `version.json` beside the sources.
 *
 * `version.json` is the single source of truth for `dsh-upgrade --version` and for the
 * self-update check that compares the running tool against a published release listing.
 *
 * @module dsh-upgrade/version
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Parsed contents of `version.json`. */
export interface ToolVersion {
  /** Package name, for messages and release listings. */
  readonly name: string
  /** Semantic version of this build. */
  readonly version: string
  /** Metadata schema revision; bump when the shape below changes. */
  readonly schema: number
  /** ISO timestamp of the packaging run, or `null` for a source checkout. */
  readonly builtAt: string | null
}

/**
 * Read and validate `version.json`.
 * @param sourceDir - directory holding the sources; the file lives one level above it.
 * @returns the validated version metadata.
 * @throws when the file is missing or does not carry the required string fields.
 */
export function readToolVersion(sourceDir: string): ToolVersion {
  const path = join(sourceDir, '..', 'version.json')
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof raw !== 'object' || raw === null) throw new Error(`${path}: expected a JSON object`)
  const record = raw as Record<string, unknown>
  const name = record['name']
  const version = record['version']
  const schema = record['schema']
  const builtAt = record['builtAt']
  if (typeof name !== 'string' || name === '') throw new Error(`${path}: "name" must be a non-empty string`)
  if (typeof version !== 'string' || version === '') throw new Error(`${path}: "version" must be a non-empty string`)
  if (typeof schema !== 'number') throw new Error(`${path}: "schema" must be a number`)
  if (builtAt !== null && typeof builtAt !== 'string') throw new Error(`${path}: "builtAt" must be a string or null`)
  return { name, version, schema, builtAt }
}
