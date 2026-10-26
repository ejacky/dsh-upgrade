/**
 * Strict semantic versioning for release tags.
 *
 * The tool only ever moves forward: `check` compares the newest upstream tag with the
 * deployed one and reports a candidate only when it is *strictly* newer. Pre-releases order
 * before their release (`0.2.1-rc.3` < `0.2.1`), identifiers compare numerically when both
 * are numeric, and a shorter identifier list orders first (semver §11).
 *
 * @module dsh-upgrade/engine/semver
 */

/** A parsed version, including the tag it came from. */
export interface Version {
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly prerelease: readonly (string | number)[]
  /** The full tag, for messages and records. */
  readonly tag: string
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * Extract the version part of a tag such as `dsh-v0.2.1-rc.3`.
 * @param tag - the release tag.
 * @param tagPattern - glob applied to tags, e.g. `dsh-v*`; pass `undefined` to accept any tag.
 * @returns the parsed version, or `undefined` when the tag does not match or does not carry one.
 */
export function parseTag(tag: string, tagPattern?: string): Version | undefined {
  if (tagPattern !== undefined && !globMatches(tagPattern, tag)) return undefined
  const candidate = tagPattern === undefined ? tag : tag.slice(tagPattern.indexOf('*') === -1 ? 0 : tagPattern.indexOf('*'))
  const match = SEMVER.exec(candidate)
  if (match === null) return undefined
  const [, major, minor, patch, prerelease] = match
  if (major === undefined || minor === undefined || patch === undefined) return undefined
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease === undefined ? [] : prerelease.split('.').map(identifier =>
      /^\d+$/.test(identifier) ? Number(identifier) : identifier),
    tag,
  }
}

/**
 * Compare two versions.
 * @returns negative when `a` is older, positive when newer, `0` when equal.
 */
export function compareVersions(a: Version, b: Version): number {
  const core = a.major - b.major || a.minor - b.minor || a.patch - b.patch
  if (core !== 0) return core
  // A version without a pre-release outranks one with it.
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  const shared = Math.min(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < shared; index += 1) {
    const left = a.prerelease[index]
    const right = b.prerelease[index]
    if (left === undefined || right === undefined) break
    if (left === right) continue
    const leftNumeric = typeof left === 'number'
    const rightNumeric = typeof right === 'number'
    if (leftNumeric && rightNumeric) return left - right
    // Numeric identifiers always rank below alphanumeric ones.
    if (leftNumeric) return -1
    if (rightNumeric) return 1
    return left < right ? -1 : 1
  }
  return a.prerelease.length - b.prerelease.length
}

/**
 * Pick the newest tag among matching tags.
 * @param tags - candidate tags.
 * @param tagPattern - glob applied to tags.
 * @returns the newest parsed version, or `undefined` when none match.
 */
export function newestTag(tags: readonly string[], tagPattern: string): Version | undefined {
  let best: Version | undefined
  for (const tag of tags) {
    const parsed = parseTag(tag, tagPattern)
    if (parsed === undefined) continue
    if (best === undefined || compareVersions(parsed, best) > 0) best = parsed
  }
  return best
}

/**
 * Minimal glob for the configured tag pattern: `*` matches any run of characters.
 * @param pattern - glob with `*` wildcards.
 * @param value - the tag to test.
 */
export function globMatches(pattern: string, value: string): boolean {
  const source = pattern
    .split('*')
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${source}$`).test(value)
}
