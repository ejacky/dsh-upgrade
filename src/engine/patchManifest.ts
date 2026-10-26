/**
 * The patch catalog shipped beside the tool.
 *
 * The catalog records what a patch fixes, which upstream tags it was verified against, and
 * when it became unnecessary. It is documentation plus a lookup table, never the active set:
 * what staging applies is always `patchFiles` in `dsh-upgrade.json`, and `patch add` is the
 * only writer that copies a catalog entry into it.
 *
 * Entry paths are relative to the tool root — the same base `patchFiles` uses — so one patch
 * has one spelling in the catalog, in the configuration, and in the log. A catalog may also
 * name an absolute path; it is stored exactly as written.
 *
 * @module dsh-upgrade/engine/patchManifest
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Catalog location under the tool root. */
export const MANIFEST_RELATIVE_PATH = 'patches/manifest.json'

/** One catalogued source patch. */
export interface PatchEntry {
  /** Stable identifier used by `patch add` and `patch remove`. */
  readonly name: string
  /** Patch file relative to the tool root. */
  readonly file: string
  /** One line describing the behaviour the patch restores. */
  readonly summary: string
  /** Upstream issue or pull request this patch stands in for, when known. */
  readonly upstreamIssue?: string
  /** Tags the patch was last verified against. */
  readonly verifiedTags: readonly string[]
  /** Upstream release that made the patch unnecessary; empty means still needed. */
  readonly obsoleteSince?: string
}

/** Parsed catalog file. */
export interface PatchManifest {
  /** Metadata revision of the file. */
  readonly schema: 1
  /** Catalogued patches, in file order. */
  readonly patches: readonly PatchEntry[]
}

/** A catalog with no entries; also the fallback when the file is absent. */
export const EMPTY_MANIFEST: PatchManifest = { schema: 1, patches: [] }

/** A loaded catalog and where it came from. */
export interface LoadedManifest {
  /** The parsed catalog. */
  readonly manifest: PatchManifest
  /** Absolute path of the file that was read. */
  readonly path: string
  /** `false` when the file does not exist and {@link EMPTY_MANIFEST} was substituted. */
  readonly present: boolean
}

/**
 * Absolute path of the catalog under a tool root.
 * @param toolRoot - the tool's own directory.
 */
export function defaultManifestPath(toolRoot: string): string {
  return join(toolRoot, ...MANIFEST_RELATIVE_PATH.split('/'))
}

/**
 * Spell a patch path the way the configuration and the catalog store it.
 * @param path - a path with either separator style.
 * @returns the path with forward slashes.
 */
export function normalizePatchFile(path: string): string {
  return path.trim().replaceAll('\\', '/')
}

/**
 * Whether two patch paths name the same file, tolerating separator and letter case.
 * @param left - first patch path.
 * @param right - second patch path.
 */
export function samePatchFile(left: string, right: string): boolean {
  const normalized = normalizePatchFile(left).toLowerCase()
  return normalized === normalizePatchFile(right).toLowerCase()
}

/**
 * Read the text field at `field`, rejecting an empty or non-string value.
 * @param value - candidate value.
 * @param field - field name for the error message.
 */
function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`patch manifest: "${field}" must be a non-empty string`)
  }
  return value.trim()
}

/**
 * Read an optional text field.
 * @param value - candidate value.
 * @param field - field name for the error message.
 */
function optionalText(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : text(value, field)
}

/**
 * Read an optional list of non-empty strings.
 * @param value - candidate value.
 * @param field - field name for the error message.
 */
function textList(value: unknown, field: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`patch manifest: "${field}" must be an array of non-empty strings`)
  }
  return value.map(item => (item as string).trim())
}

/**
 * Validate a parsed JSON object into a {@link PatchManifest}.
 * @param raw - parsed JSON.
 */
export function parseManifest(raw: unknown): PatchManifest {
  if (typeof raw !== 'object' || raw === null) throw new Error('patch manifest: expected a JSON object')
  const record = raw as Record<string, unknown>
  const schema = record['schema']
  if (schema !== undefined && schema !== 1) throw new Error('patch manifest: unsupported "schema" (expected 1)')
  const list = record['patches']
  if (list === undefined) return EMPTY_MANIFEST
  if (!Array.isArray(list)) throw new Error('patch manifest: "patches" must be an array')
  const patches: PatchEntry[] = []
  for (const [index, item] of list.entries()) {
    if (typeof item !== 'object' || item === null) throw new Error(`patch manifest: "patches[${index}]" must be an object`)
    const entry = item as Record<string, unknown>
    const name = text(entry['name'], `patches[${index}].name`)
    if (patches.some(seen => seen.name === name)) throw new Error(`patch manifest: duplicate patch name "${name}"`)
    const issue = optionalText(entry['upstreamIssue'], `patches[${index}].upstreamIssue`)
    const obsoleteSince = optionalText(entry['obsoleteSince'], `patches[${index}].obsoleteSince`)
    patches.push({
      name,
      file: text(entry['file'], `patches[${index}].file`),
      summary: text(entry['summary'], `patches[${index}].summary`),
      ...issue === undefined ? {} : { upstreamIssue: issue },
      verifiedTags: textList(entry['verifiedTags'], `patches[${index}].verifiedTags`),
      ...obsoleteSince === undefined ? {} : { obsoleteSince },
    })
  }
  return { schema: 1, patches }
}

/**
 * Read a catalog file.
 *
 * A missing file is not an error: the tool then knows no catalogued patches while configured
 * `patchFiles` still apply. A malformed file is an error, because silently ignoring it would
 * hide a patch that the operator believes is maintained.
 *
 * @param path - absolute path of the catalog.
 * @returns the catalog and whether the file was present.
 */
export function loadManifest(path: string): LoadedManifest {
  if (!existsSync(path)) return { manifest: EMPTY_MANIFEST, path, present: false }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`patch manifest: ${path} is not valid JSON (${(error as Error).message})`)
  }
  return { manifest: parseManifest(raw), path, present: true }
}

/**
 * Look up a catalog entry by name, then by patch path.
 * @param manifest - the catalog to search.
 * @param query - a patch name or a patch file path.
 */
export function findEntry(manifest: PatchManifest, query: string): PatchEntry | undefined {
  const byName = manifest.patches.find(entry => entry.name === query)
  if (byName !== undefined) return byName
  return manifest.patches.find(entry => samePatchFile(entry.file, query))
}
