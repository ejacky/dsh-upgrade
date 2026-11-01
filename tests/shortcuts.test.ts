/**
 * Linux launchers: the `.desktop` entries `shortcuts --install` writes.
 *
 * The Windows wrappers are pinned in `tests/task.test.ts`; these are the POSIX half. Both matter
 * for the same reason: the shell does not run here, so a broken quoting rule would only be
 * noticed by a user whose path contains a space, a quote, or a `%`.
 *
 * @module dsh-upgrade/tests/shortcuts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { POSIX_LAUNCHERS, desktopEntry, type Launcher } from '../src/commands/power.ts'
import { skipUnlessPosix } from './helpers/platform.ts'

const repoRoot = join(import.meta.dirname, '..')
const cliPath = join(repoRoot, 'src', 'cli.ts')

/**
 * Run the CLI with isolated XDG directories.
 * @param args - CLI arguments.
 * @param cwd - fixture root.
 * @param env - extra environment.
 * @returns the exit code and captured streams.
 */
function run(args: readonly string[], cwd: string, env: Record<string, string> = {}): { status: number, stdout: string, stderr: string } {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(cwd, '.xdg-config'),
      XDG_DATA_HOME: join(cwd, '.xdg-data'),
      ...env,
    },
  })
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`)
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr }
}

/**
 * A scratch layout with a configuration.
 * @returns the fixture root.
 */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-upgrade-shortcuts-'))
  // No ports: `shortcuts` never binds one, and a made-up number would only look like the
  // free-port rule was followed.
  writeFileSync(join(root, 'dsh-upgrade.json'), `${JSON.stringify({ schema: 1, root }, null, 2)}\n`, 'utf8')
  return root
}

/** The first POSIX launcher, which every test needs. */
function firstLauncher(): Launcher {
  const launcher = POSIX_LAUNCHERS[0]
  if (launcher === undefined) assert.fail('there must be at least one POSIX launcher')
  return launcher
}

test('desktopEntry escapes what Exec and Path cannot carry', () => {
  const entry = desktopEntry(
    firstLauncher(),
    '/tmp/a"b`c$d%e/cli.ts',
    '/usr/bin/node %$',
    String.raw`/tmp/root with space\and %`,
  )
  assert.match(entry, /^\[Desktop Entry\]$/m)
  assert.match(entry, /^Type=Application$/m)
  assert.match(entry, /^Terminal=false$/m)
  assert.match(entry, /^Categories=Utility;$/m, 'a menu entry needs a category')

  const exec = /^Exec=(.*)$/m.exec(entry)?.[1] ?? ''
  assert.ok(exec.startsWith('"/usr/bin/node %%\\$"'), `the node path must be quoted and escaped: ${exec}`)
  assert.ok(exec.includes('\\"'), 'a double quote must be escaped inside Exec')
  assert.ok(exec.includes('\\`'), 'a backtick must be escaped inside Exec')
  assert.ok(exec.includes('\\$'), 'a dollar must be escaped inside Exec (reserved inside quotes)')
  assert.ok(exec.includes('%%'), 'a percent must be doubled inside Exec (it is a field code)')
  assert.ok(exec.includes('"toggle" "--yes"'), 'the command must be passed as separate arguments')

  // Path is a string value: no quotes (they would become part of the path), `%` is literal, and
  // a backslash must be doubled.
  const path = /^Path=(.*)$/m.exec(entry)?.[1] ?? ''
  assert.equal(path, String.raw`/tmp/root with space\\and %`)
})

test('shortcuts --install writes, repeats, and removes the POSIX launchers', (context) => {
  if (skipUnlessPosix(context)) return
  const root = fixture()
  const installed = run(['shortcuts', '--install', '--json'], root)
  assert.equal(installed.status, 0, installed.stderr)
  const report = JSON.parse(installed.stdout) as { ok: boolean, launchers: string[] }
  assert.equal(report.ok, true)
  assert.equal(report.launchers.length, POSIX_LAUNCHERS.length)
  assert.equal(report.launchers.some(path => path.includes('tray')), false, 'no tray entry on Linux')

  for (const path of report.launchers) {
    assert.ok(existsSync(path), `expected ${path}`)
    const text = readFileSync(path, 'utf8')
    assert.match(text, /^\[Desktop Entry\]$/m)
    assert.match(text, /^Exec=.*"(toggle|apply)" "--(yes|wait)"$/m)
    assert.match(text, /^Path=/m)
    assert.match(text, /^Terminal=false$/m)
    assert.ok(!text.includes('dsh-upgrade-tray'))
  }

  // Installing twice must not duplicate or break an entry.
  assert.equal(run(['shortcuts', '--install', '--json'], root).status, 0)
  assert.equal(JSON.parse(run(['shortcuts', '--install', '--json'], root).stdout).launchers.length, POSIX_LAUNCHERS.length)

  const removed = run(['shortcuts', '--remove', '--json'], root)
  assert.equal(removed.status, 0, removed.stderr)
  const removal = JSON.parse(removed.stdout) as { ok: boolean, removed: boolean }
  assert.equal(removal.ok, true)
  assert.equal(removal.removed, true)
  for (const path of report.launchers) assert.equal(existsSync(path), false)

  const again = run(['shortcuts', '--remove', '--json'], root)
  assert.equal(again.status, 0)
  assert.equal((JSON.parse(again.stdout) as { removed: boolean }).removed, false, 'removing twice is idempotent')
})
