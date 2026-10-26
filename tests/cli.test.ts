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
import { readFileSync } from 'node:fs'
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

test('--help lists every v1 command and marks the stubs', () => {
  const { status, stdout } = run(['--help'])
  assert.equal(status, 0)
  for (const command of [
    'init', 'status', 'check', 'stage', 'apply', 'rollback', 'toggle', 'start', 'stop',
    'doctor', 'opencode-session', 'patch', 'shortcuts', 'tray', 'task', 'log', 'version',
  ]) {
    assert.match(stdout, new RegExp(`^  ${command}\\b`, 'm'), `help must list ${command}`)
  }
  assert.match(stdout, /not implemented yet/)
})

test('an unknown command is a usage error', () => {
  const { status, stderr } = run(['definitely-not-a-command'])
  assert.equal(status, 2)
  assert.match(stderr, /unknown command "definitely-not-a-command"/)
  assert.match(stderr, /--help/)
})

test('a stub command exits with the unimplemented code', () => {
  const { status, stderr } = run(['apply'])
  assert.equal(status, 5)
  assert.match(stderr, /command "apply" is not implemented yet/)
})

test('`help <command>` prints one command without failing', () => {
  const { status, stdout } = run(['help', 'apply'])
  assert.equal(status, 0)
  assert.match(stdout, /^apply — switch to the staged version/m)
})

test('`help <unknown>` is a usage error', () => {
  const { status, stderr } = run(['help', 'nope'])
  assert.equal(status, 2)
  assert.match(stderr, /unknown command "nope"/)
})

test('the version subcommand matches the flag form', () => {
  assert.equal(run(['version']).stdout, run(['--version']).stdout)
})


