/**
 * `task` on Linux: the systemd units, an uninstalled timer, and the failures that must be loud.
 *
 * Nothing here reaches the real systemd: `--dry-run` renders the units, `status` answers "not
 * installed" from the filesystem before it would ask systemd, and the failure path uses a
 * stand-in `systemctl` on `PATH`. That keeps the suite offline and keeps a CI runner without a
 * user session from turning into a false failure.
 *
 * @module dsh-upgrade/tests/task-linux
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cliEntryPath } from '../src/engine/entry.ts'
import { skipUnlessPosix } from './helpers/platform.ts'

const repoRoot = join(import.meta.dirname, '..')
const cliPath = join(repoRoot, 'src', 'cli.ts')

/**
 * Run the CLI with an isolated unit directory.
 * @param args - CLI arguments.
 * @param cwd - working directory, also the fixture root.
 * @param env - extra environment variables.
 * @returns the exit code and captured streams.
 */
function run(args: readonly string[], cwd: string, env: Record<string, string> = {}): { status: number, stdout: string, stderr: string } {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, XDG_CONFIG_HOME: join(cwd, '.xdg-config'), ...env },
  })
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`)
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr }
}

/**
 * A scratch layout with a configuration and no slots.
 * @returns the fixture root.
 */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-upgrade-task-linux-'))
  // No ports: none of the commands under test bind one, and a made-up number would only
  // look like the free-port rule was followed.
  writeFileSync(join(root, 'dsh-upgrade.json'), `${JSON.stringify({ schema: 1, root }, null, 2)}\n`, 'utf8')
  return root
}

test('task install --dry-run describes the systemd units and writes nothing', (context) => {
  if (skipUnlessPosix(context)) return
  const root = fixture()
  const dry = run(['task', 'install', '--dry-run', '--interval', '30', '--json'], root)
  assert.equal(dry.status, 0, dry.stderr)
  const report = JSON.parse(dry.stdout) as {
    ok: boolean
    name: string
    unit: string
    interval: number
    serviceUnitText: string
    timerUnitText: string
    registration: string
  }
  assert.equal(report.ok, true)
  assert.equal(report.name, 'DshUpstreamUpgrade')
  assert.equal(report.interval, 30)
  assert.equal(
    report.unit,
    join(root, '.xdg-config', 'systemd', 'user', 'DshUpstreamUpgrade.timer'),
    'the unit path must come from XDG_CONFIG_HOME, never the real home',
  )
  // A path directive takes the line verbatim: quotes here make systemd reject the unit.
  assert.ok(
    report.serviceUnitText.includes(`WorkingDirectory=${root}\n`),
    'WorkingDirectory must be an unquoted absolute path',
  )
  assert.match(report.serviceUnitText, /Type=oneshot/)
  assert.ok(report.serviceUnitText.includes(cliEntryPath()), 'the unit must run the CLI entry')
  assert.match(report.serviceUnitText, /--run/)
  assert.match(report.timerUnitText, /OnUnitActiveSec=30min/)
  assert.match(report.timerUnitText, /Unit=DshUpstreamUpgrade\.service/)
  assert.match(report.timerUnitText, /WantedBy=timers\.target/)
  assert.match(report.registration, /systemctl --user enable --now DshUpstreamUpgrade\.timer/)
  assert.equal(existsSync(join(root, '.xdg-config', 'systemd', 'user')), false, 'a dry run writes nothing')
})

test('task status reports an uninstalled timer without asking systemd', (context) => {
  if (skipUnlessPosix(context)) return
  const root = fixture()
  const bin = join(root, 'fake-bin')
  const marker = join(root, 'systemctl-was-called')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'systemctl'), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, 'utf8')
  chmodSync(join(bin, 'systemctl'), 0o755)
  const status = run(['task', 'status', '--json', '--name', 'DshUpgradeAbsentForTest'], root, {
    PATH: `${bin}:${process.env['PATH'] ?? ''}`,
  })
  assert.equal(existsSync(marker), false, 'an absent timer must be answered from the filesystem')
  assert.equal(status.status, 0, status.stderr)
  const report = JSON.parse(status.stdout) as { ok: boolean, name: string, installed: boolean, unit: string }
  assert.equal(report.ok, true)
  assert.equal(report.installed, false)
  assert.equal(
    report.unit,
    join(root, '.xdg-config', 'systemd', 'user', 'DshUpgradeAbsentForTest.timer'),
  )
})

test('task install reports a systemd session it cannot use and leaves no units behind', (context) => {
  if (skipUnlessPosix(context)) return
  const root = fixture()
  const bin = join(root, 'fake-bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'systemctl'), '#!/bin/sh\nexit 1\n', 'utf8')
  chmodSync(join(bin, 'systemctl'), 0o755)
  const failed = run(['task', 'install', '--json'], root, { PATH: `${bin}:${process.env['PATH'] ?? ''}` })
  assert.equal(failed.status, 3, failed.stderr)
  const report = JSON.parse(failed.stdout) as { ok: boolean, error: string, nextAction: string }
  assert.equal(report.ok, false)
  assert.match(report.error, /could not reload the user units/)
  assert.match(report.error, /--dry-run/, 'the failure must say where the units can be seen')
  assert.equal(report.nextAction, 'human')
  const units = join(root, '.xdg-config', 'systemd', 'user')
  assert.equal(existsSync(join(units, 'DshUpstreamUpgrade.service')), false, 'a failed install must not leave a service unit')
  assert.equal(existsSync(join(units, 'DshUpstreamUpgrade.timer')), false, 'a failed install must not leave a timer unit')
})

test('task install rejects --s4u, which only Task Scheduler has', (context) => {
  if (skipUnlessPosix(context)) return
  const root = fixture()
  const refused = run(['task', 'install', '--s4u'], root)
  assert.equal(refused.status, 2)
  assert.match(refused.stderr, /--s4u is Windows-only/)
})

test('task rejects a name systemd would read as an option', (context) => {
  if (skipUnlessPosix(context)) return
  const root = fixture()
  const refused = run(['task', 'status', '--name', '--now', '--json'], root)
  assert.equal(refused.status, 2)
  const report = JSON.parse(refused.stdout) as { ok: boolean, error: string }
  assert.equal(report.ok, false)
  assert.match(report.error, /not a valid systemd unit name/)
})

test('task install --dry-run doubles a dollar sign in a unit', (context) => {
  if (skipUnlessPosix(context)) return
  const root = mkdtempSync(join(tmpdir(), 'dsh-upgrade-task-dollar-$%-'))
  writeFileSync(join(root, 'dsh-upgrade.json'), `${JSON.stringify({ schema: 1, root }, null, 2)}\n`, 'utf8')
  const dry = run(['task', 'install', '--dry-run', '--json'], root)
  assert.equal(dry.status, 0, dry.stderr)
  const report = JSON.parse(dry.stdout) as { serviceUnitText: string }
  assert.ok(report.serviceUnitText.includes('$$'), 'systemd expands $VAR in ExecStart; a literal dollar must be doubled')
  // The ExecStart config path alone would satisfy a bare `%%` check; the path directive is what
  // proves unitPathValue doubles specifiers.
  assert.ok(
    report.serviceUnitText.includes(`WorkingDirectory=${root.replaceAll('%', '%%')}\n`),
    'a percent in the working directory must be doubled there too',
  )
})

test('task status maps the systemd fields onto the documented JSON', (context) => {
  if (skipUnlessPosix(context)) return
  const root = fixture()
  const units = join(root, '.xdg-config', 'systemd', 'user')
  mkdirSync(units, { recursive: true })
  writeFileSync(join(units, 'DshUpstreamUpgrade.service'), '[Service]\nType=oneshot\n', 'utf8')
  writeFileSync(join(units, 'DshUpstreamUpgrade.timer'), '[Timer]\nOnUnitActiveSec=30min\n', 'utf8')
  const bin = join(root, 'fake-bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'systemctl'), [
    '#!/bin/sh',
    'case "$*" in',
    "  *list-timers*) echo '[{\"unit\":\"DshUpstreamUpgrade.timer\",\"last\":1700000000000000,\"next\":1700003600000000}]' ;;",
    "  *\".service\"*) echo 'Result=success'; echo 'ExecMainStatus=3' ;;",
    "  *\".timer\"*) echo 'ActiveState=active'; echo 'SubState=running'; echo 'UnitFileState=enabled'; echo 'LoadState=loaded' ;;",
    'esac',
    'exit 0',
    '',
  ].join('\n'), 'utf8')
  chmodSync(join(bin, 'systemctl'), 0o755)

  const status = run(['task', 'status', '--json'], root, { PATH: `${bin}:${process.env['PATH'] ?? ''}` })
  assert.equal(status.status, 0, status.stderr)
  const report = JSON.parse(status.stdout) as {
    ok: boolean
    installed: boolean
    unit: string
    state: string
    subState: string
    lastRun: string
    lastResult: number
    nextRun: string
    logonType: string
    intervalMinutes: number
  }
  assert.equal(report.ok, true)
  assert.equal(report.installed, true)
  assert.equal(report.unit, join(units, 'DshUpstreamUpgrade.timer'))
  assert.equal(report.state, 'active')
  assert.equal(report.subState, 'running')
  assert.equal(report.lastRun, new Date(1_700_000_000_000).toISOString())
  assert.equal(report.nextRun, new Date(1_700_003_600_000).toISOString())
  assert.equal(report.lastResult, 3, 'the service exit status must reach the report')
  assert.equal(report.logonType, 'systemd-user')
  assert.equal(report.intervalMinutes, 30)
})
