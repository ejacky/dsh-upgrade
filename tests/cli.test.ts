/**
 * Contract tests for the `dsh-upgrade` command surface.
 *
 * These spawn the real entry point so the exit-code contract, the help text, and the
 * stubbed commands are pinned before the engine lands. They assert behaviour a script
 * or the tray companion depends on, not internal structure.
 *
 * @module dsh-upgrade/tests/cli
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repoRoot = join(import.meta.dirname, '..')
const cliPath = join(repoRoot, 'src', 'cli.ts')

/** Run the CLI and capture its streams and exit code. */
function run(args: readonly string[]): { status: number, stdout: string, stderr: string } {
  const result = spawnSync(process.execPath, [cliPath, ...args], { cwd: repoRoot, encoding: 'utf8' })
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`)
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr }
}

test('--version prints the name and the version from version.json', () => {
  const { status, stdout } = run(['--version'])
  const meta = JSON.parse(readFileSync(join(repoRoot, 'version.json'), 'utf8')) as { name: string, version: string }
  assert.equal(status, 0)
  assert.equal(stdout.trim(), `${meta.name} ${meta.version}`)
})

test('--version --json emits the metadata object', () => {
  const { status, stdout } = run(['--version', '--json'])
  assert.equal(status, 0)
  const parsed = JSON.parse(stdout) as Record<string, unknown>
  assert.equal(typeof parsed['name'], 'string')
  assert.equal(typeof parsed['version'], 'string')
  assert.equal(typeof parsed['schema'], 'number')
})

test('--help lists every v1 command, and none of them is a stub', () => {
  const { status, stdout } = run(['--help'])
  assert.equal(status, 0)
  for (const command of [
    'init', 'status', 'check', 'stage', 'apply', 'rollback', 'toggle', 'start', 'stop',
    'doctor', 'patch', 'shortcuts', 'tray', 'task', 'log', 'version',
  ]) {
    assert.match(stdout, new RegExp(`^  ${command}\\b`, 'm'), `help must list ${command}`)
  }
  assert.doesNotMatch(stdout, /\(not implemented yet\)/)
})

test('an unknown command is a usage error', () => {
  const { status, stderr } = run(['definitely-not-a-command'])
  assert.equal(status, 2)
  assert.match(stderr, /unknown command "definitely-not-a-command"/)
  assert.match(stderr, /--help/)
})

test('every documented command runs its implementation, not a stub', () => {
  // `log` needs a configuration and fails with the probe code; what matters here is that the
  // command is dispatched instead of refusing as unimplemented.
  const dir = mkdtempSync(join(tmpdir(), 'dsh-upgrade-dispatch-'))
  // An explicit missing configuration: a file beside the tool (or in the checkout root) must
  // never decide what this test sees.
  const absent = join(dir, 'absent.json')
  const { status, stderr } = spawnSync(process.execPath, [cliPath, 'log', '--config', absent], { cwd: dir, encoding: 'utf8' }) as unknown as { status: number, stderr: string }
  assert.equal(status, 4)
  assert.doesNotMatch(stderr, /not implemented yet/)
  assert.match(stderr, /run "dsh-upgrade init"/)
})

test('`help <command>` prints one command without failing', () => {
  const { status, stdout } = run(['help', 'apply'])
  assert.equal(status, 0)
  assert.match(stdout, /^apply .*switch to the staged version/m)
})

test('`help <unknown>` is a usage error', () => {
  const { status, stderr } = run(['help', 'nope'])
  assert.equal(status, 2)
  assert.match(stderr, /unknown command "nope"/)
})

test('the version subcommand matches the flag form', () => {
  assert.equal(run(['version']).stdout, run(['--version']).stdout)
})

test('the retired plugin command is gone', () => {
  const { status, stderr } = run(['opencode-session'])
  assert.equal(status, 2)
  assert.match(stderr, /unknown command "opencode-session"/)
})


test('a global flag without its value is a usage error, not a crash', () => {
  const { status, stderr } = run(['--config'])
  assert.equal(status, 2)
  assert.match(stderr, /--config needs a path/)
  assert.ok(!stderr.includes('at '), 'no stack trace on a usage error')
})

test('check on an uninitialized layout exits with the probe code and no stack', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-upgrade-noinit-'))
  const result = spawnSync(process.execPath, [cliPath, 'check', '--json', '--config', join(dir, 'absent.json')], { cwd: dir, encoding: 'utf8' })
  const status = result.status
  const stderr = result.stderr
  assert.equal(status, 4)
  assert.match(stderr, /run "dsh-upgrade init"/)
  assert.ok(!stderr.includes('at '), 'no stack trace before init')
})

