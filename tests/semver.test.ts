/**
 * Version-ordering behaviour the upgrade decision depends on.
 * @module dsh-upgrade/tests/semver
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareVersions, globMatches, newestTag, parseTag } from '../src/engine/semver.ts'

/** Parse a tag or fail the test. */
function version(tag: string, pattern = 'dsh-v*') {
  const parsed = parseTag(tag, pattern)
  assert.notEqual(parsed, undefined, `expected ${tag} to parse`)
  assert.ok(parsed !== undefined)
  return parsed
}

test('parses release and pre-release tags behind the pattern', () => {
  const rc = version('dsh-v0.2.1-rc.3')
  assert.equal(rc.major, 0)
  assert.equal(rc.minor, 2)
  assert.equal(rc.patch, 1)
  assert.deepEqual(rc.prerelease, ['rc', 3])
  assert.deepEqual(version('dsh-v1.0.0').prerelease, [])
})

test('rejects tags outside the pattern or without a version', () => {
  assert.equal(parseTag('v0.2.1-rc.3', 'dsh-v*'), undefined)
  assert.equal(parseTag('dsh-vlatest', 'dsh-v*'), undefined)
  assert.equal(parseTag('dsh-v1.2', 'dsh-v*'), undefined)
})

test('orders core versions numerically', () => {
  assert.ok(compareVersions(version('dsh-v0.2.1'), version('dsh-v0.2.0')) > 0)
  assert.ok(compareVersions(version('dsh-v0.10.0'), version('dsh-v0.9.9')) > 0)
  assert.equal(compareVersions(version('dsh-v0.2.1'), version('dsh-v0.2.1')), 0)
})

test('a release outranks its pre-releases', () => {
  assert.ok(compareVersions(version('dsh-v0.2.1'), version('dsh-v0.2.1-rc.9')) > 0)
  assert.ok(compareVersions(version('dsh-v0.2.1-rc.3'), version('dsh-v0.2.1-alpha.2')) > 0)
  assert.ok(compareVersions(version('dsh-v0.2.1-rc.10'), version('dsh-v0.2.1-rc.9')) > 0)
})

test('picks the newest matching tag', () => {
  const tags = ['dsh-v0.2.1-alpha.2', 'dsh-v0.2.1-rc.2', 'dsh-v0.2.1-rc.3', 'other-v9.9.9', 'dsh-v0.2.0']
  assert.equal(newestTag(tags, 'dsh-v*')?.tag, 'dsh-v0.2.1-rc.3')
  assert.equal(newestTag(['other-v9.9.9'], 'dsh-v*'), undefined)
})

test('never proposes a downgrade or an equal version', () => {
  const current = version('dsh-v0.2.1-rc.3')
  const newest = newestTag(['dsh-v0.2.1-rc.3', 'dsh-v0.2.1-rc.2'], 'dsh-v*')
  assert.ok(newest !== undefined)
  assert.equal(compareVersions(newest, current), 0)
})

test('glob matching is anchored', () => {
  assert.ok(globMatches('dsh-v*', 'dsh-v0.2.1-rc.3'))
  assert.ok(!globMatches('dsh-v*', 'xdsh-v0.2.1'))
  assert.ok(globMatches('dsh-*-rc.*', 'dsh-v0.2.1-rc.3'))
})
