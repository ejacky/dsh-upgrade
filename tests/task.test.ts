/**
 * `task`: the watcher registration, its status, and one pass.
 *
 * Nothing here touches the real Task Scheduler unless a test asks for it: `install --dry-run`
 * returns the wrapper and the registration script, which is what can be checked offline.
 * The one watcher pass runs the real `check` so its decision is the decision the tool makes.
 *
 * @module dsh-upgrade/tests/task
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LAUNCHERS, launcherFiles } from '../src/commands/power.ts'
import { cliEntryPath } from '../src/engine/entry.ts'

const repoRoot = join(import.meta.dirname, '..')
const cliPath = join(repoRoot, 'src', 'cli.ts')

/** Run the CLI and capture its streams and exit code. */
function run(args: readonly string[], cwd: string, env: Record<string, string> = {}): { status: number, stdout: string, stderr: string } {
  const result = spawnSync(process.execPath, [cliPath, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } })
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`)
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr }
}

/** Run git, failing the test on error. */
function git(args: readonly string[], cwd: string): void {
  const result = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@localhost', ...args], { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`)
}

/** A layout with one tag, one slot at that tag, and a configuration. */
function fixture(): { root: string, origin: string, slot: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-upgrade-task-'))
  const origin = join(root, 'origin')
  mkdirSync(origin, { recursive: true })
  git(['init', '-b', 'main'], origin)
  writeFileSync(join(origin, 'file.txt'), 'one\n', 'utf8')
  git(['add', '.'], origin)
  git(['commit', '-m', 'initial'], origin)
  git(['tag', 'dsh-v0.2.1-rc.3'], origin)

  const slot = join(root, 'dsh-slots', 'a')
  mkdirSync(join(root, 'dsh-slots'), { recursive: true })
  git(['clone', origin, slot], root)
  git(['checkout', '--detach', 'dsh-v0.2.1-rc.3'], slot)

  writeFileSync(join(root, 'dsh-upgrade.json'), `${JSON.stringify({
    schema: 1,
    root,
    upstream: origin,
    tagPattern: 'dsh-v*',
  }, null, 2)}\n`, 'utf8')
  return { root, origin, slot }
}

test('task install --dry-run describes the wrapper and the registration', () => {
  const { root } = fixture()
  const dry = run(['task', 'install', '--dry-run', '--interval', '30', '--json'], root)
  assert.equal(dry.status, 0, dry.stderr)
  const report = JSON.parse(dry.stdout) as {
    ok: boolean, name: string, interval: number, wrapper: string, wrapperSource: string, registration: string
  }
  assert.equal(report.ok, true)
  assert.equal(report.name, 'DshUpstreamUpgrade')
  assert.equal(report.interval, 30)
  assert.equal(report.wrapper, join(root, 'bin', 'dsh-upgrade-task.vbs'))
  assert.match(report.wrapperSource, /task --run --config/)
  assert.ok(report.wrapperSource.includes(cliEntryPath()), 'the wrapper must run the CLI entry')
  assert.ok(!report.wrapperSource.includes('commands'), 'the wrapper must not run a command module')
  assert.match(report.registration, /New-TimeSpan -Minutes 30/)
  assert.match(report.registration, /LogonType Interactive/)
  assert.match(report.registration, /TaskName 'DshUpstreamUpgrade'/)
  assert.equal(existsSync(report.wrapper), false, 'a dry run writes nothing')

  const s4u = run(['task', 'install', '--dry-run', '--json', '--s4u', '--interval', '45'], root)
  assert.equal(s4u.status, 0, s4u.stderr)
  assert.match((JSON.parse(s4u.stdout) as { registration: string }).registration, /LogonType S4U/)
})

test('task install refuses an interval that would compete with a person', () => {
  const { root } = fixture()
  const tooOften = run(['task', 'install', '--interval', '2'], root)
  assert.equal(tooOften.status, 2)
  assert.match(tooOften.stderr, /at least 5 minutes/)
})

test('task status reports an unregistered task without failing', () => {
  const { root } = fixture()
  const status = run(['task', 'status', '--json', '--name', 'DshUpgradeAbsentForTest'], root)
  assert.equal(status.status, 0, status.stderr)
  const report = JSON.parse(status.stdout) as { ok: boolean, installed: boolean, name: string }
  assert.equal(report.ok, true)
  assert.equal(report.installed, false)
  assert.equal(report.name, 'DshUpgradeAbsentForTest')
})

test('task remove is idempotent and clears the wrapper', () => {
  const { root } = fixture()
  mkdirSync(join(root, 'bin'), { recursive: true })
  writeFileSync(join(root, 'bin', 'dsh-upgrade-task.vbs'), 'stale', 'utf8')
  const removed = run(['task', 'remove', '--json', '--name', 'DshUpgradeAbsentForTest'], root)
  assert.equal(removed.status, 0, removed.stderr)
  const report = JSON.parse(removed.stdout) as { ok: boolean, removed: boolean }
  assert.equal(report.ok, true)
  assert.equal(report.removed, false)
  assert.equal(existsSync(join(root, 'bin', 'dsh-upgrade-task.vbs')), false)
})

test('one watcher pass stages nothing when the deployed version is the newest', () => {
  const { root } = fixture()
  mkdirSync(join(root, 'state'), { recursive: true })
  writeFileSync(join(root, 'state', 'upgrade-state.json'), `${JSON.stringify({
    schema: 1,
    deployed: { tag: 'dsh-v0.2.1-rc.3', slot: 'a', at: new Date().toISOString() },
    staged: null,
    lastCheck: null,
    lastError: null,
    history: [],
  }, null, 2)}\n`, 'utf8')

  const pass = run(['task', 'run', '--json'], root)
  assert.equal(pass.status, 0, pass.stderr)
  const report = JSON.parse(pass.stdout) as { ok: boolean, action: string, current: string }
  assert.equal(report.ok, true)
  assert.equal(report.action, 'none')
  assert.equal(report.current, 'dsh-v0.2.1-rc.3')

  const log = readFileSync(join(root, 'logs', 'watch.log'), 'utf8')
  assert.match(log, /no newer version \(current dsh-v0\.2\.1-rc\.3\)/)
})

test('one watcher pass reports a stage that could not finish', () => {
  const { root, origin } = fixture()
  writeFileSync(join(origin, 'file.txt'), 'two\n', 'utf8')
  git(['add', '.'], origin)
  git(['commit', '-m', 'next'], origin)
  git(['tag', 'dsh-v0.2.1-rc.4'], origin)

  const fakePnpm = join(root, 'fake-pnpm.mjs')
  writeFileSync(fakePnpm, "console.error('fake pnpm: install refused'); process.exit(1)\n", 'utf8')
  const pass = run(['task', 'run', '--json'], root, { DSH_UPGRADE_PNPM_JS: fakePnpm })
  assert.equal(pass.status, 3, pass.stderr)
  const report = JSON.parse(pass.stdout) as { ok: boolean, action: string, tag: string, error: string }
  assert.equal(report.ok, false)
  assert.equal(report.action, 'failed')
  assert.equal(report.tag, 'dsh-v0.2.1-rc.4')
  assert.match(report.error, /pnpm install failed/)

  const log = readFileSync(join(root, 'logs', 'watch.log'), 'utf8')
  assert.match(log, /preparing dsh-v0\.2\.1-rc\.4/)
  assert.match(log, /stage failed: .*pnpm install failed/)
})

test('task without a configuration asks for init', () => {
  const empty = mkdtempSync(join(tmpdir(), 'dsh-upgrade-task-nocfg-'))
  const missing = run(['task', 'status'], empty)
  assert.equal(missing.status, 4)
  assert.match(missing.stderr, /run "dsh-upgrade init"/)
})

test('every desktop launcher runs the CLI entry', () => {
  const bin = join(tmpdir(), 'dsh-upgrade-launchers')
  for (const launcher of LAUNCHERS) {
    const files = launcherFiles(launcher, bin, cliEntryPath(), process.execPath)
    assert.ok(files.cmd.includes(cliEntryPath()), `${launcher.name}.cmd must run the CLI`)
    assert.ok(files.vbs.includes(cliEntryPath()), `${launcher.name}.vbs must run the CLI`)
    assert.ok(!files.cmd.includes('commands'), `${launcher.name}.cmd must not run a command module`)
    assert.equal(files.cmd.endsWith('\r\n'), true)
    assert.equal(files.vbs.startsWith('\uFEFF'), true, 'wscript needs the BOM to read Unicode paths')
  }
  const tray = LAUNCHERS.find(launcher => launcher.name === 'dsh-upgrade-tray')
  assert.equal(tray?.wait, false, 'the tray outlives its launcher')
})
