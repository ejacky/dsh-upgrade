/**
 * End-to-end behaviour of `init`, `status`, and `check` against a throwaway repository.
 *
 * The repository is real (git, tags, a slot checkout) because the point of these commands
 * is what they conclude from on-disk facts, not how they parse strings.
 *
 * @module dsh-upgrade/tests/check
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const repoRoot = join(import.meta.dirname, '..')
const cliPath = join(repoRoot, 'src', 'cli.ts')

/** Run the CLI in a directory. */
function run(args: readonly string[], cwd: string): { status: number, stdout: string, stderr: string } {
  const result = spawnSync(process.execPath, [cliPath, ...args], { cwd, encoding: 'utf8' })
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`)
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr }
}

/** Run git, failing the test on error. */
function git(args: readonly string[], cwd: string): void {
  const result = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@localhost', ...args], {
    cwd, encoding: 'utf8',
  })
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`)
}

/** A scratch root with an initialized tool configuration and a slot repository. */
function fixture(): { root: string, slot: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-upgrade-e2e-'))
  const slot = join(root, 'dsh-slots', 'a')
  mkdirSync(slot, { recursive: true })
  git(['init', '-b', 'main'], slot)
  writeFileSync(join(slot, 'README.md'), '# fixture\n', 'utf8')
  git(['add', '.'], slot)
  git(['commit', '-m', 'initial'], slot)
  for (const tag of ['dsh-v0.2.0', 'dsh-v0.2.1-rc.2']) git(['tag', tag], slot)
  const init = run(['init', '--root', root, '--upstream', slot, '--json'], root)
  assert.equal(init.status, 0, init.stderr)
  return { root, slot }
}

test('init writes a configuration whose paths derive from root', () => {
  const { root } = fixture()
  const configPath = join(root, 'dsh-upgrade.json')
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as { stablePath: string, slotsRoot: string }
  assert.equal(config.stablePath, join(root, 'deepseek-harness'))
  assert.equal(config.slotsRoot, join(root, 'dsh-slots'))
})


test('init refuses to overwrite an existing configuration', () => {
  const { root } = fixture()
  const again = run(['init', '--root', root], root)
  assert.equal(again.status, 2)
  assert.match(again.stderr, /already exists/)
  const forced = run(['init', '--root', root, '--force'], root)
  assert.equal(forced.status, 0)
})

test('check reports the newest tag and proposes it when nothing is deployed', () => {
  const { root } = fixture()
  const result = run(['check', '--no-fetch', '--json'], root)
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout) as { ok: boolean, current: string | null, latest: string | null, newer: boolean, candidate: string | null }
  assert.equal(report.ok, true)
  assert.equal(report.current, null)
  assert.equal(report.latest, 'dsh-v0.2.1-rc.2')
  assert.equal(report.newer, true)
  assert.equal(report.candidate, 'dsh-v0.2.1-rc.2')
})

test('check fetches new tags from the configured upstream', () => {
  const { root, slot } = fixture()
  git(['tag', 'dsh-v0.2.1-rc.3'], slot)
  const result = run(['check', '--json'], root)
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout) as { latest: string | null }
  assert.equal(report.latest, 'dsh-v0.2.1-rc.3')
})

test('check never proposes an older or equal version, and records the check time', () => {
  const { root } = fixture()
  const statePath = join(root, 'state', 'upgrade-state.json')
  writeStateFile(statePath, {
    schema: 1,
    deployed: { tag: 'dsh-v0.2.1-rc.2', slot: 'a', at: '2026-10-19T00:00:00.000Z' },
    staged: null,
    lastCheck: null,
    lastError: null,
    history: [],
  })
  const result = run(['check', '--no-fetch', '--json'], root)
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout) as { newer: boolean, candidate: string | null, current: string | null }
  assert.equal(report.current, 'dsh-v0.2.1-rc.2')
  assert.equal(report.newer, false)
  assert.equal(report.candidate, null)
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as { lastCheck: string | null }
  assert.notEqual(state.lastCheck, null)
})

/** Write a state file the tool can read. */
function writeStateFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

test('status reports the deployed and staged records', () => {
  const { root } = fixture()
  const statePath = join(root, 'state', 'upgrade-state.json')
  writeStateFile(statePath, {
    schema: 1,
    deployed: { tag: 'dsh-v0.2.1-rc.2', slot: 'a', at: '2026-10-19T00:00:00.000Z' },
    staged: { tag: 'dsh-v0.2.1-rc.3', slot: 'b', at: '2026-10-20T00:00:00.000Z' },
    lastCheck: '2026-10-20T00:00:00.000Z',
    lastError: null,
    history: [],
  })
  const result = run(['status', '--json'], root)
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout) as { deployed: { tag: string }, staged: { tag: string }, slots: unknown[] }
  assert.equal(report.deployed.tag, 'dsh-v0.2.1-rc.2')
  assert.equal(report.staged.tag, 'dsh-v0.2.1-rc.3')
  assert.equal(report.slots.length, 2)
})

test('check without any slot checkout asks for stage', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-upgrade-empty-'))
  const init = run(['init', '--root', root, '--json'], root)
  assert.equal(init.status, 0, init.stderr)
  const result = run(['check', '--no-fetch', '--json'], root)
  assert.equal(result.status, 4)
  const report = JSON.parse(result.stdout) as { ok: boolean, nextAction: string }
  assert.equal(report.ok, false)
  assert.equal(report.nextAction, 'stage')
})

