/**
 * Configuration and state persistence: validation, derived paths, and atomic writes.
 * @module dsh-upgrade/tests/engine
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { defaultConfig, loadConfig, parseConfig, saveConfig } from '../src/engine/config.ts'
import { emptyState, readState, statePathOf, withDeployed, writeState } from '../src/engine/state.ts'

/** Throwaway directory for one test. */
function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-upgrade-'))
}

test('defaults derive the stable path and slots from root', () => {
  const config = defaultConfig({ root: 'C:\\dsh' })
  assert.equal(config.stablePath, resolve('C:\\dsh', 'deepseek-harness'))
  assert.equal(config.slotsRoot, resolve('C:\\dsh', 'dsh-slots'))
  assert.equal(config.tagPattern, 'dsh-v*')
  assert.equal(config.webPort, 3080)
  assert.deepEqual(config.patchFiles, [])
})

test('parseConfig validates ports and patch lists', () => {
  const dir = scratch()
  const ok = parseConfig({ root: dir, webPort: 4000, patchFiles: ['a.patch'] }, dir)
  assert.equal(ok.webPort, 4000)
  assert.deepEqual(ok.patchFiles, ['a.patch'])

  assert.throws(() => parseConfig({ root: dir, webPort: 70000 }, dir), /port/)
  assert.throws(() => parseConfig({ root: dir, patchFiles: [1] }, dir), /array of strings/)
  assert.throws(() => parseConfig({ root: '' }, dir), /root/)
  assert.throws(() => parseConfig({ root: dir, schema: 2 }, dir), /schema/)
})

test('a configuration written for the retired plugin still loads', () => {
  const dir = scratch()
  const path = join(dir, 'dsh-upgrade.json')
  writeFileSync(path, `${JSON.stringify({
    schema: 1,
    root: dir,
    profile: 'web',
    opencodeSession: { enabled: false, source: 'npm', header: 'x-custom', urlMarkers: ['example.test'] },
  }, null, 2)}\n`, 'utf8')
  const parsed = loadConfig(path)
  assert.equal(parsed.webPort, 3080, 'an old key is ignored, not rejected')
  assert.equal('opencodeSession' in parsed, false, 'the retired key must not come back')
  assert.equal('profile' in parsed, false, 'the profile field no longer exists')
  const defaults = defaultConfig({ root: dir })
  assert.equal('opencodeSession' in defaults, false)
  assert.equal('profile' in defaults, false)
})

test('a saved configuration loads back unchanged', () => {
  const dir = scratch()
  const path = join(dir, 'dsh-upgrade.json')
  const config = defaultConfig({ root: dir, upstream: 'https://example.invalid/repo.git', manualBuild: true })
  saveConfig(path, config)
  const loaded = loadConfig(path)
  assert.deepEqual(loaded, config)
})

test('a missing configuration is a clear error', () => {
  assert.throws(() => loadConfig(join(scratch(), 'absent.json')), /run "dsh-upgrade init"/)
})

test('state round-trips and records switches newest first', () => {
  const dir = scratch()
  const path = join(dir, 'state.json')
  const base = emptyState()
  const first = withDeployed(base, { tag: 'dsh-v0.2.1-rc.2', slot: 'a', at: '2026-10-19T00:00:00.000Z' })
  writeState(path, first)
  assert.deepEqual(readState(path), first)

  const second = withDeployed(readState(path), { tag: 'dsh-v0.2.1-rc.3', slot: 'b', at: '2026-10-20T00:00:00.000Z' })
  assert.equal(second.deployed?.tag, 'dsh-v0.2.1-rc.3')
  assert.equal(second.staged, null)
  assert.deepEqual(second.history.map(record => record.tag), ['dsh-v0.2.1-rc.3', 'dsh-v0.2.1-rc.2'])
})

test('state writes leave no temporary file behind', () => {
  const dir = scratch()
  const path = join(dir, 'state.json')
  writeState(path, emptyState())
  assert.deepEqual(readdirSync(dir), ['state.json'])
})

test('reading an absent state file yields the empty state', () => {
  assert.deepEqual(readState(join(scratch(), 'state.json')), emptyState())
})

test('statePathOf stays inside the configured root', () => {
  const dir = scratch()
  assert.equal(statePathOf(defaultConfig({ root: dir })), join(dir, 'state', 'upgrade-state.json'))
})

test('a corrupt state file fails loudly instead of being ignored', () => {
  const dir = scratch()
  const path = join(dir, 'state.json')
  writeFileSync(path, '{"schema":1,"deployed":{"tag":"x","slot":"c","at":"now"}}', 'utf8')
  assert.throws(() => readState(path), /slot must be "a" or "b"/)
  assert.ok(existsSync(path))
  assert.match(readFileSync(path, 'utf8'), /"slot":"c"/)
})
